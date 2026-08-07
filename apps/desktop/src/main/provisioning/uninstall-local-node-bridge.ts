import type { NodeUninstallOptions, SupervisorBackend } from '@loombox/node';

import type { UninstallLocalNodeRequest, UninstallLocalNodeResult } from '../../shared/bridge';

// Same native-module-avoidance reason as `./provision-local-node-bridge.ts`'s
// own top comment: `@loombox/node`'s barrel eagerly loads node-pty/@napi-rs/
// keyring, whose prebuilt binaries match Node's ABI, not Electron's — every
// runtime import below is therefore a lazy `await import('@loombox/node')`,
// only reached once a caller actually uninstalls.

/**
 * Everything {@link runUninstallLocalNode} needs beyond the request itself
 * (issue #814): this platform's own `SupervisorBackend` — the same one
 * `./provision-local-node-bridge.ts`'s `resolveProvisionLocalNodeDeps`
 * resolves for install, macOS-local: launchd. `relay`/`identityStore` are
 * left to `uninstallNode()`'s own defaults (a real `NodeIdentityStore()` at
 * this machine's default state dir, and `resolveNodeUninstallRelayOptions`
 * reading this node's own already-on-disk identity + device token) — there
 * is nothing else for this module to inject beyond the backend.
 *
 * **When #658 (Linux local) lands its own `SupervisorBackend`, this must
 * gain the identical `process.platform` branch `./provision-local-node-
 * bridge.ts`'s own `resolveProvisionLocalNodeDeps` will need too** — until
 * then this mirrors that function's current (also macOS-only) resolution
 * exactly, on purpose, so the two never silently disagree about what
 * platform this app actually supports installing/uninstalling on.
 */
export interface UninstallLocalNodeDeps {
  backend: SupervisorBackend;
}

export async function resolveUninstallLocalNodeDeps(): Promise<UninstallLocalNodeDeps> {
  const { createLaunchdSupervisorBackend, createNodeLaunchdIo } = await import('@loombox/node');
  return { backend: createLaunchdSupervisorBackend(createNodeLaunchdIo()) };
}

/**
 * Runs the real `@loombox/node` `uninstallNode()` sequence and projects its
 * result onto the bridge's plain-data {@link UninstallLocalNodeResult} shape
 * — the counterpart to `./provision-local-node-bridge.ts`'s
 * `runProvisionLocalNode`. Resolves this node's own on-disk identity +
 * device token via `resolveNodeUninstallRelayOptions` (never asks the
 * renderer for either — see `../../shared/bridge.ts`'s own doc comment on
 * why this request carries no auth token/AMK) so a node whose files were
 * never fully provisioned (identity or token missing) still tears down its
 * local install; it just reports `deviceRevoked: false` honestly instead of
 * pretending to have revoked nothing.
 */
export async function runUninstallLocalNode(
  request: UninstallLocalNodeRequest,
  deps: UninstallLocalNodeDeps,
): Promise<UninstallLocalNodeResult> {
  const { resolveNodeUninstallRelayOptions, uninstallNode } = await import('@loombox/node');
  const deviceId = request.deviceId ?? request.nodeId;
  const relay = await resolveNodeUninstallRelayOptions({
    relayUrl: request.relayUrl,
    deviceId,
  });

  const options: NodeUninstallOptions = {
    backend: deps.backend,
    keepData: request.keepData,
    relay,
  };
  const result = await uninstallNode(options);

  return {
    ok: result.ok,
    deviceRevoked: result.deviceRevoked,
    message: result.message,
  };
}
