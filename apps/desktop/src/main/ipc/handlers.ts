import type { SshTargetConfig } from '@loombox/node';

import {
  BRIDGE_CHANNELS,
  type BridgeStatus,
  type ListSshHostCandidatesResult,
  type ProvisionTargetRequest,
  type ProvisionTargetResult,
  type SpawnLocalNodeRequest,
  type SpawnLocalNodeResult,
  type StopLocalNodeResult,
} from '../../shared/bridge';
import type { LocalNodeBridge } from '../local-node/bridge';
import type { AppVersionSource } from '../status';
import type { LoginItemApp } from '../login-item';
import { buildStatus } from '../status';
import {
  resolveProvisionTargetDeps,
  runProvisionTarget,
  type ProvisionTargetDeps,
} from '../provisioning/provision-target-bridge';
import { listSshHostCandidates } from '../ssh-candidates';

/**
 * The exact (and only) slice of Electron's real `ipcMain` this module uses —
 * matches `Electron.IpcMain['handle']`'s signature structurally, so the real
 * `ipcMain` satisfies this without a cast, while tests pass a plain
 * recording fake instead (no Electron runtime needed, matches this app's
 * general pattern of depending on the narrowest slice of Electron a module
 * actually needs — see `../login-item.ts`).
 */
export interface IpcMainLike {
  // Matches Electron's own `IpcMain.handle` signature (`electron.d.ts`)
  // exactly, so the real `ipcMain` is structurally assignable to this
  // interface without a cast; `unknown` here would reject it (TS parameter
  // contravariance).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (event: any, ...args: any[]) => any): void;
}

export interface BridgeHandlerDeps {
  localNode: LocalNodeBridge;
  app: LoginItemApp & AppVersionSource;
  /** Overrides `resolveProvisionTargetDeps()`'s own (currently always-`undefined`) result — tests inject real deps against a `FakeTransport`; production leaves this unset until #398/#399 land. */
  provisionTargetDeps?: ProvisionTargetDeps;
}

/** Registers every {@link BRIDGE_CHANNELS} entry on `ipcMain`, delegating to the already-tested pieces in `../local-node/`, `../provisioning/`, `../ssh-candidates.ts`, and `../status.ts` — this file only wires them to channel names. */
export function registerBridgeHandlers(ipcMain: IpcMainLike, deps: BridgeHandlerDeps): void {
  ipcMain.handle(
    BRIDGE_CHANNELS.listSshHostCandidates,
    async (): Promise<ListSshHostCandidatesResult> => {
      return listSshHostCandidates();
    },
  );

  ipcMain.handle(
    BRIDGE_CHANNELS.provisionTarget,
    async (_event, request: ProvisionTargetRequest): Promise<ProvisionTargetResult> => {
      const provisionDeps = deps.provisionTargetDeps ?? resolveProvisionTargetDeps();
      if (!provisionDeps) {
        return {
          ok: false,
          targetId: request.target.id,
          steps: [],
          notConfigured: true,
          message:
            'provisionTarget is not configured yet in this scaffold (see provision-target-bridge.ts).',
        };
      }
      const target: SshTargetConfig = request.target;
      return runProvisionTarget(target, {
        ...provisionDeps,
        runtime: request.skipRuntimeBootstrap
          ? { ...provisionDeps.runtime, skip: true }
          : provisionDeps.runtime,
        residentNode: request.skipResidentNode
          ? { ...provisionDeps.residentNode, skip: true }
          : provisionDeps.residentNode,
      });
    },
  );

  ipcMain.handle(
    BRIDGE_CHANNELS.spawnLocalNode,
    async (_event, request?: SpawnLocalNodeRequest): Promise<SpawnLocalNodeResult> => {
      return deps.localNode.spawnLocalNode(request);
    },
  );

  ipcMain.handle(BRIDGE_CHANNELS.stopLocalNode, async (): Promise<StopLocalNodeResult> => {
    return deps.localNode.stopLocalNode();
  });

  ipcMain.handle(BRIDGE_CHANNELS.status, async (): Promise<BridgeStatus> => {
    return buildStatus(deps.app, deps.localNode);
  });
}
