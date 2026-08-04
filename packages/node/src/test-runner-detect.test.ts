import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalExecutionTarget } from './local-execution-target';
import { detectTestRunnerCommands } from './test-runner-detect';

let projectDir: string;
const target = new LocalExecutionTarget();

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'loombox-test-runner-detect-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function writePackageJson(scripts: Record<string, string>): Promise<void> {
  await writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts }, null, 2),
  );
}

describe('detectTestRunnerCommands (against LocalExecutionTarget — a real project directory)', () => {
  it('returns {} for a directory with no package.json at all — never a guessed default', async () => {
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({});
  });

  it('returns {} for a package.json with no scripts block', async () => {
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture' }));
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({});
  });

  it('returns {} for malformed JSON rather than throwing', async () => {
    await writeFile(path.join(projectDir, 'package.json'), '{not json');
    await expect(detectTestRunnerCommands(target, projectDir)).resolves.toEqual({});
  });

  it('proposes only the scripts that actually exist, never a guessed one for a missing script', async () => {
    await writePackageJson({ test: 'vitest run' });
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({ test: 'npm test' });
  });

  it('defaults to npm-shaped commands with no lockfile present ("npm test" shorthand, "npm run" for others)', async () => {
    await writePackageJson({ test: 'vitest run', lint: 'eslint .', build: 'tsc' });
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({
      test: 'npm test',
      lint: 'npm run lint',
      build: 'npm run build',
    });
  });

  it("proposes pnpm-shaped commands when pnpm-lock.yaml is present (this monorepo's own stack, issue #245)", async () => {
    await writePackageJson({ test: 'vitest run', lint: 'eslint .', build: 'tsc' });
    await writeFile(path.join(projectDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({
      test: 'pnpm test',
      lint: 'pnpm lint',
      build: 'pnpm build',
    });
  });

  it('proposes yarn-shaped commands when yarn.lock is present', async () => {
    await writePackageJson({ test: 'jest' });
    await writeFile(path.join(projectDir, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({ test: 'yarn test' });
  });

  it('prefers pnpm over yarn when both lockfiles are somehow present', async () => {
    await writePackageJson({ test: 'vitest run' });
    await writeFile(path.join(projectDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(path.join(projectDir, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(await detectTestRunnerCommands(target, projectDir)).toEqual({ test: 'pnpm test' });
  });
});
