import { shQuote, type RemoteTransport } from './remote-transport';

/**
 * Remote filesystem browsing over an existing `RemoteTransport` (issue #74):
 * directory listing and stat, each entry carrying name/type/size/mtime, so
 * the file-tree/editor and the supervisor can browse a remote host the same
 * way `SshExecutionTarget`'s narrower `readdir()` (names only, SPEC §5.2's
 * "remote worktree/filesystem operations") lets them read/write it. Built on
 * `stat -c` rather than `ls -l` parsing: both GNU coreutils (a typical Debian/
 * Ubuntu remote target) and BusyBox (this package's Alpine-based Docker test
 * fixture, `./docker-sshd-fixture.ts`) implement the same `-c FORMAT` flag
 * with the same directive letters, so one command line works unmodified
 * against either — verified directly against both in this package's tests.
 */

export type RemoteEntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface RemoteStat {
  type: RemoteEntryType;
  /** Bytes, as reported by `stat`'s `%s`. */
  size: number;
  /** Milliseconds since epoch, as reported by `stat`'s `%Y` (whole seconds) scaled up. */
  mtimeMs: number;
}

export interface RemoteDirEntry extends RemoteStat {
  /** The entry's bare name within the listed directory (not a full path), mirroring `ExecutionTarget.readdir`'s convention. */
  name: string;
}

export type RemoteFsErrorCode = 'ENOENT' | 'EACCES' | 'ENOTDIR' | 'UNKNOWN';

/**
 * A typed remote filesystem failure (issue #74's "permission-denied and
 * missing-path errors surface as typed errors, not generic failures"): `code`
 * is derived from the remote `stat`'s stderr text, which is `strerror(3)`
 * output — POSIX-standardized wording every C library (glibc on a typical
 * remote, musl/BusyBox on this package's Docker test fixture) produces
 * identically, so this classification is not GNU-vs-BusyBox-fragile.
 */
export class RemoteFsError extends Error {
  constructor(
    readonly code: RemoteFsErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteFsError';
  }
}

function mapType(rawType: string): RemoteEntryType {
  const type = rawType.trim();
  if (type.includes('directory')) return 'dir';
  if (type.includes('symbolic link')) return 'symlink';
  if (type.includes('regular')) return 'file';
  return 'other';
}

function classifyStatFailure(stderr: string, path: string): RemoteFsError {
  if (/no such file or directory/i.test(stderr)) {
    return new RemoteFsError('ENOENT', path, `remote path not found: ${path}`);
  }
  if (/permission denied/i.test(stderr)) {
    return new RemoteFsError('EACCES', path, `permission denied: ${path}`);
  }
  return new RemoteFsError(
    'UNKNOWN',
    path,
    stderr.trim() || `stat failed for remote path: ${path}`,
  );
}

function parseStatFields(fields: string): { type: RemoteEntryType; size: number; mtimeMs: number } {
  const [rawType, rawSize, rawMtime] = fields.split('\t');
  return {
    type: mapType(rawType ?? ''),
    size: Number(rawSize),
    mtimeMs: Number(rawMtime) * 1000,
  };
}

const STAT_FORMAT = '%F\t%s\t%Y';

/** Stats one remote path. Throws {@link RemoteFsError} (`ENOENT`/`EACCES`/`UNKNOWN`) rather than a generic error when the remote `stat` fails. */
export async function statRemotePath(
  transport: RemoteTransport,
  path: string,
): Promise<RemoteStat> {
  const result = await transport.exec(`stat -c '${STAT_FORMAT}' -- ${shQuote(path)}`);
  if (result.exitCode !== 0) {
    throw classifyStatFailure(result.stderr, path);
  }
  return parseStatFields(result.stdout.trim());
}

/**
 * Lists `path`'s entries with type/size/mtime (issue #74's "listing a remote
 * directory returns its entries (name, type, size, mtime)"). Confirms `path`
 * exists and is a directory first (via {@link statRemotePath}'s same typed
 * errors) before running the listing script, so a missing/permission-denied/
 * not-a-directory path fails with the right {@link RemoteFsErrorCode} instead
 * of an empty or confusingly-shaped result.
 */
export async function listRemoteDir(
  transport: RemoteTransport,
  path: string,
): Promise<RemoteDirEntry[]> {
  const rootStat = await statRemotePath(transport, path);
  if (rootStat.type !== 'dir') {
    throw new RemoteFsError('ENOTDIR', path, `remote path is not a directory: ${path}`);
  }

  // Portable "list every entry including dotfiles, skip . and ..", verified
  // against both bash and BusyBox ash: `.* ` matches dotfiles (incl. `.`/`..`,
  // filtered by the `case`), `*` matches everything else — no double-count,
  // since a POSIX shell's bare `*` never matches a leading dot. An
  // all-literal, no-match glob (an empty directory) leaves `$f` as the
  // literal pattern text, which `[ -e ]`/`[ -L ]` both then reject.
  const script = [
    `cd ${shQuote(path)} || exit 1`,
    'for f in .* *; do',
    '  case "$f" in .|..) continue;; esac',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    `  stat -c '%n\t${STAT_FORMAT}' -- "$f" 2>/dev/null`,
    'done',
  ].join('\n');

  const result = await transport.exec(script);
  if (result.exitCode !== 0) {
    throw new RemoteFsError(
      'UNKNOWN',
      path,
      result.stderr.trim() || `readdir failed for remote path: ${path}`,
    );
  }

  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, ...rest] = line.split('\t');
      return { name: name ?? '', ...parseStatFields(rest.join('\t')) };
    });
}
