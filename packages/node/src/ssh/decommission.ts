import { detectRemoteOsArch } from './remote-runtime';
import { shQuote, type RemoteTransport } from './remote-transport';
import { resolveSupervisorBaseDir } from './supervisor-provisioning';
import { DEFAULT_UNIT_NAME, isCommandPresent, resolveSystemdUnitDir } from './systemd-provisioning';
import type { SshTargetStore } from './verify-and-persist';

/**
 * Target decommissioning (issue #90, SPEC §7.23 "Removing a target: a
 * decommission action stops/disables the remote units, revokes the device
 * key, and offers to clean up installed files") — the counterpart to
 * `./supervisor-provisioning.ts` (install) and `./systemd-provisioning.ts`
 * (opt-in resident node): tearing a fully- or partially-provisioned target
 * back down.
 *
 * **What "revoke the device key from the node's trusted set" means here:**
 * `packages/node` has no separate per-target device-key/credential
 * subsystem beyond `./verify-and-persist.ts`'s {@link SshTargetStore} — that
 * store IS this node's trusted set of `ssh:` targets it will connect to
 * (`NodeDaemon.getSshTransport()` looks a target's connection recipe up
 * there and nowhere else). Removing a target's entry from it is therefore
 * the actual, complete revocation: no future connection attempt can use its
 * stored auth (private key path/password/agent selection) again, and the
 * target genuinely "no longer appears as usable" (issue #90's acceptance)
 * the instant this returns.
 */
export interface DecommissionOptions {
  targetId: string;
  /** Overrides the systemd unit name; defaults to `./systemd-provisioning.ts`'s `DEFAULT_UNIT_NAME`. */
  unitName?: string;
  /** Overrides the remote systemd user-unit directory; defaults to `$HOME/.config/systemd/user`. */
  unitDir?: string;
  /** Overrides the remote supervisor base directory; defaults to `$HOME/.loombox/supervisor` (see `./supervisor-provisioning.ts`). */
  supervisorBaseDir?: string;
  /**
   * Whether the user accepted removal of installed remote files (the staged
   * supervisor directory + the systemd unit file, if any). Defaults to
   * `false` — stopping/disabling any unit and revoking the device key always
   * happen; file cleanup is the one step issue #90 asks to be *offered*
   * (accept/decline), never assumed.
   */
  removeFiles?: boolean;
}

export interface DecommissionStepResult {
  command: string;
  exitCode: number;
  stderr: string;
}

export interface DecommissionResult {
  targetId: string;
  /** Whether a resident-node unit was found installed for this target at all — `false` means the stop/disable step below was a deliberate no-op, not a failure. */
  unitWasInstalled: boolean;
  /** `true` only when a unit was installed AND the stop command exited 0. */
  unitStopped: boolean;
  /** `true` only when a unit was installed AND the disable command exited 0. */
  unitDisabled: boolean;
  /** `true` once the target's entry has been removed from the node's trusted `SshTargetStore` — see this module's doc comment for what "device key" maps to here. Always `true` on a normal return (the only way this is `false` is if `decommissionSshTarget` throws before reaching it). */
  deviceKeyRevoked: boolean;
  /** `true` only when `removeFiles` was accepted AND every cleanup command exited 0. `false` for a decline — not a failure. */
  filesRemoved: boolean;
  /** Every remote command actually issued, in order, for observability/debugging. */
  ranCommands: DecommissionStepResult[];
}

/**
 * Decommissions `targetId`: stops and disables any installed resident-node
 * systemd unit, revokes the target from `store`'s trusted set, and — only if
 * `options.removeFiles` is `true` — removes the staged supervisor directory
 * and the unit file from the remote. Runs over an already-connected
 * `transport` for `targetId`; the caller is responsible for closing/
 * forgetting any pooled connection and the target's port-forward rules
 * afterward (see `NodeDaemon`'s decommission wiring for the full sequence).
 */
export async function decommissionSshTarget(
  transport: RemoteTransport,
  store: SshTargetStore,
  options: DecommissionOptions,
): Promise<DecommissionResult> {
  const unitName = options.unitName ?? DEFAULT_UNIT_NAME;
  const unitDir = await resolveSystemdUnitDir(transport, options.unitDir);
  const unitPath = `${unitDir}/${unitName}`;

  const osArch = await detectRemoteOsArch(transport);
  const systemctlPresent =
    osArch.os === 'linux' && (await isCommandPresent(transport, 'systemctl'));
  const unitCheck = await transport.exec(`cat ${shQuote(unitPath)} 2>/dev/null`);
  const unitWasInstalled = unitCheck.stdout.length > 0;

  const ranCommands: DecommissionStepResult[] = [];
  let unitStopped = false;
  let unitDisabled = false;

  if (systemctlPresent && unitWasInstalled) {
    const stopCommand = `systemctl --user stop ${shQuote(unitName)}`;
    const stop = await transport.exec(stopCommand);
    ranCommands.push({ command: stopCommand, exitCode: stop.exitCode, stderr: stop.stderr });
    unitStopped = stop.exitCode === 0;

    const disableCommand = `systemctl --user disable ${shQuote(unitName)}`;
    const disable = await transport.exec(disableCommand);
    ranCommands.push({
      command: disableCommand,
      exitCode: disable.exitCode,
      stderr: disable.stderr,
    });
    unitDisabled = disable.exitCode === 0;
  }

  // Revoke — see this module's doc comment for what that means here.
  store.remove(options.targetId);
  const deviceKeyRevoked = true;

  let filesRemoved = false;
  if (options.removeFiles) {
    const supervisorBaseDir =
      options.supervisorBaseDir ?? (await resolveSupervisorBaseDir(transport));

    const rmSupervisorCommand = `rm -rf ${shQuote(supervisorBaseDir)}`;
    const rmSupervisor = await transport.exec(rmSupervisorCommand);
    ranCommands.push({
      command: rmSupervisorCommand,
      exitCode: rmSupervisor.exitCode,
      stderr: rmSupervisor.stderr,
    });

    const rmUnitCommand = `rm -f ${shQuote(unitPath)}`;
    const rmUnit = await transport.exec(rmUnitCommand);
    ranCommands.push({ command: rmUnitCommand, exitCode: rmUnit.exitCode, stderr: rmUnit.stderr });

    filesRemoved = rmSupervisor.exitCode === 0 && rmUnit.exitCode === 0;
  }

  return {
    targetId: options.targetId,
    unitWasInstalled,
    unitStopped,
    unitDisabled,
    deviceKeyRevoked,
    filesRemoved,
    ranCommands,
  };
}
