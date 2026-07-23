import {
  PROTOCOL_V1,
  initializeResult,
  newDeviceBootstrapResponse,
  type Initialize,
  type NewDeviceBootstrapRequest,
} from '@loombox/protocol';
import { unpackWrappedAmkFromWire, unwrapAmkWithRecoveryCode } from '@loombox/crypto';

import { ConfigError } from './config';
import type { WebSocketConstructor, WebSocketLike } from './relay-connection';

const WS_CONNECTING = 0;
const WS_OPEN = 1;

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;

/** Options for {@link bootstrapAmkFromRecoveryCode}. */
export interface BootstrapAmkFromRecoveryCodeOptions {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** The account this node's `LOOMBOX_ACCOUNT_ID`/resolved-from-token account — the same AAD binding `unwrapAmkWithRecoveryCode` checks. */
  accountId: string;
  /** Opaque Better Auth bearer token (SPEC §8), sent in the bootstrap connection's own `initialize` handshake. */
  authToken: string;
  /** This node's stable device id (`NodeCliConfig.deviceId`) — the resident node IS the device here, unlike `apps/web`'s bootstrap (which mints a fresh one per browser). */
  deviceId: string;
  /** This node's persisted ECDH P-256 identity public key (base64), from `identity.ts`'s `NodeIdentityStore` — reused, never freshly generated, so this bootstrap registers the same device identity the node's main relay connection uses right after. */
  devicePublicKey: string;
  /** The Recovery Code the account owner was shown (and confirmed saving) when they first set this account up. */
  recoveryCode: string;
  /** WebSocket constructor override; defaults to the global `WebSocket` (Node 22+). Tests inject a fake. */
  webSocketImpl?: WebSocketConstructor;
  /** How long to wait for the relay's `new_device_bootstrap_response` before giving up. Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * Recovers this account's AMK from a Recovery Code (SPEC §8 path 2
 * "recovery-code escrow"; issue #386) by performing the relay's new-device
 * bootstrap round-trip: `initialize` (registering this node's own persisted
 * device identity), then `new_device_bootstrap_request`, then unwrapping
 * whatever `wrappedAmk` blob the relay hands back with `recoveryCode` via
 * `@loombox/crypto`'s `unwrapAmkWithRecoveryCode`. This is the exact crypto
 * path `apps/web`'s `bootstrapAmkFromRecoveryCode` (`relay-client.ts`) drives
 * for a browser client — mirrored here rather than imported, since this
 * package never depends on `apps/web` — so a node given the same account's
 * Recovery Code recovers the identical AMK a web client bootstrapping with it
 * would.
 *
 * Opens its own short-lived connection, separate from this node's persistent
 * `RelayConnection` (`main.ts`'s `start()` calls this before `createNode()`
 * even exists, since `NodeDaemonOptions.amk` must already be resolved by
 * then) — always closed before this resolves or rejects.
 *
 * Throws {@link ConfigError} — matching `resolve-account-id.ts`'s convention
 * for "this node cannot start up correctly" — when: the relay is
 * unreachable or rejects the handshake; the account has never escrowed an
 * AMK (relay logs a warning and never replies, so this times out); or
 * `recoveryCode`/`accountId` is wrong (the AES-GCM auth tag check inside
 * `unwrapAmkWithRecoveryCode` fails) — never returns a partially-recovered
 * or garbage AMK.
 */
export async function bootstrapAmkFromRecoveryCode(
  options: BootstrapAmkFromRecoveryCodeOptions,
): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const ctor = options.webSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
  if (!ctor) {
    throw new ConfigError(
      'AMK recovery-code bootstrap: no global WebSocket available; pass webSocketImpl explicitly (needs Node 22+)',
    );
  }

  const socket: WebSocketLike = new ctor(options.relayUrl);
  try {
    const wrappedAmkWire = await new Promise<string>((resolve, reject) => {
      let awaitingInitializeResult = true;
      const timer = setTimeout(() => {
        reject(
          new ConfigError(
            'AMK recovery-code bootstrap: timed out waiting for the relay — this account may have ' +
              'never escrowed an AMK (SPEC §8 path 2), or the relay is unreachable',
          ),
        );
      }, timeoutMs);

      socket.addEventListener('open', () => {
        const initialize: Initialize = {
          type: 'initialize',
          protocolVersion: PROTOCOL_V1,
          role: 'node',
          authToken: options.authToken,
          deviceId: options.deviceId,
          devicePublicKey: options.devicePublicKey,
        };
        socket.send(JSON.stringify(initialize));
      });

      socket.addEventListener('message', (event: { data: unknown }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (awaitingInitializeResult) {
          awaitingInitializeResult = false;
          const result = initializeResult.safeParse(parsed);
          if (!result.success) {
            clearTimeout(timer);
            reject(new ConfigError('AMK recovery-code bootstrap: relay rejected the handshake'));
            return;
          }
          const request: NewDeviceBootstrapRequest = {
            type: 'new_device_bootstrap_request',
            protocolVersion: PROTOCOL_V1,
            deviceId: options.deviceId,
            devicePublicKey: options.devicePublicKey,
          };
          socket.send(JSON.stringify(request));
          return;
        }

        const response = newDeviceBootstrapResponse.safeParse(parsed);
        if (response.success) {
          clearTimeout(timer);
          resolve(response.data.wrappedAmk);
        }
      });

      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new ConfigError(`AMK recovery-code bootstrap: cannot reach ${options.relayUrl}`));
      });
    });

    const blob = unpackWrappedAmkFromWire(wrappedAmkWire);
    try {
      return await unwrapAmkWithRecoveryCode(blob, options.recoveryCode, options.accountId);
    } catch {
      throw new ConfigError(
        'AMK recovery-code bootstrap: could not unwrap the escrowed AMK — the recovery code ' +
          '(LOOMBOX_RECOVERY_CODE) is wrong, or it does not belong to this account',
      );
    }
  } finally {
    if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
      socket.close();
    }
  }
}

/** What {@link bootstrapAmkFromRecoveryCode} takes and returns, factored out so `main.ts` can inject a stub for tests, mirroring `resolve-account-id.ts`'s `AccountIdResolver`. */
export type AmkBootstrapper = (options: BootstrapAmkFromRecoveryCodeOptions) => Promise<Uint8Array>;
