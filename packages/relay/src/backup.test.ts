import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  backupFilename,
  DEFAULT_BACKUP_RETENTION_COUNT,
  isBackupFilename,
  runPgDump,
  runPgRestore,
  selectFilesToPrune,
} from './backup';

/**
 * A minimal fake `child_process.spawn` (#103): hermetic command-construction
 * tests for `runPgDump`/`runPgRestore` inject this instead of actually
 * shelling out, so they run with no `pg_dump`/`pg_restore` binary and no
 * Docker/Postgres needed (the real dump/restore round trip is covered
 * separately in `backup-restore.integration.test.ts`, gated behind
 * `LOOMBOX_TEST_PG_URL`).
 */
function fakeSpawn(opts: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let capturedStdin: Buffer | undefined;

  const spawnFn = vi.fn((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: (data: Buffer) => void };
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (data: Buffer) => {
        capturedStdin = data;
      },
    };
    // Defer so the caller's `.on(...)` listeners are attached first.
    queueMicrotask(() => {
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      child.emit('close', opts.exitCode ?? 0);
    });
    return child;
  });

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnFn: spawnFn as any,
    calls,
    stdinFed: () => capturedStdin,
  };
}

describe('runPgDump (#103)', () => {
  it('invokes pg_dump --format=custom against the given database with the default command', async () => {
    const fake = fakeSpawn({ stdout: 'dump-bytes' });

    const result = await runPgDump({
      databaseUrl: 'postgresql://u:p@host/db',
      spawnFn: fake.spawnFn,
    });

    expect(result.toString()).toBe('dump-bytes');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.bin).toBe('pg_dump');
    expect(fake.calls[0]?.args).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--dbname=postgresql://u:p@host/db',
    ]);
  });

  it('honors a command override (e.g. a docker-wrapped pg_dump), prefixing its extra args', async () => {
    const fake = fakeSpawn({ stdout: 'x' });

    await runPgDump({
      databaseUrl: 'postgresql://u:p@host/db',
      command: ['docker', 'run', '--rm', '--network', 'host', 'postgres:16-alpine', 'pg_dump'],
      spawnFn: fake.spawnFn,
    });

    expect(fake.calls[0]?.bin).toBe('docker');
    expect(fake.calls[0]?.args).toEqual([
      'run',
      '--rm',
      '--network',
      'host',
      'postgres:16-alpine',
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--dbname=postgresql://u:p@host/db',
    ]);
  });

  it('rejects with stderr on a non-zero exit', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: 'pg_dump: connection refused' });

    await expect(
      runPgDump({ databaseUrl: 'postgresql://u:p@host/db', spawnFn: fake.spawnFn }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe('runPgRestore (#103)', () => {
  it('invokes pg_restore --clean --if-exists, feeding the dump on stdin', async () => {
    const fake = fakeSpawn();
    const dump = Buffer.from('the dump bytes');

    await runPgRestore({ databaseUrl: 'postgresql://u:p@host/db', dump, spawnFn: fake.spawnFn });

    expect(fake.calls[0]?.bin).toBe('pg_restore');
    expect(fake.calls[0]?.args).toEqual([
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--dbname=postgresql://u:p@host/db',
    ]);
    expect(fake.stdinFed()?.equals(dump)).toBe(true);
  });

  it('rejects with stderr on a non-zero exit', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: 'pg_restore: could not connect' });

    await expect(
      runPgRestore({
        databaseUrl: 'postgresql://u:p@host/db',
        dump: Buffer.from('x'),
        spawnFn: fake.spawnFn,
      }),
    ).rejects.toThrow(/could not connect/);
  });
});

describe('backupFilename / isBackupFilename (#103)', () => {
  it('produces a sortable, recognizable filename', () => {
    const name = backupFilename(new Date('2026-07-20T03:00:00.000Z'));
    expect(name).toBe('relay-backup-2026-07-20T03-00-00-000Z.dump.enc');
    expect(isBackupFilename(name)).toBe(true);
  });

  it('does not recognize an unrelated filename in the same directory', () => {
    expect(isBackupFilename('notes.txt')).toBe(false);
    expect(isBackupFilename('relay-backup-oops')).toBe(false);
  });
});

describe('selectFilesToPrune (#103)', () => {
  it('keeps exactly the last N backups, oldest pruned first', () => {
    const filenames = [
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-02T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-03T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-04T00-00-00-000Z.dump.enc',
    ];

    const toPrune = selectFilesToPrune(filenames, 2);

    expect(toPrune).toEqual([
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-02T00-00-00-000Z.dump.enc',
    ]);
  });

  it('is order-independent (sorts before pruning)', () => {
    const filenames = [
      'relay-backup-2026-07-03T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-02T00-00-00-000Z.dump.enc',
    ];

    expect(selectFilesToPrune(filenames, 1)).toEqual([
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-02T00-00-00-000Z.dump.enc',
    ]);
  });

  it('prunes nothing when at or under the retention count', () => {
    const filenames = [
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
      'relay-backup-2026-07-02T00-00-00-000Z.dump.enc',
    ];
    expect(selectFilesToPrune(filenames, 2)).toEqual([]);
    expect(selectFilesToPrune(filenames, 10)).toEqual([]);
  });

  it('ignores non-backup files entirely (never counts or prunes them)', () => {
    const filenames = [
      'README.md',
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
      '.gitkeep',
      'relay-backup-2026-07-02T00-00-00-000Z.dump.enc',
    ];
    expect(selectFilesToPrune(filenames, 1)).toEqual([
      'relay-backup-2026-07-01T00-00-00-000Z.dump.enc',
    ]);
  });

  it('is idempotent: pruning again after deletion finds nothing left to prune', () => {
    const remaining = ['relay-backup-2026-07-02T00-00-00-000Z.dump.enc'];
    expect(selectFilesToPrune(remaining, 1)).toEqual([]);
  });
});

describe('DEFAULT_BACKUP_RETENTION_COUNT', () => {
  it('is a generous, multi-day default', () => {
    expect(DEFAULT_BACKUP_RETENTION_COUNT).toBeGreaterThanOrEqual(7);
  });
});
