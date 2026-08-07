import { PROTOCOL_V1, type WireMessageV1 } from '@loombox/protocol';

import { DeviceTokenFileStore } from './device-token-store';
import { NodeIdentityStore } from './identity';
import { RelayConnection, type WebSocketConstructor } from './relay-connection';
import type {
  SupervisorBackend,
  SupervisorBackendActionResult,
  SupervisorBackendUninstallOptions,
} from './supervisor-backend';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

/**
 * Uninstall on the supervisor-backend seam (issue #814, epic #653; decision
 * E1-3: "uninstall removes everything by default, with a keep-data flag").
 * This is the caller-level operation `../supervisor-backend.ts`'s own doc
 * comment describes as deliberately NOT owned by a backend's `uninstall()`
 * itself: {@link SupervisorBackend.uninstall} tears down everything *local*
 * a backend owns (service registration, staged bundle, and — unless
 * `keepData` — this node's own state dir); minting a device token, wrapping
 * an AMK, or revoking a device needs a relay connection and this node's own
 * identity, neither of which a platform supervisor has any business
 * touching. {@link uninstallNode} is that missing caller: it revokes this
 * node's own device on the relay (E1-3's "in both modes: an uninstalled
 * node must never stay pairable"), delegates the local teardown to
 * `options.backend`, and — unless `keepData` — deletes this identity's
 * OS-native keyring cache entry too (`./identity.ts`'s own
 * `forgetOsKeyringEntry`; a plain `rm -rf` of the state dir never reaches
 * it, since the OS keyring is a separate store, not a file underneath).
 *
 * **Revocation is best-effort and always attempted, on purpose.** A local
 * uninstall must never be blocked by an unreachable relay (the same
 * "idempotent, and honest about partials" rule this whole feature is built
 * on) — {@link NodeUninstallResult.deviceRevoked} and `.revokeMessage`
 * report the real outcome separately from the overall `ok`, mirroring
 * `./ssh/decommission.ts`'s own `deviceKeyRevoked` field, so a caller (the
 * desktop app's node row) can still tell the operator "uninstalled, but the
 * device could not be confirmed revoked — check your connection."
 *
 * **What this deliberately does NOT do:** fan the new AMK epoch out to this
 * account's *other* devices (`./supervisor-backend.ts`'s own doc comment on
 * this same gap). Doing that correctly needs an account-scoped
 * device-listing surface this codebase does not have anywhere yet (no
 * `GET /account/devices`, no `DeviceStore.listForAccount` — every existing
 * `device_revoke` call in this codebase, in tests or otherwise, is handed
 * survivors by the caller, never discovers them). A sibling device that is
 * offline at the moment this node is uninstalled falls one epoch behind
 * until that surface exists — a known, pre-existing, accepted gap, not a
 * regression this change introduces.
 */
export interface NodeUninstallRelayOptions {
  relayUrl: string;
  /** This node's own stable device id — the value it registered on the relay with. */
  deviceId: string;
  devicePublicKey: string;
  /** This node's relay-native bearer (`./device-token-store.ts`'s `DeviceTokenFileStore`). */
  authToken: string;
  /** Test-only: overrides the global `WebSocket` `RelayConnection` connects with. */
  webSocketImpl?: WebSocketConstructor;
  /** How long to wait for the handshake to complete before giving up (default 10s). */
  connectTimeoutMs?: number;
  /** How long to wait, after sending `amk_epoch_fetch_request`, for the relay's reply (default 5s) — a relay that never answers is treated as "never rotated" (epoch 0), the same assumption a fresh `main.ts` startup already makes. */
  epochFetchTimeoutMs?: number;
  /** How long to wait, after sending `device_revoke`, for the relay to close this connection — the only observable confirmation `device_revoke` gets (it has no ack of its own; see relay.ts's `closeConnectionsForDevice`) — before giving up on confirming it (default 5s). */
  revokeConfirmTimeoutMs?: number;
}

export interface DeviceRevokeOutcome {
  ok: boolean;
  message: string;
}

/** Resolves `onTimeout` if `promise` hasn't settled within `timeoutMs`; never rejects on its own. */
function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  const { promise: result, resolve } = Promise.withResolvers<T>();
  const timer = setTimeout(() => resolve(onTimeout), timeoutMs);
  promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  });
  return result;
}

/**
 * Revokes `options.deviceId` on `options.relayUrl` for real, over a fresh,
 * short-lived `RelayConnection` — deliberately not a full `NodeDaemon`
 * (which needs a real AMK for session traffic this call never touches).
 * Mints `newEpoch` off `amk_epoch_fetch_response`'s own `pending.epoch`
 * when the relay has one parked for this device, else `0` — the exact
 * "start at 0, catch up from the relay's own pending record" contract
 * `main.ts`'s real node bootstrap already relies on (see this module's own
 * doc comment for the account-wide fan-out gap this inherits, not
 * introduces). Sends `rewrappedAmk: []`: this device revoking itself needs
 * no envelope for itself, and the relay's own schema accepts an empty list
 * (`devices.test.ts`'s "last device revoked" case).
 *
 * `device_revoke` carries no ack of its own — a rejected (stale-epoch)
 * revoke is silently dropped server-side (`relay.ts`'s own comment: "the
 * device stays registered ... rather than silently accepting a wrong epoch
 * number"). The only observable signal is this connection's own socket
 * closing shortly after (revoking a device closes every live connection
 * registered under it — `relay.ts`'s `closeConnectionsForDevice` — and this
 * connection IS that device), so that's what `ok` is actually gated on.
 */
export async function revokeNodeDeviceOnRelay(
  options: NodeUninstallRelayOptions,
): Promise<DeviceRevokeOutcome> {
  const connection = new RelayConnection({
    relayUrl: options.relayUrl,
    deviceId: options.deviceId,
    devicePublicKey: options.devicePublicKey,
    authToken: options.authToken,
    webSocketImpl: options.webSocketImpl,
  });

  try {
    const { promise: openedPromise, resolve: resolveOpened } = Promise.withResolvers<boolean>();
    connection.once('open', () => resolveOpened(true));
    connection.connect();
    const opened = await raceTimeout(openedPromise, options.connectTimeoutMs ?? 10_000, false);
    if (!opened) {
      return {
        ok: false,
        message: `could not reach ${options.relayUrl} within ${options.connectTimeoutMs ?? 10_000}ms; device ${options.deviceId} was NOT revoked`,
      };
    }

    const { promise: epochResponse, resolve: resolveEpochResponse } = Promise.withResolvers<
      number | undefined
    >();
    const onEpochMessage = (message: WireMessageV1): void => {
      if (message.type === 'amk_epoch_fetch_response' && message.deviceId === options.deviceId) {
        connection.off('message', onEpochMessage);
        resolveEpochResponse(message.pending?.epoch);
      }
    };
    connection.on('message', onEpochMessage);
    connection.send({
      type: 'amk_epoch_fetch_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: options.deviceId,
    });
    const currentEpoch =
      (await raceTimeout(epochResponse, options.epochFetchTimeoutMs ?? 5_000, undefined)) ?? 0;
    const newEpoch = currentEpoch + 1;

    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
    connection.once('close', () => resolveClosed());
    connection.send({
      type: 'device_revoke',
      protocolVersion: PROTOCOL_V1,
      deviceId: options.deviceId,
      newEpoch,
      rewrappedAmk: [],
    });
    const confirmed = await raceTimeout(
      closed.then(() => true),
      options.revokeConfirmTimeoutMs ?? 5_000,
      false,
    );

    return confirmed
      ? {
          ok: true,
          message: `device ${options.deviceId} revoked on the relay at epoch ${newEpoch}`,
        }
      : {
          ok: false,
          message: `sent device_revoke for ${options.deviceId} at epoch ${newEpoch}, but the relay never closed this connection to confirm it — most likely a stale epoch guess (this codebase has no account-wide epoch query yet; see this module's own doc comment). Device may still be pairable.`,
        };
  } finally {
    // Idempotent, and cancels any reconnect RelayConnection may have
    // scheduled after an observed close (a just-revoked device would only
    // be rejected again on retry — see `relay.ts`'s own revoked-device
    // check in its `initialize` handler).
    connection.close();
  }
}

export interface NodeUninstallOptions {
  /** The platform's own `SupervisorBackend` (launchd, systemd-over-ssh, or a future local-Linux/Windows one) — never branched on here, exactly per the seam's own contract. */
  backend: SupervisorBackend;
  /** Decision E1-3's explicit opt-out; forwarded to `backend.uninstall` and gates this node's own keyring cleanup identically. */
  keepData?: boolean;
  /** Omit only when there is genuinely no relay to reach (e.g. this node was never fully provisioned) — device revocation is then honestly reported as skipped, never silently assumed. */
  relay?: NodeUninstallRelayOptions;
  /** Injectable for tests; defaults to a real `NodeIdentityStore()` (this machine's default state dir). */
  identityStore?: NodeIdentityStore;
}

export interface NodeUninstallResult {
  /** Whether the LOCAL teardown succeeded — `backend.uninstall`'s own `ok`. Independent of `deviceRevoked`: a local uninstall must never be held hostage by an unreachable relay. */
  ok: boolean;
  deviceRevoked: boolean;
  revokeMessage: string;
  supervisor: SupervisorBackendActionResult;
  /** Whether this identity's OS-native keyring entry was targeted for deletion — always `false` when `keepData` (the entry is left in place, matching the kept state dir it authenticates). */
  keyringCleared: boolean;
  message: string;
}

/** See this module's own doc comment. */
export async function uninstallNode(options: NodeUninstallOptions): Promise<NodeUninstallResult> {
  const revoke = options.relay
    ? await revokeNodeDeviceOnRelay(options.relay)
    : {
        ok: false,
        message:
          'no relay connection configured for this uninstall call; device was NOT revoked — it may still be pairable on the account',
      };

  const uninstallOptions: SupervisorBackendUninstallOptions = { keepData: options.keepData };
  const supervisor = await options.backend.uninstall(uninstallOptions);

  let keyringCleared = false;
  if (!options.keepData) {
    const identityStore = options.identityStore ?? new NodeIdentityStore();
    await identityStore.forgetOsKeyringEntry();
    keyringCleared = true;
  }

  return {
    ok: supervisor.ok,
    deviceRevoked: revoke.ok,
    revokeMessage: revoke.message,
    supervisor,
    keyringCleared,
    message: `${supervisor.message}; ${revoke.message}`,
  };
}

/**
 * Reads this node's own on-disk identity + device token (`./identity.ts`'s
 * `NodeIdentityStore`, `./device-token-store.ts`'s `DeviceTokenFileStore`)
 * and resolves them into {@link NodeUninstallOptions.relay} — the one-call
 * path a real caller (the desktop app's Electron main process, on the same
 * machine as the local node it's uninstalling) actually uses, so it never
 * has to know either file's shape itself. Returns `undefined` when either
 * is missing (this node was never fully provisioned, e.g. `install()`
 * failed before pairing) — nothing to revoke, not a partial-state error.
 */
export async function resolveNodeUninstallRelayOptions(options: {
  relayUrl: string;
  /** This node's own device id; defaults to `nodeId` (`./local/provision-local-node.ts`'s own convention). */
  deviceId: string;
  stateDir?: string;
  webSocketImpl?: WebSocketConstructor;
}): Promise<NodeUninstallRelayOptions | undefined> {
  const stateDir = options.stateDir ?? defaultNodeStateDir();
  const identity = await new NodeIdentityStore({ stateDir }).load();
  const authToken = new DeviceTokenFileStore({ stateDir }).load();
  if (!identity || !authToken) return undefined;

  return {
    relayUrl: options.relayUrl,
    deviceId: options.deviceId,
    devicePublicKey: identity.publicKeyBase64,
    authToken,
    webSocketImpl: options.webSocketImpl,
  };
}
