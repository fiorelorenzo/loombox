import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generateAmk,
  generateRecoveryCode,
  packWrappedAmkForWire,
  wrapAmkWithRecoveryCode,
} from '@loombox/crypto';
import { PROTOCOL_V1, type AmkEscrow, type Initialize } from '@loombox/protocol';
import { startRelay, type StartedRelay } from '@loombox/relay';

import { ConfigError } from './config';
import { bootstrapAmkFromRecoveryCode } from './amk-bootstrap';

/**
 * Escrows `wrappedAmk` for `accountId` on `relay` exactly the way a real
 * client would (SPEC §8 path 2's `amk_escrow` message) — a raw WebSocket
 * round-trip, not a `RelayClient`/`RelayConnection` (neither is needed for
 * one fire-and-forget frame), so this test file has no dependency on
 * `apps/web`. `authToken` defaults to `accountId`, matching the relay's
 * hermetic stub mode (`deriveAccountIdStub`) every other `packages/node`
 * integration test already relies on.
 */
async function escrowAmk(
  relay: StartedRelay,
  accountId: string,
  amk: Uint8Array,
  recoveryCode: string,
): Promise<void> {
  const blob = await wrapAmkWithRecoveryCode(amk, recoveryCode, accountId);
  const wrappedAmk = packWrappedAmkForWire(blob);

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relay.url);
    socket.addEventListener('open', () => {
      const initialize: Initialize = {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'node',
        authToken: accountId,
        deviceId: `${accountId}-escrow-source`,
        devicePublicKey: 'ZXNjcm93LXNvdXJjZQ==',
      };
      socket.send(JSON.stringify(initialize));
    });
    let sentEscrow = false;
    socket.addEventListener('message', () => {
      if (sentEscrow) return;
      sentEscrow = true;
      const escrow: AmkEscrow = { type: 'amk_escrow', protocolVersion: PROTOCOL_V1, wrappedAmk };
      socket.send(JSON.stringify(escrow));
      // `amk_escrow` has no response frame (relay just persists it); give it
      // one tick on the wire before closing so the frame isn't dropped
      // mid-flight, mirroring how a real client fires-and-forgets it.
      setTimeout(() => {
        socket.close();
        resolve();
      }, 50);
    });
    socket.addEventListener('error', () => reject(new Error('escrowAmk: relay unreachable')));
  });
}

describe('bootstrapAmkFromRecoveryCode (issue #386)', () => {
  let relay: StartedRelay;

  beforeEach(async () => {
    relay = await startRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  it('recovers the SAME AMK a web client bootstrapping with the same recovery code would', async () => {
    const accountId = 'acct-bootstrap-1';
    const amk = generateAmk();
    const recoveryCode = generateRecoveryCode();
    await escrowAmk(relay, accountId, amk, recoveryCode);

    const recovered = await bootstrapAmkFromRecoveryCode({
      relayUrl: relay.url,
      accountId,
      authToken: accountId,
      deviceId: 'node-device-1',
      devicePublicKey: 'bm9kZS1kZXZpY2Uta2V5',
      recoveryCode,
    });

    expect(recovered).toEqual(amk);
  });

  it('rejects with a clear error when the recovery code is wrong', async () => {
    const accountId = 'acct-bootstrap-2';
    const amk = generateAmk();
    const recoveryCode = generateRecoveryCode();
    await escrowAmk(relay, accountId, amk, recoveryCode);

    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId,
        authToken: accountId,
        deviceId: 'node-device-2',
        devicePublicKey: 'bm9kZS1kZXZpY2Uta2V5',
        recoveryCode: generateRecoveryCode(), // a different, wrong code
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('rejects when the AAD-bound accountId disagrees with the escrow (wrong account, right code)', async () => {
    // Authenticates (`authToken`) as `acct-owner` — the relay's hermetic
    // stub resolves that to `connection.accountId`, so the escrow lookup
    // itself succeeds and the relay hands back `acct-owner`'s real
    // `wrappedAmk`. But the AAD binding the unwrap step checks comes from
    // `accountId` alone (SPEC §8/`recovery-escrow.ts`'s "sealed for one
    // account fails to unwrap if ever presented for another") — decoupled
    // from `authToken` deliberately (real Better Auth: bearer token != user
    // id), so passing a *different* `accountId` here reaches the real
    // AES-GCM auth-tag failure, not just a relay-side "unknown account".
    const amk = generateAmk();
    const recoveryCode = generateRecoveryCode();
    await escrowAmk(relay, 'acct-owner', amk, recoveryCode);

    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId: 'acct-impostor',
        authToken: 'acct-owner',
        deviceId: 'node-device-3',
        devicePublicKey: 'bm9kZS1kZXZpY2Uta2V5',
        recoveryCode,
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('rejects (rather than hangs forever) when this account has never escrowed an AMK', async () => {
    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: relay.url,
        accountId: 'acct-never-escrowed',
        authToken: 'acct-never-escrowed',
        deviceId: 'node-device-4',
        devicePublicKey: 'bm9kZS1kZXZpY2Uta2V5',
        recoveryCode: generateRecoveryCode(),
        timeoutMs: 200,
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('rejects when the relay is unreachable', async () => {
    await expect(
      bootstrapAmkFromRecoveryCode({
        relayUrl: 'ws://127.0.0.1:1',
        accountId: 'acct-unreachable',
        authToken: 'acct-unreachable',
        deviceId: 'node-device-5',
        devicePublicKey: 'bm9kZS1kZXZpY2Uta2V5',
        recoveryCode: generateRecoveryCode(),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(ConfigError);
  });
});
