import type { SshTargetConfig } from '@loombox/node';

import {
  BRIDGE_CHANNELS,
  type BridgeStatus,
  type ListSshHostCandidatesResult,
  type ProvisionLocalNodeRequest,
  type ProvisionLocalNodeResult,
  type ProvisionTargetRequest,
  type ProvisionTargetResult,
  type SpawnLocalNodeRequest,
  type SpawnLocalNodeResult,
  type StopLocalNodeResult,
  type UninstallLocalNodeRequest,
  type UninstallLocalNodeResult,
  type UpdateCheckResult,
} from '../../shared/bridge';
import type { LocalNodeBridge } from '../local-node/bridge';
import type { AppVersionSource } from '../status';
import type { LoginItemApp } from '../login-item';
import { buildStatus } from '../status';
import type { UpdateController } from '../updater';
import {
  resolveProvisionTargetDeps,
  runProvisionTarget,
  type ProvisionTargetDeps,
} from '../provisioning/provision-target-bridge';
import {
  resolveProvisionLocalNodeDeps,
  runProvisionLocalNode,
  type ProvisionLocalNodeDeps,
} from '../provisioning/provision-local-node-bridge';
import {
  resolveUninstallLocalNodeDeps,
  runUninstallLocalNode,
  type UninstallLocalNodeDeps,
} from '../provisioning/uninstall-local-node-bridge';
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
  /** Drives `checkForUpdate`/`applyUpdate`/`status`'s `update` field (issue #657) — `../index.ts` constructs this once at startup from the real `electron-updater` `autoUpdater`; tests inject a plain fake instead of a real feed check. */
  updateController: UpdateController;
  /** Overrides `resolveProvisionTargetDeps()`'s own (currently always-`undefined`) result — tests inject real deps against a `FakeTransport`; production leaves this unset until #398/#399 land. */
  provisionTargetDeps?: ProvisionTargetDeps;
  /** Overrides `resolveProvisionLocalNodeDeps()`'s own real resolution; tests inject a fake `SupervisorBackend`/`fetchArchive` instead of touching this machine's real `~/.loombox/releases` or launchd. */
  provisionLocalNodeDeps?: ProvisionLocalNodeDeps;
  /** Overrides `resolveUninstallLocalNodeDeps()`'s own real resolution; tests inject a fake `SupervisorBackend` instead of touching this machine's real launchd. */
  uninstallLocalNodeDeps?: UninstallLocalNodeDeps;
  /**
   * Overrides `../ssh-candidates.ts`'s real discovery. Production leaves it
   * unset. Tests MUST set it: the real implementation reads the developer's
   * own `~/.ssh/config`, so a test that lets it through asserts against
   * whatever hosts happen to be on the machine running it — green on a bare
   * CI runner, red on any machine with SSH hosts configured, which is
   * exactly how this suite came to fail only locally.
   */
  listSshHostCandidates?: () => Promise<ListSshHostCandidatesResult>;
}

/** Registers every {@link BRIDGE_CHANNELS} entry on `ipcMain`, delegating to the already-tested pieces in `../local-node/`, `../provisioning/`, `../ssh-candidates.ts`, and `../status.ts` — this file only wires them to channel names. */
export function registerBridgeHandlers(ipcMain: IpcMainLike, deps: BridgeHandlerDeps): void {
  ipcMain.handle(
    BRIDGE_CHANNELS.listSshHostCandidates,
    async (): Promise<ListSshHostCandidatesResult> => {
      return (deps.listSshHostCandidates ?? listSshHostCandidates)();
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
    BRIDGE_CHANNELS.provisionLocalNode,
    async (_event, request: ProvisionLocalNodeRequest): Promise<ProvisionLocalNodeResult> => {
      const provisionDeps = deps.provisionLocalNodeDeps ?? (await resolveProvisionLocalNodeDeps());
      return runProvisionLocalNode(request, provisionDeps);
    },
  );

  ipcMain.handle(
    BRIDGE_CHANNELS.uninstallLocalNode,
    async (_event, request: UninstallLocalNodeRequest): Promise<UninstallLocalNodeResult> => {
      const uninstallDeps = deps.uninstallLocalNodeDeps ?? (await resolveUninstallLocalNodeDeps());
      return runUninstallLocalNode(request, uninstallDeps);
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
    return buildStatus(deps.app, deps.localNode, deps.updateController);
  });

  ipcMain.handle(BRIDGE_CHANNELS.checkForUpdate, async (): Promise<UpdateCheckResult> => {
    return deps.updateController.checkForUpdates();
  });

  ipcMain.handle(BRIDGE_CHANNELS.applyUpdate, async (): Promise<UpdateCheckResult> => {
    return deps.updateController.applyUpdate();
  });
}
