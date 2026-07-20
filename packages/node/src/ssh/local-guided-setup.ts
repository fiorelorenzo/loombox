import { createNode, type NodeDaemon, type NodeDaemonOptions } from '../node-daemon';
import { NodeIdentityStore } from '../identity';
import type { WebSocketConstructor } from '../relay-connection';

/**
 * The common **local-only** first-run flow (issue #91; SPEC §7.23's "First
 * run without SSH": "point at an existing relay or self-host one with a
 * single command, auto-register the node, and start a first local session —
 * not only the `ssh:` flow above"). No SSH configuration is touched at any
 * point.
 *
 * There is no separate "registration" call in this protocol: `RelayConnection`
 * (`../relay-connection.ts`) already sends an `initialize` handshake — role
 * `'node'`, this device's identity and auth token — as the first frame of
 * every connection, and the relay accepting it back with `initialize_result`
 * *is* this node registering itself. So `register_node` below is simply
 * "build the `NodeDaemon` against the configured relay URL and wait for that
 * handshake to complete" — reusing `NodeDaemon.whenConnected()` rather than
 * inventing a second registration primitive.
 *
 * "Point at an existing relay or self-host one" is deliberately just
 * `relayUrl: string` here: whether that URL belongs to someone else's relay
 * or one the caller just spun up locally (e.g. via `@loombox/relay`'s own
 * `startRelay`/CLI, a separate package this one doesn't depend on at
 * runtime) makes no difference to this flow — it only ever needs a URL to
 * connect to.
 */
export type GuidedSetupStepId = 'configure_relay' | 'register_node' | 'start_first_session';

export interface GuidedSetupStepResult {
  step: GuidedSetupStepId;
  ok: boolean;
  message: string;
}

export interface LocalGuidedSetupOptions {
  /** The relay's ws:// (or wss://) URL — existing or freshly self-hosted, this flow doesn't care which. */
  relayUrl: string;
  nodeId: string;
  /** Defaults to `nodeId` (a guided-setup node is a single device), matching `NodeCliConfig`'s own convention (`../config.ts`). */
  deviceId?: string;
  authToken: string;
  /** Defaults to `authToken` (see `NodeDaemonOptions.accountId`'s doc comment for why those currently must match). */
  accountId?: string;
  amk: Uint8Array;
  stateDir?: string;
  webSocketImpl?: WebSocketConstructor;
  /** Absolute path to a local git repository — the first local-target session this flow starts runs against it. */
  projectPath: string;
  provider?: string;
  title?: string;
  /** How long to wait for the relay handshake before failing the `register_node` step; defaults to 10000ms. */
  connectTimeoutMs?: number;
  /** Injectable for tests: overrides how the `NodeDaemon` is constructed (e.g. to register a fixture provider on its supervisor); defaults to `createNode` (`../node-daemon.ts`). */
  nodeFactory?: (options: NodeDaemonOptions) => NodeDaemon;
  /** Injectable for tests: overrides identity load/create; defaults to a fresh `NodeIdentityStore({ stateDir })`. */
  identityStore?: Pick<NodeIdentityStore, 'loadOrCreate'>;
}

export interface LocalGuidedSetupResult {
  ok: boolean;
  /** Every step attempted, in order, each carrying its own outcome — issue #91's "testable without a UI (return the step results)". Stops at the first failed step; later steps are simply absent, not reported as skipped. */
  steps: GuidedSetupStepResult[];
  /**
   * The `NodeDaemon` this flow managed to construct, if any — set as soon as
   * `register_node` is attempted (even if that step itself fails), left
   * connected/undisposed on any failure so a caller can inspect or retry
   * rather than this flow silently discarding it. `undefined` only when
   * `configure_relay` itself failed (nothing was ever constructed).
   */
  node: NodeDaemon | undefined;
  sessionId: string | undefined;
}

function delay(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the guided flow end to end, returning every step's outcome rather
 * than throwing past a failure — a caller (a CLI's prompt sequence, or a
 * test) reads `result.steps`/`result.ok` to know exactly how far it got.
 */
export async function runLocalGuidedSetup(
  options: LocalGuidedSetupOptions,
): Promise<LocalGuidedSetupResult> {
  const steps: GuidedSetupStepResult[] = [];
  const relayUrl = options.relayUrl.trim();

  if (!relayUrl) {
    steps.push({
      step: 'configure_relay',
      ok: false,
      message: 'no relay URL provided — point at an existing relay or self-host one first',
    });
    return { ok: false, steps, node: undefined, sessionId: undefined };
  }
  steps.push({ step: 'configure_relay', ok: true, message: `using relay ${relayUrl}` });

  let node: NodeDaemon | undefined;
  try {
    const identityStore =
      options.identityStore ?? new NodeIdentityStore({ stateDir: options.stateDir });
    const identity = await identityStore.loadOrCreate();

    const nodeFactory = options.nodeFactory ?? createNode;
    node = nodeFactory({
      relayUrl,
      nodeId: options.nodeId,
      deviceId: options.deviceId ?? options.nodeId,
      devicePublicKey: identity.publicKeyBase64,
      authToken: options.authToken,
      accountId: options.accountId ?? options.authToken,
      amk: options.amk,
      stateDir: options.stateDir,
      webSocketImpl: options.webSocketImpl,
    });

    await Promise.race([
      node.whenConnected(),
      delay(
        options.connectTimeoutMs ?? 10_000,
        `timed out waiting for relay ${relayUrl} to accept this node's registration`,
      ),
    ]);
    steps.push({
      step: 'register_node',
      ok: true,
      message: `registered node "${options.nodeId}" with ${relayUrl}`,
    });
  } catch (error) {
    steps.push({ step: 'register_node', ok: false, message: errorMessage(error) });
    return { ok: false, steps, node, sessionId: undefined };
  }

  try {
    const session = await node.createSession({
      projectPath: options.projectPath,
      provider: options.provider,
      title: options.title,
    });
    steps.push({
      step: 'start_first_session',
      ok: true,
      message: `started session ${session.id} on the local target`,
    });
    return { ok: true, steps, node, sessionId: session.id };
  } catch (error) {
    steps.push({ step: 'start_first_session', ok: false, message: errorMessage(error) });
    return { ok: false, steps, node, sessionId: undefined };
  }
}
