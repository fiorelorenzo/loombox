/**
 * The local resident node uninstall trigger (issue #814, decision E1-3),
 * the counterpart to `./local-node-provision.ts`'s `provisionMacLocalNode`:
 * `@loombox/node`'s `uninstallNode()` runs entirely inside the desktop
 * app's Electron main process (`apps/desktop/src/main/provisioning/
 * uninstall-local-node-bridge.ts`, reached over
 * `window.loombox.uninstallLocalNode`) — this module is the renderer-side
 * half. Unlike provisioning, it needs no minted token or unlocked AMK: the
 * main process reads this node's own already-on-disk identity + device
 * token directly (same machine), so the only inputs this module forwards
 * are the relay URL, the node's own id (`TargetListEntry.nodeId`), and the
 * keep-data choice.
 *
 * Same minimal duck-typed bridge shape as `./local-node-provision.ts`'s own
 * `DesktopLocalNodeBridge` (see that module's doc comment for why this
 * doesn't import `apps/desktop`'s own bridge types).
 */

export interface UninstallLocalNodeOutcome {
  ok: boolean;
  deviceRevoked: boolean;
  message: string;
}

interface DesktopUninstallNodeBridge {
  uninstallLocalNode: (request: {
    relayUrl: string;
    nodeId: string;
    deviceId?: string;
    keepData?: boolean;
  }) => Promise<UninstallLocalNodeOutcome>;
}

/** Same widened-`window` cast reasoning as `./local-node-provision.ts`'s own `WindowWithLoomboxBridge`. */
type WindowWithLoomboxUninstallBridge = typeof globalThis & {
  loombox?: Partial<DesktopUninstallNodeBridge>;
};

function getDesktopUninstallNodeBridge(): DesktopUninstallNodeBridge | undefined {
  if (typeof window === 'undefined' || !('loombox' in window)) return undefined;
  const globalWithBridge = window as WindowWithLoomboxUninstallBridge;
  const bridge = globalWithBridge.loombox;
  if (typeof bridge?.uninstallLocalNode !== 'function') return undefined;
  return bridge as DesktopUninstallNodeBridge;
}

/**
 * Whether {@link uninstallLocalNode} can run at all in this tab — mirrors
 * `./local-node-provision.ts`'s `isMacLocalNodeProvisioningAvailable`
 * exactly (checked fresh on every call, never cached, for the same SSR
 * reasoning that doc comment explains).
 */
export function isLocalNodeUninstallAvailable(): boolean {
  return getDesktopUninstallNodeBridge() !== undefined;
}

export interface UninstallLocalNodeOptions {
  relayUrl: string;
  /** This node's own id, exactly as shown in its `TargetStatusView` row (`TargetListEntry.nodeId`). */
  nodeId: string;
  /** Decision E1-3's explicit keep-data opt-out; the device is revoked on the relay either way. */
  keepData?: boolean;
}

/**
 * Runs the desktop app's real `uninstallNode()` IPC call (issue #814):
 * revokes this node's device on the relay and tears down its local install
 * (unit, versioned bundle, and — unless `keepData` — its state dir and
 * keyring entry), entirely behind one IPC round trip. Rejects if there is
 * no desktop bridge in scope; callers gate on
 * {@link isLocalNodeUninstallAvailable} first, same convention
 * `provisionMacLocalNode` follows.
 */
export async function uninstallLocalNode(
  options: UninstallLocalNodeOptions,
): Promise<UninstallLocalNodeOutcome> {
  const bridge = getDesktopUninstallNodeBridge();
  if (!bridge) {
    throw new Error('Uninstalling this node requires the desktop app.');
  }
  return bridge.uninstallLocalNode({
    relayUrl: options.relayUrl,
    nodeId: options.nodeId,
    keepData: options.keepData,
  });
}
