import type {
  SpawnLocalNodeRequest,
  SpawnLocalNodeResult,
  StopLocalNodeResult,
} from '../../shared/bridge';
import type { LaunchCommand } from './process-manager';
import { LocalNodeProcessManager } from './process-manager';

/**
 * Resolves the command that actually launches a local `@loombox/node`
 * (its built CLI entry, `packages/node/src/main.ts`'s `start()`, plus the
 * env it requires — `LOOMBOX_RELAY_URL`/`LOOMBOX_NODE_ID` and either an
 * auth token or the recovery-code/AMK bootstrap, see `packages/node/src/
 * config.ts`). TODO(#403 follow-up, same #398/#399 dependency as
 * `provisionTarget`): none of that account/identity resolution exists in
 * the desktop app yet, so this always returns `undefined` for now —
 * `LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND` is a local-dev-only escape hatch
 * (e.g. point it at `tsx packages/node/src/main.ts` while iterating) until
 * the real resolution lands.
 */
export function resolveLocalNodeLaunchCommand(
  env: NodeJS.ProcessEnv,
  extraEnv: Record<string, string> | undefined,
): LaunchCommand | undefined {
  const override = env.LOOMBOX_DESKTOP_LOCAL_NODE_COMMAND?.trim();
  if (!override) return undefined;
  const [command, ...args] = override.split(' ').filter(Boolean);
  if (!command) return undefined;
  return { command, args, env: extraEnv };
}

/**
 * Wires the {@link LoomboxBridgeApi} `spawnLocalNode`/`stopLocalNode`
 * methods to a {@link LocalNodeProcessManager}. Kept separate from
 * `../ipc/handlers.ts` so it's testable without any `ipcMain`/Electron
 * involved at all — `handlers.ts` just forwards to this.
 */
export class LocalNodeBridge {
  constructor(
    private readonly manager: LocalNodeProcessManager = new LocalNodeProcessManager(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  spawnLocalNode(request: SpawnLocalNodeRequest = {}): SpawnLocalNodeResult {
    const launch = resolveLocalNodeLaunchCommand(this.env, request.env);
    if (!launch) {
      return {
        status: this.manager.status(),
        notConfigured: true,
        message:
          'spawnLocalNode is not configured yet: no local @loombox/node launch command is ' +
          "resolved in this scaffold (see resolveLocalNodeLaunchCommand's doc comment).",
      };
    }
    const status = this.manager.spawn(launch);
    return { status, pid: this.manager.pid() };
  }

  stopLocalNode(): StopLocalNodeResult {
    this.manager.stop();
    return { status: this.manager.status() };
  }

  status(): { status: SpawnLocalNodeResult['status']; pid?: number } {
    return { status: this.manager.status(), pid: this.manager.pid() };
  }
}
