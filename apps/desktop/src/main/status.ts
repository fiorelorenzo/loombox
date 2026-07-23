import type { BridgeStatus } from '../shared/bridge';
import type { LocalNodeBridge } from './local-node/bridge';
import type { LoginItemApp } from './login-item';
import { getLaunchAtLogin } from './login-item';

export interface AppVersionSource {
  getVersion(): string;
}

/** Assembles the `status()` bridge method's snapshot from the pieces that each own one slice of it, so no state is duplicated here. */
export function buildStatus(
  app: LoginItemApp & AppVersionSource,
  localNode: LocalNodeBridge,
): BridgeStatus {
  const local = localNode.status();
  return {
    appVersion: app.getVersion(),
    launchAtLogin: getLaunchAtLogin(app),
    localNode: { status: local.status, pid: local.pid },
  };
}
