import { detectRemoteOsArch } from './remote-runtime';
import { shQuote, type RemoteTransport } from './remote-transport';
import { createSystemdSshSupervisorBackend } from './systemd-supervisor-backend';
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
 * **On the same seam as every other uninstall now (issue #814):** the
 * stop/disable/remove-unit/remove-bundle sequence used to be hand-rolled
 * `transport.exec` calls duplicating `./systemd-supervisor-backend.ts`'s
 * own logic; it now delegates to that backend's `uninstall()` directly —
 * one mechanism, not two that can drift. That changes this function's own
 * default: a `./systemd-supervisor-backend.ts` `uninstall()` always
 * disables the unit and removes the unit file and the versioned bundle
 * (decision E1-3, "uninstall means the machine is clean") — `removeFiles`
 * (kept, for the existing wire field/callers) no longer gates whether the
 * unit file survives, only whether this target's own opt-in resident
 * node's *state dir* (identity, session history) is also wiped, mapping
 * 1:1 onto `SupervisorBackendUninstallOptions.keepData`.
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
 * the instant this returns. This is a distinct mechanism from `../node-
 * uninstall.ts`'s E2E `device_revoke` (which this function does not send):
 * a target's own *opt-in* resident node, if it was ever provisioned with
 * its own device identity, is not tracked anywhere locally today (its
 * `deviceId` is baked into the remote unit's environment at provision
 * time and never persisted to `SshTargetConfig`) — revoking *that* device
 * on the relay needs that identity, which a caller that still has it can
 * layer on separately; not this issue's scope to invent new persistence
 * for.
 */
export interface DecommissionOptions {
  targetId: string;
  /** Overrides the systemd unit name; defaults to `./systemd-provisioning.ts`'s `DEFAULT_UNIT_NAME`. */
  unitName?: string;
  /** Overrides the remote systemd user-unit directory; defaults to `$HOME/.config/systemd/user`. */
  unitDir?: string;
  /** Overrides the remote seam base dir (`$HOME/.loombox`, decision A1-2's parent of `current`/`versions`); resolved on the remote otherwise. */
  baseDir?: string;
  /** Overrides this target's own resident node's state dir (`$HOME/.loombox/node`); resolved on the remote otherwise. Only removed when `removeFiles` is true. */
  stateDir?: string;
  /**
   * A pre-#817 staged-supervisor directory (`./supervisor-provisioning.ts`'s
   * own shape, `supervisor-bin`+`VERSION` directly under it — superseded by
   * decision A1-2's versioned-bundle layout, which the seam's `baseDir`
   * above already covers) — an extra `rm -rf`, only issued when explicitly
   * given and only alongside `removeFiles: true`. A target provisioned
   * after #817 never has one; new callers never need to set this.
   */
  legacySupervisorBaseDir?: string;
  /**
   * Whether the operator also accepted wiping this target's own resident
   * node's state dir (identity, session history — irreversible, the relay
   * only ever holds ciphertext it cannot restore) and the legacy staged
   * directory above, if any. Defaults to `false` (E1-3's keep-data
   * opt-out): the unit and its versioned bundle are gone either way, only
   * this flag decides whether the *data* survives.
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
  /** Whether a resident-node unit was found installed for this target at all — `false` means the uninstall step below was a deliberate no-op, not a failure. */
  unitWasInstalled: boolean;
  /** `true` once a found unit was genuinely stopped (`SupervisorBackend.uninstall`'s own `ok`) — `false` when nothing was installed. */
  unitStopped: boolean;
  /** `true` once a found unit was genuinely disabled and its unit file removed — same gating as {@link unitStopped} (the seam issues both as one `disable --now` + `rm`, never separately). */
  unitDisabled: boolean;
  /** `true` once the target's entry has been removed from the node's trusted `SshTargetStore` — see this module's doc comment for what "device key" maps to here. Always `true` on a normal return (the only way this is `false` is if `decommissionSshTarget` throws before reaching it). */
  deviceKeyRevoked: boolean;
  /** `true` only when `removeFiles` was accepted AND every extra cleanup command (the resident node's own state dir, plus the legacy staged dir if any) exited 0. `false` for a decline — not a failure, and independent of whether a unit even existed (the unit/bundle are handled by {@link unitDisabled} above regardless). */
  filesRemoved: boolean;
  /** Every remote command actually issued, in order, for observability/debugging. */
  ranCommands: DecommissionStepResult[];
}

/**
 * Decommissions `targetId`: uninstalls any installed resident-node systemd
 * unit (`./systemd-supervisor-backend.ts`'s own `uninstall()` — see this
 * module's doc comment for what that now always removes vs. what
 * `removeFiles` still gates), revokes the target from `store`'s trusted
 * set, and — only if `options.removeFiles` is `true` — also wipes the
 * resident node's own state dir and, if given, `options.legacySupervisorBaseDir`.
 * Runs over an already-connected `transport` for `targetId`; the caller is
 * responsible for closing/forgetting any pooled connection and the
 * target's port-forward rules afterward (see `NodeDaemon`'s decommission
 * wiring for the full sequence).
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
    const backend = createSystemdSshSupervisorBackend(transport, {
      unitName,
      unitDir: options.unitDir,
      baseDir: options.baseDir,
      stateDir: options.stateDir,
    });
    const result = await backend.uninstall({ keepData: !options.removeFiles });
    ranCommands.push({
      command: 'systemd-supervisor-backend uninstall',
      exitCode: result.ok ? 0 : 1,
      stderr: result.ok ? '' : result.message,
    });
    unitStopped = result.ok;
    unitDisabled = result.ok;
  }

  // Revoke — see this module's doc comment for what that means here.
  store.remove(options.targetId);
  const deviceKeyRevoked = true;

  let filesRemoved = false;
  if (options.removeFiles) {
    filesRemoved = true;
    if (options.legacySupervisorBaseDir) {
      const rmLegacyCommand = `rm -rf ${shQuote(options.legacySupervisorBaseDir)}`;
      const rmLegacy = await transport.exec(rmLegacyCommand);
      ranCommands.push({
        command: rmLegacyCommand,
        exitCode: rmLegacy.exitCode,
        stderr: rmLegacy.stderr,
      });
      filesRemoved = filesRemoved && rmLegacy.exitCode === 0;
    }
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
