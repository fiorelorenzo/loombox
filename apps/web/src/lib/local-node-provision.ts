/**
 * The macOS-local resident node provisioning trigger (issue #654, decision
 * D1-1: "the desktop app is the only install surface"). `@loombox/node`'s
 * `provisionLocalNode()` runs entirely inside the desktop app's Electron
 * main process (`apps/desktop/src/main/provisioning/provision-local-node-
 * bridge.ts`, reached over `window.loombox.provisionLocalNode`) — this
 * module is the renderer-side half: it generates the one thing the main
 * process has no business minting itself (this new node's own id) and
 * base64-encodes the AMK for the IPC hop (`ipcRenderer.invoke` only
 * carries structured-cloneable plain data, never a live `Uint8Array`).
 *
 * A minimal duck-typed bridge shape declared locally rather than importing
 * `apps/desktop`'s own bridge types — see `AddTargetWizard.svelte`'s
 * `DesktopSshBridge`/`getDesktopBridge` for the identical reasoning (this
 * app's dependency graph stays one-directional: the desktop app depends on
 * this app's build output, never the other way around).
 */

export type LocalProvisionStepId =
  | 'runtime_bootstrap'
  | 'target_identity'
  | 'mint_node_token'
  | 'amk_handoff'
  | 'resident_node_install';

export interface LocalProvisionProgressStep {
  step: LocalProvisionStepId;
  status: 'started' | 'ok' | 'failed';
  message: string;
}

export interface ProvisionLocalNodeOutcome {
  ok: boolean;
  progress: LocalProvisionProgressStep[];
  failedStep?: LocalProvisionStepId;
  deviceId?: string;
  nodeId?: string;
  message?: string;
}

interface DesktopLocalNodeBridge {
  provisionLocalNode: (request: {
    relayUrl: string;
    accountId: string;
    actingAuthToken: string;
    amkBase64: string;
    amkEpoch?: number;
    nodeId: string;
    deviceId?: string;
    tokenLabel?: string;
    claudeCodeOAuthToken?: string;
  }) => Promise<ProvisionLocalNodeOutcome>;
}

/**
 * `window`, widened to admit the desktop preload's own `loombox` global —
 * a one-time, named cast (never inlined into a property read) because
 * nothing short of the real preload script (`apps/desktop/src/preload/
 * index.ts`, a different app entirely) could prove this shape to the
 * compiler; `'loombox' in window` plus `typeof …provisionLocalNode ===
 * 'function'` below are the actual runtime checks that back it up before
 * anything on it is ever called.
 */
type WindowWithLoomboxBridge = typeof globalThis & { loombox?: Partial<DesktopLocalNodeBridge> };

/**
 * `undefined` outside the desktop shell (a plain PWA tab, this module's own
 * SSR/test environment) — the real bridge only exists inside the Electron
 * `BrowserWindow` that loaded this same `apps/web` build. Duck-typed on
 * `provisionLocalNode` specifically (not just `'loombox' in window`, the
 * looser check `keyboard.ts`'s `isDesktopShell` uses for the keybinding
 * question): a bridge that doesn't have this method yet is exactly as
 * unusable here as no bridge at all.
 */
function getDesktopLocalNodeBridge(): DesktopLocalNodeBridge | undefined {
  if (typeof window === 'undefined' || !('loombox' in window)) return undefined;
  const globalWithBridge = window as WindowWithLoomboxBridge;
  const bridge = globalWithBridge.loombox;
  if (typeof bridge?.provisionLocalNode !== 'function') return undefined;
  return bridge as DesktopLocalNodeBridge;
}

/**
 * Whether {@link provisionMacLocalNode} can run at all in this tab — a
 * public gate `+page.svelte` reads to decide whether `AddProjectDialog`'s
 * empty state offers "Set up a node on this Mac" at all, checked fresh on
 * every call rather than cached (mirrors `isDesktopShell`'s own reasoning:
 * `+page.svelte` is also rendered server-side, where `window` doesn't
 * exist, so a module-level constant would freeze at whatever the first
 * import saw).
 */
export function isMacLocalNodeProvisioningAvailable(): boolean {
  return getDesktopLocalNodeBridge() !== undefined;
}

/** `Uint8Array` -> base64 via `btoa`, `Buffer`-free for the same reason `amk-store.ts`/`relay-client.ts` are — `Buffer` is a Node builtin Vite does not polyfill for the browser build. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Mirrors `device-id-store.ts`'s `generateDeviceId`/`projects.ts`'s `newId` exactly: `crypto.randomUUID` is missing in older Safari and some test environments, and this id is never a security boundary (the device token minted for it is), only a catalog key. */
function generateNodeId(): string {
  const hasRandomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const unique = hasRandomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `mac_${unique}`;
}

export interface ProvisionMacLocalNodeOptions {
  relayUrl: string;
  accountId: string;
  /** This device's own already-unlocked bearer token (`StoredAuthSession.token`). */
  actingAuthToken: string;
  /** The account's currently-unlocked AMK (`AmkStorage.get(accountId)`). */
  amk: Uint8Array;
  claudeCodeOAuthToken?: string;
}

/**
 * Runs the desktop app's real `provisionLocalNode()` IPC call (issue #654):
 * installs, starts, pairs, and announces a resident node on THIS Mac —
 * `runtime_bootstrap` -> `target_identity` -> `mint_node_token` ->
 * `amk_handoff` -> `resident_node_install`, entirely behind one IPC round
 * trip, nothing typed into a shell. Rejects if there is no desktop bridge
 * in scope (a plain browser tab); callers gate on
 * {@link isMacLocalNodeProvisioningAvailable} first so this never surfaces
 * as a confusing runtime error from a control that should not have been
 * shown in the first place.
 */
export async function provisionMacLocalNode(
  options: ProvisionMacLocalNodeOptions,
): Promise<ProvisionLocalNodeOutcome> {
  const bridge = getDesktopLocalNodeBridge();
  if (!bridge) {
    throw new Error('Setting up a node on this Mac requires the desktop app.');
  }
  const nodeId = generateNodeId();
  return bridge.provisionLocalNode({
    relayUrl: options.relayUrl,
    accountId: options.accountId,
    actingAuthToken: options.actingAuthToken,
    amkBase64: bytesToBase64(options.amk),
    nodeId,
    tokenLabel: `loombox node: ${nodeId}`,
    claudeCodeOAuthToken: options.claudeCodeOAuthToken,
  });
}
