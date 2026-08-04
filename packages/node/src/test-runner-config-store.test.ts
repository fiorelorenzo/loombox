import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestRunnerConfigError, TestRunnerConfigStore } from './test-runner-config-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-test-runner-config-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('TestRunnerConfigStore', () => {
  it('get() returns {} for an unconfigured project, against a fresh state dir', () => {
    const store = new TestRunnerConfigStore({ stateDir });
    expect(store.get('/proj-a')).toEqual({});
  });

  it('save() then get() round-trips commands for exactly the saved project', () => {
    const store = new TestRunnerConfigStore({ stateDir });
    store.save('/proj-a', { test: 'pnpm test', lint: 'pnpm lint', build: 'pnpm build' });
    expect(store.get('/proj-a')).toEqual({
      test: 'pnpm test',
      lint: 'pnpm lint',
      build: 'pnpm build',
    });
    // A different, never-saved project is unaffected.
    expect(store.get('/proj-b')).toEqual({});
  });

  it('save() merges over the existing saved commands rather than replacing wholesale', () => {
    const store = new TestRunnerConfigStore({ stateDir });
    store.save('/proj-a', { test: 'pnpm test', lint: 'pnpm lint' });
    store.save('/proj-a', { build: 'pnpm build' });
    expect(store.get('/proj-a')).toEqual({
      test: 'pnpm test',
      lint: 'pnpm lint',
      build: 'pnpm build',
    });
  });

  it('save() overwrites a single key without disturbing the others', () => {
    const store = new TestRunnerConfigStore({ stateDir });
    store.save('/proj-a', { test: 'pnpm test', lint: 'pnpm lint' });
    store.save('/proj-a', { test: 'pnpm vitest run' });
    expect(store.get('/proj-a')).toEqual({ test: 'pnpm vitest run', lint: 'pnpm lint' });
  });

  it('unset() clears one saved key, leaving the others and is a no-op for a key never saved', () => {
    const store = new TestRunnerConfigStore({ stateDir });
    store.save('/proj-a', { test: 'pnpm test', lint: 'pnpm lint' });
    store.unset('/proj-a', 'test');
    expect(store.get('/proj-a')).toEqual({ lint: 'pnpm lint' });
    expect(() => store.unset('/proj-a', 'build')).not.toThrow();
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    new TestRunnerConfigStore({ stateDir }).save('/proj-a', { test: 'pnpm test' });
    const reopened = new TestRunnerConfigStore({ stateDir });
    expect(reopened.get('/proj-a')).toEqual({ test: 'pnpm test' });
  });

  describe('on-disk validation', () => {
    it('throws TestRunnerConfigError for invalid JSON', async () => {
      await writeFile(path.join(stateDir, 'test-runner-config.json'), '{not json');
      const store = new TestRunnerConfigStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(TestRunnerConfigError);
    });

    it('throws TestRunnerConfigError when a command is not a non-empty string', async () => {
      await writeFile(
        path.join(stateDir, 'test-runner-config.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': { test: '' } } }),
      );
      const store = new TestRunnerConfigStore({ stateDir });
      expect(() => store.get('/proj-a')).toThrow(TestRunnerConfigError);
    });

    it('tolerates a project record missing lint/build, leaving them unset', async () => {
      await writeFile(
        path.join(stateDir, 'test-runner-config.json'),
        JSON.stringify({ v: 1, projects: { '/proj-a': { test: 'pnpm test' } } }),
      );
      const store = new TestRunnerConfigStore({ stateDir });
      expect(store.get('/proj-a')).toEqual({ test: 'pnpm test' });
    });
  });
});
