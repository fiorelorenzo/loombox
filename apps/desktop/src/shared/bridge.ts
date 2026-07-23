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
  spawnLocalNode: 'loombox:spawnLocalNode',
  stopLocalNode: 'loombox:stopLocalNode',
  status: 'loombox:status',
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
  spawnLocalNode(request?: SpawnLocalNodeRequest): Promise<SpawnLocalNodeResult>;
  stopLocalNode(): Promise<StopLocalNodeResult>;
  status(): Promise<BridgeStatus>;
}

declare global {
  interface Window {
    /** Present only inside the desktop app's `BrowserWindow` (this preload's `contextBridge.exposeInMainWorld`); `undefined` in a plain browser tab, which the PWA uses as its "am I running inside the desktop shell" check. */
    loombox?: LoomboxBridgeApi;
  }
}
