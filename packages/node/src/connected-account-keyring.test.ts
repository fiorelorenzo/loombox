import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectedAccountSecretRef } from '@loombox/protocol';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
} from './connected-account-keyring';

/**
 * Proves the one property `account-presence.ts` (issue #228) depends on:
 * two independently-constructed `createConnectedAccountKeyring()` callers
 * for the same node (same `stateDir`) read and write the exact same store,
 * on the file-fallback path this devbox actually runs (`keyring.ts`'s own
 * doc comment). If this ever regressed to per-caller storage, a presence
 * check built from its own keyring instance would silently report every
 * real account absent.
 */

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-connected-account-keyring-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function keyring() {
  return createConnectedAccountKeyring({
    stateDir,
    osKeyringBackendFactory: async () => undefined,
  });
}

describe('createConnectedAccountKeyring (SPEC §7.26, issue #228)', () => {
  it('a value written by one caller is readable by a second, independently-constructed caller for the same node', async () => {
    const secretRef = connectedAccountSecretRef('github:github.com:1111');
    const writer = keyring();
    await writer.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, 'gho_secret-token');

    const reader = keyring();
    expect(await reader.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef)).toBe('gho_secret-token');
  });

  it('a value deleted by one caller is gone for a second caller too', async () => {
    const secretRef = connectedAccountSecretRef('jira:myteam.atlassian.net:5b10ac8d');
    const writer = keyring();
    await writer.set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, '{"email":"a","apiToken":"b"}');

    const deleter = keyring();
    await deleter.delete(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef);

    const reader = keyring();
    expect(await reader.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef)).toBeUndefined();
  });

  it("a different stateDir (a different node) never sees another node's entries", async () => {
    const secretRef = connectedAccountSecretRef('github:github.com:2222');
    await keyring().set(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef, 'gho_other-secret');

    const otherStateDir = await mkdtemp(
      path.join(tmpdir(), 'loombox-node-connected-account-keyring-test-other-'),
    );
    try {
      const otherNode = createConnectedAccountKeyring({
        stateDir: otherStateDir,
        osKeyringBackendFactory: async () => undefined,
      });
      expect(await otherNode.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef)).toBeUndefined();
    } finally {
      await rm(otherStateDir, { recursive: true, force: true });
    }
  });
});
