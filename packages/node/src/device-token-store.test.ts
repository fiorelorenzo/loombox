import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceTokenFileStore } from './device-token-store';

describe('DeviceTokenFileStore (#387)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loombox-node-device-token-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when nothing is persisted yet', () => {
    const store = new DeviceTokenFileStore({ stateDir: dir });
    expect(store.load()).toBeUndefined();
  });

  it('round-trips a saved token through load(), at file mode 0600', () => {
    const store = new DeviceTokenFileStore({ stateDir: dir });
    store.save('a-device-token');
    expect(store.load()).toBe('a-device-token');

    const filePath = join(dir, 'device-token.json');
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites a previously saved token, and stays 0600 even if the file was loosened in between', () => {
    const store = new DeviceTokenFileStore({ stateDir: dir });
    store.save('first-token');
    const filePath = join(dir, 'device-token.json');
    chmodSync(filePath, 0o644);

    store.save('second-token');
    expect(store.load()).toBe('second-token');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('creates the state dir if it does not exist yet', () => {
    const nested = join(dir, 'nested', 'state');
    const store = new DeviceTokenFileStore({ stateDir: nested });
    store.save('a-token');
    expect(store.load()).toBe('a-token');
  });

  it('treats a corrupt file as "no token yet" rather than throwing', () => {
    const filePath = join(dir, 'device-token.json');
    writeFileSync(filePath, '{ not valid json', 'utf8');
    const store = new DeviceTokenFileStore({ stateDir: dir });
    expect(store.load()).toBeUndefined();
  });

  it('two stores pointed at different state dirs never see each other’s token', () => {
    const dirB = mkdtempSync(join(tmpdir(), 'loombox-node-device-token-b-'));
    try {
      const storeA = new DeviceTokenFileStore({ stateDir: dir });
      const storeB = new DeviceTokenFileStore({ stateDir: dirB });
      storeA.save('token-a');
      expect(storeB.load()).toBeUndefined();
      expect(storeA.load()).toBe('token-a');
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
