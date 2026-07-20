import {
  listRemoteDir,
  statRemotePath,
  type RemoteDirEntry,
  type RemoteStat,
} from './ssh/remote-fs';
import { shQuote, type RemoteTransport } from './ssh/remote-transport';
import type { ExecOptions, ExecResult, ExecutionTarget } from './target';

function assertOk(result: ExecResult, description: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `SshExecutionTarget: ${description} failed (exit ${result.exitCode}): ${result.stderr.trim() || '(no stderr)'}`,
    );
  }
}

/**
 * The `ssh:` implementation of {@link ExecutionTarget} (issue #69): expresses
 * every operation as a `RemoteTransport.exec()` shell command, quoting every
 * path/argument via {@link shQuote} (`./ssh/remote-transport.ts`) — the same
 * quoting discipline `RemoteProcessRunner` already uses. Takes an existing
 * `RemoteTransport` rather than owning a connection itself, so `NodeDaemon`
 * can hand it the same pooled, reconnecting transport it already maintains
 * for that `ssh:` target (`SshTransportPool`) instead of opening a second
 * one.
 */
export class SshExecutionTarget implements ExecutionTarget {
  readonly kind = 'ssh' as const;

  constructor(private readonly transport: RemoteTransport) {}

  async exec(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
    const commandLine = [command, ...args].map(shQuote).join(' ');
    const line = options.cwd ? `cd ${shQuote(options.cwd)} && ${commandLine}` : commandLine;
    return this.transport.exec(line, { input: options.input });
  }

  async readFile(path: string): Promise<string> {
    const result = await this.transport.exec(`cat ${shQuote(path)}`);
    assertOk(result, `readFile ${path}`);
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const result = await this.transport.exec(`cat > ${shQuote(path)}`, { input: content });
    assertOk(result, `writeFile ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    const result = await this.transport.exec(`mkdir -p ${shQuote(path)}`);
    assertOk(result, `mkdir ${path}`);
  }

  async readdir(path: string): Promise<string[]> {
    const result = await this.transport.exec(`ls -1A ${shQuote(path)}`);
    assertOk(result, `readdir ${path}`);
    return result.stdout.split('\n').filter((entry) => entry.length > 0);
  }

  /**
   * Richer remote directory browsing (issue #74): every entry's type/size/
   * mtime, not just its name — what a file-tree/editor UI actually needs,
   * beyond {@link readdir}'s narrower name-only listing (kept as-is since
   * it's also `ExecutionTarget`'s shared, `local`-target-parity contract).
   * Throws {@link RemoteFsError} (`./ssh/remote-fs.ts`) rather than a generic
   * error for a missing/permission-denied/not-a-directory path.
   */
  async readdirDetailed(path: string): Promise<RemoteDirEntry[]> {
    return listRemoteDir(this.transport, path);
  }

  /** Stats a single remote path (issue #74). Throws {@link RemoteFsError} for a missing/permission-denied path, same as {@link readdirDetailed}. */
  async stat(path: string): Promise<RemoteStat> {
    return statRemotePath(this.transport, path);
  }
}
