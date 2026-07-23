import { contextBridge, ipcRenderer } from 'electron';

import {
  BRIDGE_CHANNELS,
  type ListSshHostCandidatesResult,
  type LoomboxBridgeApi,
  type BridgeStatus,
  type ProvisionTargetRequest,
  type ProvisionTargetResult,
  type SpawnLocalNodeRequest,
  type SpawnLocalNodeResult,
  type StopLocalNodeResult,
} from '../shared/bridge';

/**
 * Runs with `contextIsolation: true` (see `../main/window.ts`) in its own
 * isolated JS world: it can `require('electron')`, but nothing it does is
 * reachable from the loaded PWA's own scripts except what it explicitly
 * puts on `window.loombox` via `contextBridge.exposeInMainWorld` — the PWA
 * never gets `ipcRenderer`, Node globals, or anything else. This is the
 * *entire* bridge surface (SPEC-adjacent: the sandboxed-PWA-plus-native-
 * bridge shape this app exists to provide); every method here is a thin
 * `ipcRenderer.invoke` matching `../../shared/bridge.ts`'s
 * {@link LoomboxBridgeApi} exactly, so a type error here means the contract
 * and this implementation have drifted.
 */
const api: LoomboxBridgeApi = {
  listSshHostCandidates: (): Promise<ListSshHostCandidatesResult> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.listSshHostCandidates),
  provisionTarget: (request: ProvisionTargetRequest): Promise<ProvisionTargetResult> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.provisionTarget, request),
  spawnLocalNode: (request?: SpawnLocalNodeRequest): Promise<SpawnLocalNodeResult> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.spawnLocalNode, request),
  stopLocalNode: (): Promise<StopLocalNodeResult> =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.stopLocalNode),
  status: (): Promise<BridgeStatus> => ipcRenderer.invoke(BRIDGE_CHANNELS.status),
};

contextBridge.exposeInMainWorld('loombox', api);
