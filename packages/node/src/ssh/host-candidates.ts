import { detectSshAgent, type DetectSshAgentOptions, type DetectSshAgentResult } from './ssh-agent';
import { loadSshConfig } from './ssh-config';

/** One selectable candidate for the `ssh:` add-target flow's "just choose a host" step (issue #83, SPEC §7.23 step 1), autodetected from `~/.ssh/config`. */
export interface SshHostCandidate {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFiles: string[];
}

export interface DiscoverSshTargetsOptions {
  /** `~/.ssh/config`'s path; defaults to `<homeDir>/.ssh/config`. */
  configPath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  listIdentities?: DetectSshAgentOptions['listIdentities'];
}

export interface SshTargetDiscovery {
  candidates: SshHostCandidate[];
  agent: DetectSshAgentResult;
  /** `true` when there is nothing to offer at all (`candidates` is empty) — the trigger for the add-target flow's "falls back to manual entry when nothing is discoverable" (issue #83's acceptance criterion). Agent identities alone don't clear this: they're a usable auth *option* for a host, not a host to connect to. */
  requiresManualEntry: boolean;
}

/**
 * Runs `~/.ssh/config` autodetection (`loadSshConfig`) and ssh-agent
 * detection (`detectSshAgent`) together and shapes the result for the
 * add-target flow: a flat, ready-to-render candidate list plus the agent's
 * own availability/identities (a usable default auth option once a host is
 * picked, independent of which host).
 */
export async function discoverSshTargets(
  options: DiscoverSshTargetsOptions = {},
): Promise<SshTargetDiscovery> {
  const [configEntries, agent] = await Promise.all([
    loadSshConfig(options.configPath, options.homeDir ? { homeDir: options.homeDir } : {}),
    detectSshAgent({ env: options.env, listIdentities: options.listIdentities }),
  ]);

  const candidates: SshHostCandidate[] = configEntries.map((entry) => ({
    alias: entry.alias,
    // Real ssh defaults an unset HostName to the alias itself (the name
    // given on the command line) — mirrored here rather than treating a
    // HostName-less entry as unusable.
    hostName: entry.hostName ?? entry.alias,
    user: entry.user,
    port: entry.port,
    identityFiles: entry.identityFiles,
  }));

  return { candidates, agent, requiresManualEntry: candidates.length === 0 };
}
