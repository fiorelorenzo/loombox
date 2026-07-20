import { spawn as nodeSpawn } from 'node:child_process';

/**
 * `pg_dump`/`pg_restore` process orchestration for relay backup/DR (#103).
 * Deliberately shells out to the real Postgres client binaries rather than
 * reimplementing dump/restore over the `pg` driver (see AGENTS.md's "DEPS:
 * minimize" — `pg_dump --format=custom` is Postgres's own binary,
 * dependency-aware, restorable-in-any-order dump format; nothing in
 * `node-postgres` reproduces that, and reinventing it would be exactly the
 * kind of novel-when-it-shouldn't-be mechanism SPEC §16 says to avoid).
 *
 * `command` on both entry points defaults to the bare binary (`pg_dump`/
 * `pg_restore` on `PATH`), which is what the relay's own Docker image
 * provides (see `Dockerfile`, which installs a matching `postgresql-client-16`
 * so the dump tool's major version never trails the `postgres:16-alpine`
 * server it talks to — a newer client can dump an older server, but not the
 * reverse). It's overridable (`backup-cli.ts`'s `RELAY_PG_DUMP_CMD`/
 * `RELAY_PG_RESTORE_CMD`) so an operator without a matching local client can
 * point at a wrapper instead — e.g. `docker run --rm --network host
 * postgres:16-alpine pg_dump` — which is also how this package's own
 * live-Postgres integration test (`backup-restore.integration.test.ts`)
 * exercises the real binaries without needing them installed on the test
 * runner's `PATH`.
 */

type SpawnFn = typeof nodeSpawn;

/** Splits a `command` array into `[binary, ...prefixArgs]`, defaulting to the bare binary name. */
function splitCommand(command: string[] | undefined, defaultBinary: string): [string, string[]] {
  const parts = command && command.length > 0 ? command : [defaultBinary];
  const [bin, ...rest] = parts;
  return [bin, rest];
}

/** Runs a process, collects its stdout into a `Buffer`, and rejects (with stderr in the message) on a non-zero exit. */
function runCapture(bin: string, args: string[], spawnFn: SpawnFn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(
          new Error(
            `${bin} exited with code ${String(code)}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
      }
    });
  });
}

/** Runs a process, feeding `input` on stdin, and rejects (with stderr in the message) on a non-zero exit. */
function runFeed(bin: string, args: string[], input: Buffer, spawnFn: SpawnFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stdout?.on('data', () => {
      // pg_restore's stdout is typically empty/uninteresting; drain it so a
      // full pipe buffer can never stall the process.
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${bin} exited with code ${String(code)}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
      }
    });
    child.stdin?.end(input);
  });
}

export interface PgDumpOptions {
  /** The database to dump (a full `postgresql://` connection string). */
  databaseUrl: string;
  /**
   * Overrides the dump command; the array's last element must be (or
   * resolve to) `pg_dump`. Default: `['pg_dump']`.
   */
  command?: string[];
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. */
  spawnFn?: SpawnFn;
}

/**
 * Runs `pg_dump --format=custom` against `databaseUrl` and returns the raw
 * dump bytes. Custom format (not plain SQL) because it's compressed,
 * restorable with `pg_restore --clean --if-exists` regardless of object
 * dependency order, and the same format `pg_restore` below expects.
 * `--no-owner --no-privileges` so a restore never fails on a role that
 * doesn't exist in the target cluster (the restore path may target a fresh
 * scratch database with a different superuser than prod).
 */
export async function runPgDump(opts: PgDumpOptions): Promise<Buffer> {
  const [bin, prefixArgs] = splitCommand(opts.command, 'pg_dump');
  const args = [
    ...prefixArgs,
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    `--dbname=${opts.databaseUrl}`,
  ];
  return runCapture(bin, args, opts.spawnFn ?? nodeSpawn);
}

export interface PgRestoreOptions {
  /** The database to restore into (a full `postgresql://` connection string). Must already exist. */
  databaseUrl: string;
  /** The decrypted `pg_dump --format=custom` bytes to restore. */
  dump: Buffer;
  /**
   * Overrides the restore command; the array's last element must be (or
   * resolve to) `pg_restore`. Default: `['pg_restore']`.
   */
  command?: string[];
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. */
  spawnFn?: SpawnFn;
}

/**
 * Runs `pg_restore` against `databaseUrl`, feeding `dump` on stdin.
 * `--clean --if-exists` drops existing objects before recreating them (so
 * restoring twice into the same database is idempotent) without erroring
 * when the target is empty (a fresh scratch database on first restore).
 */
export async function runPgRestore(opts: PgRestoreOptions): Promise<void> {
  const [bin, prefixArgs] = splitCommand(opts.command, 'pg_restore');
  const args = [
    ...prefixArgs,
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    `--dbname=${opts.databaseUrl}`,
  ];
  await runFeed(bin, args, opts.dump, opts.spawnFn ?? nodeSpawn);
}

/** Filename prefix/suffix `backup-cli.ts` writes and `selectFilesToPrune` recognizes; also gates which files in `RELAY_BACKUP_DIR` retention ever touches. */
const FILENAME_PREFIX = 'relay-backup-';
const FILENAME_SUFFIX = '.dump.enc';

/**
 * Builds a timestamped, lexicographically-sortable backup filename (ISO
 * timestamp with `:` replaced by `-`, since `:` is awkward in filenames on
 * some filesystems). Sortable-by-name is what lets {@link selectFilesToPrune}
 * determine age by a plain string sort, no filesystem mtime needed.
 */
export function backupFilename(date: Date): string {
  const iso = date.toISOString().replace(/[:.]/g, '-');
  return `${FILENAME_PREFIX}${iso}${FILENAME_SUFFIX}`;
}

/** True for filenames `backupFilename` produces — the retention pass only ever touches its own artifacts, never an operator's other files in the same directory. */
export function isBackupFilename(filename: string): boolean {
  return filename.startsWith(FILENAME_PREFIX) && filename.endsWith(FILENAME_SUFFIX);
}

/** A deliberately generous default — self-hosters tune it via `RELAY_BACKUP_RETENTION_COUNT` (see `backup-cli.ts`). */
export const DEFAULT_BACKUP_RETENTION_COUNT = 14;

/**
 * Given the backup filenames present in `RELAY_BACKUP_DIR`, returns which
 * ones to delete so at most `keepLastN` remain — the oldest first (relies
 * on {@link backupFilename}'s ISO-timestamp naming sorting chronologically
 * as plain strings). Non-backup filenames (an operator's own files sharing
 * the directory) are ignored entirely, never counted or deleted.
 */
export function selectFilesToPrune(filenames: string[], keepLastN: number): string[] {
  const sorted = filenames.filter(isBackupFilename).sort();
  const excess = sorted.length - keepLastN;
  return excess > 0 ? sorted.slice(0, excess) : [];
}
