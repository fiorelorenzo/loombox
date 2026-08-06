import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import {
  AgentInstructionsError,
  hashAgentInstructionsContent,
  readAgentInstructionsFiles,
  writeAgentInstructionsFile,
} from './agent-instructions';
import type { ExecutionTarget } from './target';

describe('agent instructions against a real temp worktree (SPEC §7.18; issue #260)', () => {
  let worktreePath: string;
  const target: ExecutionTarget = new LocalExecutionTarget();

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'loombox-agent-instructions-'));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  describe('readAgentInstructionsFiles', () => {
    it('resolves an empty list for a project with neither file', async () => {
      await expect(readAgentInstructionsFiles(target, worktreePath)).resolves.toEqual([]);
    });

    it('reports AGENTS.md alone, hashed', async () => {
      await writeFile(join(worktreePath, 'AGENTS.md'), '# instructions\n');

      const files = await readAgentInstructionsFiles(target, worktreePath);

      expect(files).toEqual([
        {
          fileName: 'AGENTS.md',
          content: '# instructions\n',
          hash: hashAgentInstructionsContent('# instructions\n'),
        },
      ]);
    });

    it('reports both AGENTS.md and CLAUDE.md when both exist', async () => {
      await writeFile(join(worktreePath, 'AGENTS.md'), 'agents content');
      await writeFile(join(worktreePath, 'CLAUDE.md'), '@AGENTS.md\n');

      const files = await readAgentInstructionsFiles(target, worktreePath);

      expect(files.map((file) => file.fileName)).toEqual(['AGENTS.md', 'CLAUDE.md']);
      expect(files[1]).toEqual({
        fileName: 'CLAUDE.md',
        content: '@AGENTS.md\n',
        hash: hashAgentInstructionsContent('@AGENTS.md\n'),
      });
    });

    it('throws AgentInstructionsError when the worktree itself is not reachable', async () => {
      await expect(
        readAgentInstructionsFiles(target, join(worktreePath, 'does-not-exist')),
      ).rejects.toThrow(AgentInstructionsError);
    });
  });

  describe('writeAgentInstructionsFile', () => {
    it('creates a new AGENTS.md when baseHash is null and none exists yet', async () => {
      const result = await writeAgentInstructionsFile(target, worktreePath, {
        fileName: 'AGENTS.md',
        content: '# hello\n',
        baseHash: null,
      });

      expect(result).toEqual({
        outcome: 'ok',
        fileName: 'AGENTS.md',
        content: '# hello\n',
        hash: hashAgentInstructionsContent('# hello\n'),
      });
      await expect(readAgentInstructionsFiles(target, worktreePath)).resolves.toEqual([
        {
          fileName: 'AGENTS.md',
          content: '# hello\n',
          hash: hashAgentInstructionsContent('# hello\n'),
        },
      ]);
    });

    it('refuses to create when baseHash is null but the file already exists (conflict)', async () => {
      await writeFile(join(worktreePath, 'AGENTS.md'), 'already here');

      const result = await writeAgentInstructionsFile(target, worktreePath, {
        fileName: 'AGENTS.md',
        content: 'clobber attempt',
        baseHash: null,
      });

      expect(result).toEqual({
        outcome: 'conflict',
        fileName: 'AGENTS.md',
        current: {
          fileName: 'AGENTS.md',
          content: 'already here',
          hash: hashAgentInstructionsContent('already here'),
        },
      });
      await expect(readAgentInstructionsFiles(target, worktreePath)).resolves.toEqual([
        {
          fileName: 'AGENTS.md',
          content: 'already here',
          hash: hashAgentInstructionsContent('already here'),
        },
      ]);
    });

    it('edits an existing file when baseHash matches the current content exactly', async () => {
      await writeFile(join(worktreePath, 'CLAUDE.md'), 'v1');
      const v1Hash = hashAgentInstructionsContent('v1');

      const result = await writeAgentInstructionsFile(target, worktreePath, {
        fileName: 'CLAUDE.md',
        content: 'v2',
        baseHash: v1Hash,
      });

      expect(result).toEqual({
        outcome: 'ok',
        fileName: 'CLAUDE.md',
        content: 'v2',
        hash: hashAgentInstructionsContent('v2'),
      });
    });

    it('never overwrites blindly: refuses with conflict when the file changed underneath the edit', async () => {
      await writeFile(join(worktreePath, 'AGENTS.md'), 'original');
      const originalHash = hashAgentInstructionsContent('original');
      // Someone/something else edits the file after the caller last read it.
      await writeFile(join(worktreePath, 'AGENTS.md'), 'changed underneath');

      const result = await writeAgentInstructionsFile(target, worktreePath, {
        fileName: 'AGENTS.md',
        content: 'my stale edit',
        baseHash: originalHash,
      });

      expect(result).toEqual({
        outcome: 'conflict',
        fileName: 'AGENTS.md',
        current: {
          fileName: 'AGENTS.md',
          content: 'changed underneath',
          hash: hashAgentInstructionsContent('changed underneath'),
        },
      });
      // The write was genuinely refused — disk still holds the interloper's content.
      await expect(readAgentInstructionsFiles(target, worktreePath)).resolves.toEqual([
        {
          fileName: 'AGENTS.md',
          content: 'changed underneath',
          hash: hashAgentInstructionsContent('changed underneath'),
        },
      ]);
    });

    it('reports current: null when the file was deleted underneath the edit', async () => {
      await writeFile(join(worktreePath, 'AGENTS.md'), 'original');
      const originalHash = hashAgentInstructionsContent('original');
      await rm(join(worktreePath, 'AGENTS.md'));

      const result = await writeAgentInstructionsFile(target, worktreePath, {
        fileName: 'AGENTS.md',
        content: 'my stale edit',
        baseHash: originalHash,
      });

      expect(result).toEqual({ outcome: 'conflict', fileName: 'AGENTS.md', current: null });
    });

    it('writing one file never disturbs the other', async () => {
      await writeFile(join(worktreePath, 'AGENTS.md'), 'agents original');
      await writeFile(join(worktreePath, 'CLAUDE.md'), 'claude original');

      await writeAgentInstructionsFile(target, worktreePath, {
        fileName: 'AGENTS.md',
        content: 'agents updated',
        baseHash: hashAgentInstructionsContent('agents original'),
      });

      const files = await readAgentInstructionsFiles(target, worktreePath);
      expect(files.find((file) => file.fileName === 'CLAUDE.md')?.content).toBe('claude original');
    });

    it('throws AgentInstructionsError when the worktree itself is not reachable', async () => {
      await expect(
        writeAgentInstructionsFile(target, join(worktreePath, 'does-not-exist'), {
          fileName: 'AGENTS.md',
          content: 'x',
          baseHash: null,
        }),
      ).rejects.toThrow(AgentInstructionsError);
    });
  });
});
