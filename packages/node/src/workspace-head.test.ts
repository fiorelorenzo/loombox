import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import { resolveWorkspaceHeadSha } from './workspace-head';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('resolveWorkspaceHeadSha (SPEC §7.14/§7.15; issue #247)', () => {
  const target = new LocalExecutionTarget();
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'loombox-workspace-head-test-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('resolves undefined for a plain, non-git folder (SPEC §6) — not an error', async () => {
    const sha = await resolveWorkspaceHeadSha(target, projectPath);
    expect(sha).toBeUndefined();
  });

  it('resolves the real HEAD sha for a real git repo', async () => {
    await git(projectPath, ['init', '-b', 'main']);
    await git(projectPath, ['config', 'user.email', 'test@loombox.dev']);
    await git(projectPath, ['config', 'user.name', 'loombox test']);
    await git(projectPath, ['commit', '--allow-empty', '-m', 'initial']);
    const expected = await git(projectPath, ['rev-parse', 'HEAD']);

    const sha = await resolveWorkspaceHeadSha(target, projectPath);
    expect(sha).toBe(expected);
  });

  it('tracks a moved HEAD on a later call rather than caching the first reading', async () => {
    await git(projectPath, ['init', '-b', 'main']);
    await git(projectPath, ['config', 'user.email', 'test@loombox.dev']);
    await git(projectPath, ['config', 'user.name', 'loombox test']);
    await git(projectPath, ['commit', '--allow-empty', '-m', 'first']);
    const first = await resolveWorkspaceHeadSha(target, projectPath);

    await git(projectPath, ['commit', '--allow-empty', '-m', 'second']);
    const second = await resolveWorkspaceHeadSha(target, projectPath);

    expect(second).not.toBe(first);
    expect(second).toBe(await git(projectPath, ['rev-parse', 'HEAD']));
  });

  it('resolves undefined for a folder that does not exist on disk at all', async () => {
    const sha = await resolveWorkspaceHeadSha(target, join(projectPath, 'never-created'));
    expect(sha).toBeUndefined();
  });
});
