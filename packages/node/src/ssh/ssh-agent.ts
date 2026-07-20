import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** One identity loaded into a running ssh-agent, as reported by `ssh-add -l`. */
export interface SshAgentIdentity {
  bits: number;
  fingerprint: string;
  comment: string;
  type: string;
}

export interface ListIdentitiesResult {
  stdout: string;
  exitCode: number;
}

export interface DetectSshAgentOptions {
  /** Overrides `process.env` (only `SSH_AUTH_SOCK` is read); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Runs the equivalent of `ssh-add -l` and reports its stdout + exit code; injectable so tests never shell out to a real agent. Defaults to actually invoking `ssh-add -l`. */
  listIdentities?: () => Promise<ListIdentitiesResult>;
}

export interface DetectSshAgentResult {
  /** Whether `$SSH_AUTH_SOCK` names a running agent to talk to at all — independent of whether it turned out to have any identities loaded. */
  available: boolean;
  socketPath?: string;
  identities: SshAgentIdentity[];
}

const execFileAsync = promisify(execFile);

async function realListIdentities(): Promise<ListIdentitiesResult> {
  try {
    const { stdout } = await execFileAsync('ssh-add', ['-l']);
    return { stdout, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; code?: number };
    return { stdout: err.stdout ?? '', exitCode: typeof err.code === 'number' ? err.code : 1 };
  }
}

// `ssh-add -l` prints one line per identity: "<bits> <fingerprint> <comment> (<type>)".
const IDENTITY_LINE = /^(\d+)\s+(\S+)\s+(.+?)\s+\(([^)]+)\)\s*$/;

function parseIdentities(stdout: string): SshAgentIdentity[] {
  const identities: SshAgentIdentity[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = IDENTITY_LINE.exec(line);
    if (!match) continue; // an unparseable line is skipped, not fatal
    const [, bits, fingerprint, comment, type] = match;
    identities.push({
      bits: Number(bits),
      fingerprint: fingerprint!,
      comment: comment!,
      type: type!,
    });
  }
  return identities;
}

/**
 * Detects an available ssh-agent and its loaded identities (issue #83, SPEC
 * §7.23 step 1: "picks up your keys and ssh-agent"), surfacing them as usable
 * auth options for the add-target flow. Detection is `$SSH_AUTH_SOCK`
 * (matching `Ssh2Transport`'s own agent-auth autodetection); enumeration is
 * `ssh-add -l`.
 *
 * Never throws: no socket, an empty agent (`ssh-add -l`'s own exit 1 for "The
 * agent has no identities."), or `ssh-add` itself being missing/erroring all
 * resolve to a normal result rather than a rejected promise — the add-target
 * flow's "falls back to manual entry when nothing is discoverable" needs a
 * value to branch on, not a caught exception.
 */
export async function detectSshAgent(
  options: DetectSshAgentOptions = {},
): Promise<DetectSshAgentResult> {
  const env = options.env ?? process.env;
  const socketPath = env.SSH_AUTH_SOCK;
  if (!socketPath) {
    return { available: false, socketPath: undefined, identities: [] };
  }

  const listIdentities = options.listIdentities ?? realListIdentities;
  try {
    const { stdout, exitCode } = await listIdentities();
    if (exitCode !== 0) {
      return { available: true, socketPath, identities: [] };
    }
    return { available: true, socketPath, identities: parseIdentities(stdout) };
  } catch {
    return { available: true, socketPath, identities: [] };
  }
}
