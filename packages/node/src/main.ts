import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { bootstrapAmkFromRecoveryCode, type AmkBootstrapper } from './amk-bootstrap';
import { wireAmkEpochAdoption } from './amk-epoch';
import { adoptWrappedAmkFromFile, type AdoptWrappedAmkFileOptions } from './amk-handoff-file';
import {
  ConfigError,
  loadNodeConfig,
  type LoadNodeConfigOptions,
  type NodeCliConfig,
} from './config';
import { DeviceTokenFileStore } from './device-token-store';
import { runDeviceLogin, type DeviceLoginResult, type RunDeviceLoginOptions } from './device-login';
import type { NodeIdentity } from './identity';
import { NodeIdentityStore } from './identity';
import { createNode, type NodeDaemon } from './node-daemon';
import { resolveAccountIdViaRelay, type AccountIdResolver } from './resolve-account-id';
import { DEFAULT_LOCAL_TARGET } from './target';
import type { WebSocketConstructor } from './relay-connection';

/** Runs the device-authorization login flow (issue #387). Injected as `StartOptions.runDeviceLogin` so tests never have to drive a real operator-approval round trip; production defaults to {@link runDeviceLogin} itself. */
export type DeviceLoginRunner = (options: RunDeviceLoginOptions) => Promise<DeviceLoginResult>;

/** Reads, unwraps, adopts, and deletes the one-shot wrapped-AMK handoff file (issue #399). Injected as `StartOptions.adoptWrappedAmkFile` so tests never need a real provisioner-written file on disk; production defaults to {@link adoptWrappedAmkFromFile}. */
export type WrappedAmkFileAdopter = (options: AdoptWrappedAmkFileOptions) => Promise<Uint8Array>;

export interface StartOptions extends LoadNodeConfigOptions {
  /** Test-only: overrides the global `WebSocket` `NodeDaemon` connects with. Never set in production. */
  webSocketImpl?: WebSocketConstructor;
  /**
   * Resolves this node's `accountId` from its bearer token when the config
   * doesn't set one explicitly (`LOOMBOX_ACCOUNT_ID`/the config file's
   * `accountId`) — issue #380. Defaults to {@link resolveAccountIdViaRelay},
   * a real HTTP call against the relay's Better Auth. Tests inject a stub so
   * they never need a real Better Auth login flow just to start a node.
   */
  resolveAccountId?: AccountIdResolver;
  /**
   * Recovers this node's AMK from `config.recoveryCode` when the config
   * doesn't provide a raw `amk` override — issue #386. Defaults to
   * {@link bootstrapAmkFromRecoveryCode}, the real relay-backed
   * implementation. Tests inject a stub so they never need a real escrow
   * round-trip just to start a node.
   */
  bootstrapAmk?: AmkBootstrapper;
  /**
   * Reads, unwraps, adopts, and deletes the one-shot wrapped-AMK handoff
   * file (`config.recoveryCode`'s sibling for zero-touch SSH provisioning
   * — issue #399) when the config provides `wrappedAmkFilePath`
   * (`LOOMBOX_WRAPPED_AMK_FILE`) instead of a raw `amk` override. Defaults
   * to {@link adoptWrappedAmkFromFile}, the real file-based implementation.
   * Tests inject a stub so they never need a real provisioner-written file
   * on disk just to start a node.
   */
  adoptWrappedAmkFile?: WrappedAmkFileAdopter;
  /**
   * Recovers this node's bearer token via the device-authorization grant
   * when neither `LOOMBOX_AUTH_TOKEN` nor `LOOMBOX_DEVICE_TOKEN` is
   * configured and no token is already persisted on disk (issue #387).
   * Defaults to {@link runDeviceLogin}, the real relay-backed
   * implementation. Tests inject a stub so they never need a real
   * operator-approval round trip just to start a node.
   */
  runDeviceLogin?: DeviceLoginRunner;
}

/**
 * Resolves the AMK a starting node hands `createNode()` (issues #386, #399),
 * in precedence order: a raw `config.amk` override wins outright
 * (tests/advanced use, see `NodeCliConfig.amk`'s doc comment); otherwise a
 * `config.wrappedAmkFilePath` one-shot handoff file (issue #399's zero-touch
 * SSH-provisioning path) is read/unwrapped/adopted/deleted via
 * `adoptWrappedAmkFile`; otherwise it's recovered from
 * `config.recoveryCode` via `bootstrapAmk` (real relay round-trip by
 * default). `loadNodeConfig` already guarantees at least one of the three is
 * set — the `ConfigError` below is an unreachable defensive fallback, not a
 * path a caller can actually hit.
 */
async function resolveAmk(
  config: NodeCliConfig,
  identity: NodeIdentity,
  accountId: string,
  authToken: string,
  bootstrapAmk: AmkBootstrapper,
  webSocketImpl: WebSocketConstructor | undefined,
  adoptWrappedAmkFile: WrappedAmkFileAdopter,
): Promise<Uint8Array> {
  if (config.amk) return config.amk;
  if (config.wrappedAmkFilePath) {
    return adoptWrappedAmkFile({
      filePath: config.wrappedAmkFilePath,
      accountId,
      targetDeviceId: config.deviceId,
      identity,
    });
  }
  if (!config.recoveryCode) {
    throw new ConfigError(
      'amk (LOOMBOX_AMK), wrappedAmkFilePath (LOOMBOX_WRAPPED_AMK_FILE), or recoveryCode ' +
        '(LOOMBOX_RECOVERY_CODE) is required',
    );
  }
  return bootstrapAmk({
    relayUrl: config.relayUrl,
    accountId,
    authToken,
    deviceId: config.deviceId,
    devicePublicKey: identity.publicKeyBase64,
    recoveryCode: config.recoveryCode,
    webSocketImpl,
  });
}

/**
 * Resolves the concrete bearer token this node connects with (issue #387):
 * an explicit `config.authToken` (Better Auth session bearer, legacy/
 * advanced) or `config.deviceToken` (supplied directly via
 * `LOOMBOX_DEVICE_TOKEN`) wins outright. Otherwise, a device token
 * previously persisted by a prior run's device-login is reused
 * (`DeviceTokenFileStore`, scoped to `config.stateDir` exactly like
 * `NodeIdentityStore`) — "if a token already exists, skip login". Only when
 * NONE of those apply does this actually run the interactive
 * device-authorization flow (`deviceLogin`), then persist whatever it
 * returns so the next restart skips straight to the reuse path above.
 */
async function resolveAuthToken(
  config: NodeCliConfig,
  deviceLogin: DeviceLoginRunner,
): Promise<string> {
  if (config.authToken) return config.authToken;
  if (config.deviceToken) return config.deviceToken;

  const tokenStore = new DeviceTokenFileStore({ stateDir: config.stateDir });
  const existing = tokenStore.load();
  if (existing) return existing;

  const { accessToken } = await deviceLogin({ relayUrl: config.relayUrl });
  tokenStore.save(accessToken);
  return accessToken;
}

export interface StartedNode {
  node: NodeDaemon;
  nodeId: string;
  /** This node's stable E2E device public key (base64), as reused/generated by `identity.ts`'s `NodeIdentityStore` (issue #64) — the same value across restarts as long as `stateDir` (and thus the persisted identity file) doesn't change. */
  devicePublicKey: string;
  /**
   * Closes the relay connection and every session's agent, once. Safe to
   * call more than once (subsequent calls are a no-op) — matters because
   * both a delivered signal and a caller's own cleanup path may race to call
   * it.
   */
  stop: () => Promise<void>;
}

/**
 * Runnable entry point for a v1 node daemon (SPEC §5.1; issue #63): loads
 * config from env/an optional file ({@link loadNodeConfig}), reuses this
 * node's persisted E2E identity keypair (`identity.ts`'s `NodeIdentityStore`,
 * issue #64 — generated on first run, reloaded on every restart after),
 * builds a `NodeDaemon`, and connects it to the relay. Mirrors
 * `packages/relay/src/main.ts`'s shape (a plain async `start()`, guarded by
 * the same `isMainModule` check below).
 *
 * Never hardcodes a secret: every credential (`authToken`, the AMK) comes
 * from `loadNodeConfig`, which itself only ever reads env vars or a config
 * file the operator provides.
 *
 * `accountId` itself is never defaulted from `authToken` (issue #380 — that
 * stale pre-Better-Auth stand-in made a live relay silently drop every
 * session, since the relay independently resolves the *real* accountId from
 * the same bearer token and only accepts sessions whose claimed accountId
 * matches). When `loadNodeConfig` doesn't return an explicit one, it's
 * resolved here via `resolveAccountId` (real Better Auth `getSession` by
 * default) — which throws rather than let this node start up scoped to the
 * wrong account.
 *
 * The account AMK itself (issues #386, #399) comes from `resolveAmk`, in
 * precedence order: `config.amk` (`LOOMBOX_AMK`) as an explicit raw override
 * for tests/advanced use; else `config.wrappedAmkFilePath`
 * (`LOOMBOX_WRAPPED_AMK_FILE`) via `adoptWrappedAmkFile` — the zero-touch
 * SSH-provisioning handoff (issue #399), reading the one-shot file a
 * provisioner wrote and unwrapping it with this node's own device private
 * key; else `config.recoveryCode` via `bootstrapAmk` — the recovery-code
 * bootstrap against the relay's escrow, the same crypto path `apps/web`
 * drives. Never hand-pasted on the happy path.
 *
 * The bearer token itself (issue #387) comes from `resolveAuthToken`: an
 * explicit `LOOMBOX_AUTH_TOKEN`/`LOOMBOX_DEVICE_TOKEN`, a previously
 * persisted device token, or — only if none of those exist — the
 * device-authorization login flow (`deviceLogin`), which prints a code for
 * the operator to approve in a browser and prints/persists the resulting
 * token once approved.
 */
export async function start(options: StartOptions = {}): Promise<StartedNode> {
  const config = loadNodeConfig(options);

  const deviceLogin = options.runDeviceLogin ?? runDeviceLogin;
  const authToken = await resolveAuthToken(config, deviceLogin);

  const resolveAccountId = options.resolveAccountId ?? resolveAccountIdViaRelay;
  const accountId = config.accountId ?? (await resolveAccountId(config.relayUrl, authToken));

  const identityStore = new NodeIdentityStore({ stateDir: config.stateDir });
  const identity = await identityStore.loadOrCreate();

  const bootstrapAmk = options.bootstrapAmk ?? bootstrapAmkFromRecoveryCode;
  const adoptWrappedAmkFile = options.adoptWrappedAmkFile ?? adoptWrappedAmkFromFile;
  const amk = await resolveAmk(
    config,
    identity,
    accountId,
    authToken,
    bootstrapAmk,
    options.webSocketImpl,
    adoptWrappedAmkFile,
  );

  const node = createNode({
    relayUrl: config.relayUrl,
    nodeId: config.nodeId,
    deviceId: config.deviceId,
    devicePublicKey: identity.publicKeyBase64,
    authToken,
    accountId,
    amk,
    targets: config.targets,
    sshTargets: config.sshTargets,
    // Same convention as `identityStore` above: MCP config/secret storage
    // (issues #187/#189) honors `LOOMBOX_NODE_STATE_DIR` too, rather than
    // silently defaulting to `~/.loombox/node` regardless of what the
    // identity keypair itself was configured to use.
    stateDir: config.stateDir,
    webSocketImpl: options.webSocketImpl,
  });

  // #116: this node holds `identity`'s private key (this module's own
  // `NodeIdentityStore`, never handed into `NodeDaemon` itself — see that
  // class's doc comment), so it's the one place that can actually unwrap a
  // pending rewrapped-AMK-epoch envelope the daemon surfaces via
  // `'amk-epoch-pending'`.
  wireAmkEpochAdoption(node, identity, accountId, config.deviceId);

  const targetIds = (config.targets ?? [DEFAULT_LOCAL_TARGET]).map((target) => target.id);
  console.log(
    `loombox node "${config.nodeId}": connecting to ${config.relayUrl} (targets: ${targetIds.join(', ')})`,
  );
  node.on('connected', () => {
    console.log(`loombox node "${config.nodeId}": connected`);
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.log(`loombox node "${config.nodeId}": shutting down`);
    node.close();
  };

  return { node, nodeId: config.nodeId, devicePublicKey: identity.publicKeyBase64, stop };
}

export interface GracefulShutdownOptions {
  /** Defaults to `['SIGTERM', 'SIGINT']`. */
  signals?: NodeJS.Signals[];
  /**
   * If `stop()` hasn't settled within this many ms, force-exit with code 1
   * rather than hang forever on a wedged close path. The timer is
   * `unref()`'d, so it never itself keeps the process alive. Defaults to
   * 5000.
   */
  forceExitAfterMs?: number;
}

/**
 * Wires `signals` (SIGTERM/SIGINT by default) to `stop`, so a delivered
 * signal closes the relay connection and every session's agent before the
 * process exits (issue #63's "SIGTERM/SIGINT triggers a graceful
 * shutdown"). Deliberately never calls `process.exit()` on the happy path:
 * once `stop()` resolves (`NodeDaemon.close()` clears every timer and closes
 * every socket), nothing keeps the event loop alive and Node exits on its
 * own — an explicit `exit()` risks cutting off any not-yet-flushed I/O.
 * `forceExitAfterMs` is only a backstop for a `stop()` that never settles.
 */
export function installGracefulShutdown(
  stop: () => Promise<void>,
  options: GracefulShutdownOptions = {},
): void {
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const forceExitAfterMs = options.forceExitAfterMs ?? 5000;

  for (const signal of signals) {
    process.once(signal, () => {
      console.log(`loombox node: received ${signal}, shutting down gracefully`);
      const forceExitTimer = setTimeout(() => {
        console.error('loombox node: graceful shutdown timed out; forcing exit');
        process.exit(1);
      }, forceExitAfterMs);
      forceExitTimer.unref();

      stop()
        .then(() => clearTimeout(forceExitTimer))
        .catch((error: unknown) => {
          clearTimeout(forceExitTimer);
          console.error('loombox node: error during shutdown', error);
          process.exitCode = 1;
        });
    });
  }
}

/** `start()` plus signal wiring — what actually runs when this module is executed directly (see the `isMainModule` guard below). */
export async function run(options: StartOptions = {}): Promise<StartedNode> {
  const started = await start(options);
  installGracefulShutdown(started.stop);
  return started;
}

const isMainModule = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (isMainModule) {
  run().catch((error: unknown) => {
    console.error('loombox node failed to start', error);
    process.exitCode = 1;
  });
}
