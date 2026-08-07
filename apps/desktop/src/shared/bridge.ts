import type { UpdaterStatus } from '../main/updater';

/**
 * The typed IPC bridge contract between the Electron main process (which has
 * the native powers a sandboxed PWA lacks) and the renderer (the loombox PWA
 * itself, loaded into the `BrowserWindow` — see `../main/window.ts`).
 *
 * This file is imported by BOTH sides so they can never drift: the preload
 * script (`../preload/index.ts`) implements {@link LoomboxBridgeApi} against
 * these exact request/response shapes over `ipcRenderer.invoke`, and the
 * main process (`../main/ipc/handlers.ts`) registers an `ipcMain.handle` for
 * every {@link BridgeChannel} with a matching signature. Every type here is
 * plain, structured-cloneable data (issue #403) — no functions, no live
 * objects — because that is all `ipcRenderer.invoke`/`ipcMain.handle` can
 * actually carry across the process boundary.
 */

/** One channel name per bridge method, namespaced so they never collide with any other `ipcMain.handle` a future feature registers. */
export const BRIDGE_CHANNELS = {
  listSshHostCandidates: 'loombox:listSshHostCandidates',
  provisionTarget: 'loombox:provisionTarget',
  provisionLocalNode: 'loombox:provisionLocalNode',
  uninstallLocalNode: 'loombox:uninstallLocalNode',
  spawnLocalNode: 'loombox:spawnLocalNode',
  stopLocalNode: 'loombox:stopLocalNode',
  status: 'loombox:status',
  checkForUpdate: 'loombox:checkForUpdate',
  applyUpdate: 'loombox:applyUpdate',
} as const;

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[keyof typeof BRIDGE_CHANNELS];

// ---------------------------------------------------------------------------
// listSshHostCandidates — SPEC §7.23 step 1 ("just choose a host"), the
// add-target wizard's autodetect-from-~/.ssh/config step. `@loombox/node`
// already owns this logic (`src/ssh/host-candidates.ts`'s
// `discoverSshTargets`), but it is not yet part of that package's public
// `index.ts` surface this app is allowed to import (issue #403 is scoped to
// apps/desktop only) — TODO: once a follow-up exports it, wire this bridge
// method straight to it instead of the stub in `../main/ssh-candidates.ts`.
// ---------------------------------------------------------------------------

/** Shape mirrors `@loombox/node`'s (currently package-internal) `SshHostCandidate` one-for-one, so wiring the real implementation later is a body swap, not a contract change. */
export interface SshHostCandidate {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFiles: string[];
}

export interface ListSshHostCandidatesResult {
  candidates: SshHostCandidate[];
  /** `true` when there is nothing to offer at all — the add-target wizard's cue to fall back to manual entry (mirrors `@loombox/node`'s `SshTargetDiscovery.requiresManualEntry`). */
  requiresManualEntry: boolean;
}

// ---------------------------------------------------------------------------
// provisionTarget — drives `@loombox/node`'s `provision()` (issue #400) for
// real (see `../main/provisioning/provision-target-bridge.ts`). The request
// below is the plain-data subset of `@loombox/node`'s `ProvisionOptions` an
// IPC caller can actually supply (no `transportFactory`/`onProgress`
// functions — those can't cross the IPC boundary; the main process supplies
// its own). It deliberately does NOT yet carry a minted token or handed-off
// AMK (issues #398/#399) or the single in-app confirmation this flow is
// meant to sit behind — those land in a follow-up once #398/#399 exist.
// ---------------------------------------------------------------------------

/** Mirrors `@loombox/node`'s exported `SshTargetConfig` (`target.ts`) field-for-field. */
export interface ProvisionTargetSshConfig {
  id: string;
  label: string;
  host: string;
  user?: string;
  port?: number;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  agent?: string | false;
}

export interface ProvisionTargetRequest {
  target: ProvisionTargetSshConfig;
  /** Mirrors `ProvisionOptions.runtime.skip`. */
  skipRuntimeBootstrap?: boolean;
  /** Mirrors `ProvisionOptions.residentNode.skip`. */
  skipResidentNode?: boolean;
}

export type ProvisionStepId =
  'verify_and_persist' | 'runtime_bootstrap' | 'supervisor_install' | 'resident_node_install';

/** A flattened, renderer-friendly projection of `@loombox/node`'s per-step result union — enough for a progress log/UI, without carrying that package's richer (and not-yet-public) step payload types across the IPC boundary. */
export interface ProvisionProgressStep {
  step: ProvisionStepId;
  ok: boolean;
  message: string;
}

export interface ProvisionTargetResult {
  ok: boolean;
  targetId: string;
  steps: ProvisionProgressStep[];
  failedStep?: ProvisionStepId;
  /**
   * Set when this bridge could not even attempt `provision()` because its
   * own prerequisites (a signed supervisor-release artifact source + the
   * mint-token/AMK-handoff config from #398/#399) are not wired yet in this
   * scaffold — distinct from `ok: false`, which means `provision()` ran for
   * real and a step genuinely failed. See `provision-target-bridge.ts`.
   */
  notConfigured?: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// provisionLocalNode — drives `@loombox/node`'s `provisionLocalNode()`
// (issue #654) for real (see `../main/provisioning/provision-local-node-
// bridge.ts`), the macOS-local counterpart to `provisionTarget` above: no
// ssh: target, no `SshTargetConfig` — this machine IS the node. The
// version-to-install / where-to-fetch-it / which `SupervisorBackend`
// (launchd) halves are resolved for real by that bridge module (decision
// A1-2 + issue #817 unblocked it); `actingAuthToken`/`amkBase64` below are
// NOT resolved by this app — they come from the renderer's own
// already-unlocked account session (decision D1-1: the desktop app, i.e.
// this same PWA loaded into Electron, is the only install surface), which
// is the one piece still unwired end to end (see this issue's PR notes).
// `amkBase64` crosses the IPC boundary base64-encoded, never a live
// `Uint8Array` — `ipcRenderer.invoke` only carries structured-cloneable
// plain data.
// ---------------------------------------------------------------------------

export interface ProvisionLocalNodeRequest {
  relayUrl: string;
  accountId: string;
  /** This renderer's own already-unlocked bearer token — a Better Auth session token or an existing device token; used to mint the new resident node's token. */
  actingAuthToken: string;
  /** The account's currently-unlocked AMK, base64-encoded. */
  amkBase64: string;
  amkEpoch?: number;
  nodeId: string;
  /** Defaults to `nodeId` on the main-process side. */
  deviceId?: string;
  tokenLabel?: string;
  claudeCodeOAuthToken?: string;
}

export type LocalProvisionStepId =
  | 'runtime_bootstrap'
  | 'target_identity'
  | 'mint_node_token'
  | 'amk_handoff'
  | 'resident_node_install';

/** A flattened, renderer-friendly projection of `@loombox/node`'s per-step progress union — mirrors `ProvisionProgressStep` above, but with `status` (`'started' | 'ok' | 'failed'`) instead of a plain `ok` boolean, matching `provisionLocalNode`'s own richer progress shape (it streams a `'started'` event too, not just the terminal outcome). */
export interface LocalProvisionProgressStep {
  step: LocalProvisionStepId;
  status: 'started' | 'ok' | 'failed';
  message: string;
}

export interface ProvisionLocalNodeResult {
  ok: boolean;
  progress: LocalProvisionProgressStep[];
  failedStep?: LocalProvisionStepId;
  deviceId?: string;
  nodeId?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// spawnLocalNode / stopLocalNode — supervises a `@loombox/node` process
// running locally on this Mac (the "run a node right here" alternative to
// SSH-provisioning a remote one). The child-process management itself
// (`../main/local-node/process-manager.ts`) is real; resolving what command
// to launch it with (the built `@loombox/node` CLI entry + its required
// env — relay URL, node/device id, auth token, AMK) is TODO, tracked by the
// same #398/#399 dependency as `provisionTarget` above.
// ---------------------------------------------------------------------------

export interface SpawnLocalNodeRequest {
  /** Extra environment variables merged over the spawned process's own environment (e.g. an explicit `LOOMBOX_RELAY_URL` override for local dev). */
  env?: Record<string, string>;
}

export type LocalNodeStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface SpawnLocalNodeResult {
  status: LocalNodeStatus;
  pid?: number;
  /** Set when `status` is `'stopped'` because this bridge has no launch command configured yet (see this section's doc comment) rather than because the process was asked to stop. */
  notConfigured?: boolean;
  message?: string;
}

export interface StopLocalNodeResult {
  status: LocalNodeStatus;
}

// ---------------------------------------------------------------------------
// uninstallLocalNode — drives `@loombox/node`'s `uninstallNode()` (issue
// #814) for real (see `../main/provisioning/uninstall-local-node-bridge
// .ts`), the counterpart to `provisionLocalNode` above: revokes this
// machine's resident node on the relay (decision E1-3, "in both modes"),
// then tears down the local install through the same platform
// `SupervisorBackend` `provisionLocalNode` used to set it up. Reads this
// node's own already-on-disk identity + device token itself (main-process
// side) — unlike `provisionLocalNode`, this never needs a renderer-supplied
// auth token or AMK, since it authenticates as the resident node it is
// tearing down, not as the operator's own account session.
// ---------------------------------------------------------------------------

export interface UninstallLocalNodeRequest {
  relayUrl: string;
  /** This node's own id, exactly as shown in its `TargetStatusView` row (`TargetListEntry.nodeId`). */
  nodeId: string;
  /** Defaults to `nodeId` on the main-process side, mirroring `ProvisionLocalNodeRequest.deviceId`'s own convention. */
  deviceId?: string;
  /** Decision E1-3's explicit opt-out; the device is revoked on the relay either way. */
  keepData?: boolean;
}

export interface UninstallLocalNodeResult {
  /** Whether the local teardown (unit, versioned bundle, and — unless `keepData` — the state dir + keyring entry) succeeded. Independent of `deviceRevoked`: see that field's own doc comment. */
  ok: boolean;
  /** Whether the device was confirmed revoked on the relay — `false` doesn't block `ok`, but the caller should say so plainly (an uninstalled-but-not-revoked node is still pairable). */
  deviceRevoked: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// status — a snapshot the renderer polls (or requests on demand) to render
// the tray/menubar's own state without duplicating it.
// ---------------------------------------------------------------------------

export interface BridgeStatus {
  appVersion: string;
  launchAtLogin: boolean;
  localNode: {
    status: LocalNodeStatus;
    pid?: number;
  };
  /** The desktop shell's own self-update state (issue #657), from `../main/updater.ts`'s `UpdateController.getState()` — always present (an idle controller reports `{ status: 'idle' }`, mirroring `localNode` always being present here too). */
  update: UpdateCheckResult;
}

// ---------------------------------------------------------------------------
// checkForUpdate / applyUpdate — the desktop shell's own self-update (issue
// #657), via `../main/updater.ts`'s electron-updater wiring. Two separate
// actions, matching the epic's own consent requirement (#653's "Out of
// scope: auto-updating without consent"): checkForUpdate only ever asks
// whether a newer build exists; applyUpdate is the one explicit,
// user-initiated action that downloads AND installs, then restarts. Both
// return the resulting snapshot rather than void, so a caller can render
// the outcome without a separate status() round trip.
// ---------------------------------------------------------------------------

/** Mirrors `../main/updater.ts`'s `UpdaterState` — a plain-data projection with no Electron/electron-updater types crossing the IPC boundary. */
export interface UpdateCheckResult {
  status: UpdaterStatus;
  version?: string;
  error?: string;
}

/**
 * The typed API surface the preload script exposes as `window.loombox` in
 * the renderer. Defined once here so `../preload/index.ts` (the
 * implementation) and any renderer code that calls it are checked against
 * the exact same method signatures.
 */
export interface LoomboxBridgeApi {
  listSshHostCandidates(): Promise<ListSshHostCandidatesResult>;
  provisionTarget(request: ProvisionTargetRequest): Promise<ProvisionTargetResult>;
  provisionLocalNode(request: ProvisionLocalNodeRequest): Promise<ProvisionLocalNodeResult>;
  uninstallLocalNode(request: UninstallLocalNodeRequest): Promise<UninstallLocalNodeResult>;
  spawnLocalNode(request?: SpawnLocalNodeRequest): Promise<SpawnLocalNodeResult>;
  stopLocalNode(): Promise<StopLocalNodeResult>;
  status(): Promise<BridgeStatus>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  applyUpdate(): Promise<UpdateCheckResult>;
}

declare global {
  interface Window {
    /** Present only inside the desktop app's `BrowserWindow` (this preload's `contextBridge.exposeInMainWorld`); `undefined` in a plain browser tab, which the PWA uses as its "am I running inside the desktop shell" check. */
    loombox?: LoomboxBridgeApi;
  }
}
