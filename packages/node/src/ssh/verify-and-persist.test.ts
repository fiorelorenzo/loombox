import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SshTargetConfig } from '../target';
import { FakeTransport } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import {
  classifyConnectError,
  SshTargetStore,
  verifyAndPersistSshTarget,
} from './verify-and-persist';

const CANDIDATE: SshTargetConfig = {
  id: 'devbox-1',
  label: 'Dev box',
  host: '100.87.202.117',
  user: 'dev',
};

let stateDir: string;
let store: SshTargetStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-ssh-target-store-'));
  store = new SshTargetStore({ stateDir });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('classifyConnectError', () => {
  it('classifies an ssh2 client-authentication rejection as auth_failed', () => {
    expect(classifyConnectError({ level: 'client-authentication', message: 'nope' })).toBe(
      'auth_failed',
    );
  });

  it('classifies a connection-refused/unreachable-host error as unreachable', () => {
    expect(classifyConnectError({ code: 'ECONNREFUSED' })).toBe('unreachable');
    expect(classifyConnectError({ code: 'ENOTFOUND' })).toBe('unreachable');
    expect(classifyConnectError({ code: 'ETIMEDOUT' })).toBe('unreachable');
  });

  it('falls back to unknown for anything else', () => {
    expect(classifyConnectError(new Error('some other failure'))).toBe('unknown');
  });
});

describe('SshTargetStore', () => {
  it('starts empty, and save()/remove() round-trip', () => {
    expect(store.list()).toEqual([]);

    store.save(CANDIDATE);
    expect(store.list()).toEqual([CANDIDATE]);
    expect(store.get('devbox-1')).toEqual(CANDIDATE);

    store.remove('devbox-1');
    expect(store.list()).toEqual([]);
  });

  it('save() replaces an existing entry with the same id instead of duplicating it', () => {
    store.save(CANDIDATE);
    store.save({ ...CANDIDATE, label: 'renamed' });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.label).toBe('renamed');
  });
});

describe('verifySshTarget / verifyAndPersistSshTarget', () => {
  it('succeeds against a real (local-standin) transport and persists the target', async () => {
    const result = await verifyAndPersistSshTarget(
      CANDIDATE,
      () => new LocalProcessTransport(),
      store,
    );
    expect(result).toEqual({ ok: true });
    expect(store.list()).toEqual([CANDIDATE]);
  });

  it('reports a host-unreachable failure and leaves no half-configured target behind', async () => {
    const connectError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const result = await verifyAndPersistSshTarget(
      CANDIDATE,
      () => new FakeTransport({ connectError }),
      store,
    );
    expect(result).toEqual({ ok: false, reason: 'unreachable', message: connectError.message });
    expect(store.list()).toEqual([]);
  });

  it('reports an auth failure distinctly from unreachable, and leaves no half-configured target behind', async () => {
    const connectError = Object.assign(new Error('All configured authentication methods failed'), {
      level: 'client-authentication',
    });
    const result = await verifyAndPersistSshTarget(
      CANDIDATE,
      () => new FakeTransport({ connectError }),
      store,
    );
    expect(result).toEqual({ ok: false, reason: 'auth_failed', message: connectError.message });
    expect(store.list()).toEqual([]);
  });

  it('reports a deploy failure when the connection succeeds but nothing can be launched, and leaves no half-configured target behind', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        // Answer capability detection with "nothing available" so
        // chooseDetachMode() throws inside launchWithFallback().
        if (command.includes('command -v')) {
          return { stdout: 'setsid=0\nmkfifo=0\ntmux=0\nscreen=0\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const result = await verifyAndPersistSshTarget(CANDIDATE, () => transport, store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('deploy_failed');
    expect(store.list()).toEqual([]);
  });
});
