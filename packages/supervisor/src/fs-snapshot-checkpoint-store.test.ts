import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CheckpointNotFoundError } from './git-checkpoint-store';
import { FsSnapshotCheckpointStore, SnapshotTooLargeError } from './fs-snapshot-checkpoint-store';

/** Every temp dir any test in this file created — removed in `afterEach`, mirroring `git-checkpoint-store.test.ts`'s own convention. */
const tempDirs: string[] = [];

/** A plain (non-git) project folder — no `.git` anywhere, proving this store needs none. */
async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), 'loombox-fs-checkpoint-project-'));
  tempDirs.push(projectPath);
  return projectPath;
}

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), 'loombox-fs-checkpoint-state-'));
  tempDirs.push(stateDir);
  return stateDir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe('FsSnapshotCheckpointStore', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('checkpoints a plain (non-git) project with no .git init required, and restore brings a changed tracked file back', async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    const store = new FsSnapshotCheckpointStore({
      worktreePath,
      sessionId: 'sess-restore',
      stateDir,
    });

    await mkdir(join(worktreePath, 'src'), { recursive: true });
    await writeFile(join(worktreePath, 'src', 'index.js'), 'export const x = 1;\n');
    await writeFile(join(worktreePath, 'README.md'), 'hello\n');

    const checkpoint = await store.checkpoint({ message: 'before refactor' });
    expect(checkpoint.message).toBe('before refactor');

    await writeFile(join(worktreePath, 'src', 'index.js'), 'export const x = 999; // oops\n');

    const result = await store.restore(checkpoint.id);
    expect(result.discardedUncommittedChanges).toBe(true);
    expect(await readFile(join(worktreePath, 'src', 'index.js'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('restore deletes a file created after the checkpoint and recreates one deleted since', async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    const store = new FsSnapshotCheckpointStore({
      worktreePath,
      sessionId: 'sess-delta',
      stateDir,
    });

    await writeFile(join(worktreePath, 'keep.txt'), 'keep v1\n');
    const checkpoint = await store.checkpoint();

    await writeFile(join(worktreePath, 'new_since.txt'), 'new since checkpoint\n');
    await rm(join(worktreePath, 'keep.txt'), { force: true });

    await store.restore(checkpoint.id);

    expect(await exists(join(worktreePath, 'new_since.txt'))).toBe(false);
    expect(await readFile(join(worktreePath, 'keep.txt'), 'utf8')).toBe('keep v1\n');
  });

  it('captures and restores a symlink by its target, and preserves the executable bit on a regular file', async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    const store = new FsSnapshotCheckpointStore({
      worktreePath,
      sessionId: 'sess-modes',
      stateDir,
    });

    await writeFile(join(worktreePath, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await writeFile(join(worktreePath, 'target.txt'), 'target content\n');
    await symlink('target.txt', join(worktreePath, 'link.txt'));

    const checkpoint = await store.checkpoint();

    await rm(join(worktreePath, 'link.txt'), { force: true });
    await rm(join(worktreePath, 'run.sh'), { force: true });

    await store.restore(checkpoint.id);

    expect(await readlink(join(worktreePath, 'link.txt'))).toBe('target.txt');
    const runStat = await lstat(join(worktreePath, 'run.sh'));
    expect((runStat.mode & 0o111) !== 0).toBe(true);
  });

  it('lists checkpoints oldest first, empty when none exist yet, and never throws for "no checkpoints"', async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    const store = new FsSnapshotCheckpointStore({ worktreePath, sessionId: 'sess-list', stateDir });

    expect(await store.listCheckpoints()).toEqual([]);

    const first = await store.checkpoint({ message: 'first' });
    await writeFile(join(worktreePath, 'a.txt'), 'a\n');
    const second = await store.checkpoint({ message: 'second' });

    expect((await store.listCheckpoints()).map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("namespaces checkpoints by sessionId — two sessions over the same worktree never see each other's checkpoints", async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    await writeFile(join(worktreePath, 'shared.txt'), 'shared\n');

    const storeA = new FsSnapshotCheckpointStore({ worktreePath, sessionId: 'sess-a', stateDir });
    const storeB = new FsSnapshotCheckpointStore({ worktreePath, sessionId: 'sess-b', stateDir });

    await storeA.checkpoint({ message: 'from A' });

    expect(await storeA.listCheckpoints()).toHaveLength(1);
    expect(await storeB.listCheckpoints()).toEqual([]);
  });

  it('throws CheckpointNotFoundError for an unknown checkpoint id from restore/previewRestore/filesAffectedByRestore/deleteCheckpoint', async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    const store = new FsSnapshotCheckpointStore({
      worktreePath,
      sessionId: 'sess-missing',
      stateDir,
    });

    await expect(store.restore('does-not-exist')).rejects.toThrow(CheckpointNotFoundError);
    await expect(store.previewRestore('does-not-exist')).rejects.toThrow(CheckpointNotFoundError);
    await expect(store.filesAffectedByRestore('does-not-exist')).rejects.toThrow(
      CheckpointNotFoundError,
    );
    await expect(store.deleteCheckpoint('does-not-exist')).rejects.toThrow(CheckpointNotFoundError);
  });

  it('previewRestore reports nothing to discard right after a checkpoint, and something once the tree changes', async () => {
    const worktreePath = await createProject();
    const stateDir = await createStateDir();
    const store = new FsSnapshotCheckpointStore({
      worktreePath,
      sessionId: 'sess-preview',
      stateDir,
    });

    await writeFile(join(worktreePath, 'a.txt'), 'a\n');
    const checkpoint = await store.checkpoint();

    expect(await store.previewRestore(checkpoint.id)).toMatchObject({
      hasUncommittedChangesToDiscard: false,
      commitsSinceCheckpoint: 0,
    });

    await writeFile(join(worktreePath, 'a.txt'), 'a changed\n');
    expect(await store.previewRestore(checkpoint.id)).toMatchObject({
      hasUncommittedChangesToDiscard: true,
    });
  });

  describe("filesAffectedByRestore (mirrors GitCheckpointStore's own contract)", () => {
    it('names a changed file, a new untracked-since file, and a since-deleted file, matching restore() end to end', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-files-affected',
        stateDir,
      });

      await writeFile(join(worktreePath, 'keep.txt'), 'keep v1\n');
      await writeFile(join(worktreePath, 'tracked.txt'), 'tracked v1\n');
      const checkpoint = await store.checkpoint();

      await writeFile(join(worktreePath, 'tracked.txt'), 'tracked v1\nchanged after checkpoint\n');
      await writeFile(join(worktreePath, 'new_since.txt'), 'new since checkpoint\n');
      await rm(join(worktreePath, 'keep.txt'), { force: true });

      const changes = await store.filesAffectedByRestore(checkpoint.id);
      const byPath = new Map(changes.map((c) => [c.path, c.action]));
      expect(byPath.get('tracked.txt')).toBe('restore');
      expect(byPath.get('new_since.txt')).toBe('delete');
      expect(byPath.get('keep.txt')).toBe('restore');
      expect(changes).toHaveLength(3);

      await store.restore(checkpoint.id);
      expect(await exists(join(worktreePath, 'new_since.txt'))).toBe(false);
      expect(await readFile(join(worktreePath, 'tracked.txt'), 'utf8')).toBe('tracked v1\n');
      expect(await readFile(join(worktreePath, 'keep.txt'), 'utf8')).toBe('keep v1\n');
    });

    it('is empty when nothing differs from the checkpoint', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-files-unchanged',
        stateDir,
      });
      await writeFile(join(worktreePath, 'a.txt'), 'a\n');
      const checkpoint = await store.checkpoint();

      expect(await store.filesAffectedByRestore(checkpoint.id)).toEqual([]);
    });
  });

  describe('deleteCheckpoint / deleteAllCheckpoints', () => {
    it('deleteCheckpoint removes exactly the one checkpoint, leaving others listed', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-del',
        stateDir,
      });

      const first = await store.checkpoint({ message: 'first' });
      const second = await store.checkpoint({ message: 'second' });

      await store.deleteCheckpoint(first.id);

      expect((await store.listCheckpoints()).map((c) => c.id)).toEqual([second.id]);
    });

    it('deleteAllCheckpoints empties the list', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-del-all',
        stateDir,
      });

      await store.checkpoint();
      await store.checkpoint();
      await store.deleteAllCheckpoints();

      expect(await store.listCheckpoints()).toEqual([]);
    });
  });

  describe('SnapshotTooLargeError — the cost bound (issue #267)', () => {
    it('refuses once the file count exceeds the injected maxFiles cap, without writing a checkpoint', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-too-many-files',
        stateDir,
        maxFiles: 3,
      });
      for (let i = 0; i < 5; i++) {
        await writeFile(join(worktreePath, `file-${i}.txt`), 'x');
      }

      await expect(store.checkpoint()).rejects.toThrow(SnapshotTooLargeError);
      expect(await store.listCheckpoints()).toEqual([]);
    });

    it('refuses once the total byte count exceeds the injected maxBytes cap, without writing a checkpoint', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-too-many-bytes',
        stateDir,
        maxBytes: 10,
      });
      await writeFile(join(worktreePath, 'big.txt'), 'x'.repeat(1000));

      await expect(store.checkpoint()).rejects.toThrow(SnapshotTooLargeError);
      expect(await store.listCheckpoints()).toEqual([]);
    });

    it('names the actual scanned counts on the thrown error', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-error-shape',
        stateDir,
        maxFiles: 2,
      });
      for (let i = 0; i < 4; i++) {
        await writeFile(join(worktreePath, `file-${i}.txt`), 'x');
      }

      const error = await store.checkpoint().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SnapshotTooLargeError);
      expect((error as SnapshotTooLargeError).filesScanned).toBeGreaterThan(2);
    });

    it('never refuses restore/previewRestore/filesAffectedByRestore for a working set that has grown past the cap since its own checkpoint', async () => {
      const worktreePath = await createProject();
      const stateDir = await createStateDir();
      const store = new FsSnapshotCheckpointStore({
        worktreePath,
        sessionId: 'sess-grown-past-cap',
        stateDir,
        maxFiles: 2,
      });
      await writeFile(join(worktreePath, 'a.txt'), 'a\n');
      const checkpoint = await store.checkpoint();

      // Grow well past the (tiny, injected) cap after the checkpoint —
      // restore must still work, per this store's own "bound checkpoint()
      // only" module doc comment.
      for (let i = 0; i < 5; i++) {
        await writeFile(join(worktreePath, `extra-${i}.txt`), 'x');
      }

      await expect(store.previewRestore(checkpoint.id)).resolves.toMatchObject({
        hasUncommittedChangesToDiscard: true,
      });
      await store.restore(checkpoint.id);
      for (let i = 0; i < 5; i++) {
        expect(await exists(join(worktreePath, `extra-${i}.txt`))).toBe(false);
      }
    });
  });
});
