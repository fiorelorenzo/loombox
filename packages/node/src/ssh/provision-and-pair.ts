import { exportPublicKeyRaw, generateEcdhKeyPair } from '@loombox/crypto';
import type { ProvisionStepIdV1, ProvisionStepStatusV1 } from '@loombox/protocol';

import { IDENTITY_FILE_NAME, serializePersistedIdentityFile } from '../identity';
import type { SshTargetConfig } from '../target';
import {
  DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME,
  writeWrappedAmkHandoff,
  type AmkHandoffActingIdentity,
} from './amk-handoff-provision';
import { mintNodeToken as defaultMintNodeToken } from './mint-node-token';
import {
  buildResidentNodeEnvironment,
  provision,
  type ProvisionStep,
  type ResidentNodeConfig,
  type SupervisorInstallStep,
} from './provision-target';
import { shQuote, type RemoteTransport } from './remote-transport';
import { Ssh2Transport } from './ssh2-transport';
import { SshTransportPool } from './ssh-transport-pool';
import type { PlanSupervisorProvisioningOptions } from './supervisor-provisioning';
import {
  executeSystemdProvisioning,
  planSystemdProvisioning,
  type SystemdUnitConfig,
} from './systemd-provisioning';
import { SshTargetStore } from './verify-and-persist';

export type { PlanSupervisorProvisioningOptions };

/**
 * Composes issue #400's `provision()` (`./provision-target.ts`) with the
 * three zero-touch pairing steps issue #408's add-target wizard needs — a
 * freshly-provisioned `ssh:` target's own device identity, a minted node
 * token for it (issue #401), and the AMK handoff (issue #399,
 * `./amk-handoff-provision.ts`) — into the one "add this target and it's
 * fully paired, no second device's approval" sequence SPEC §7.23 describes.
 *
 * Deliberately re-runs `provision()` with `residentNode.skip: true` and
 * performs the systemd install itself, standalone, AFTER pairing: the
 * resident unit's `Environment=` needs the minted device token and the
 * handoff file's resolved path, neither of which exist yet when `provision()`
 * would otherwise reach its own fourth step. Reuses `provision()`'s own
 * `transportPool` option so every step here — its own three, plus this
 * module's four — shares one open SSH connection to `target`, opened once
 * and closed once by this function's own `finally`, never by `provision()`
 * itself (see `ProvisionOptions.transportPool`'s doc comment: passing one in
 * means the callee never owns/closes it).
 *
 * This module is intentionally decoupled from the wire protocol and from
 * `NodeDaemon` — it takes an already-resolved `SshTargetConfig` and plain
 * crypto/config inputs, exactly like `provision()` itself, so it's testable
 * with `FakeTransport`/`LocalProcessTransport` with no relay or `NodeDaemon`
 * involved. `./wire-provision-and-pair.ts` is the thin wire-level adapter
 * that resolves a `provision_target_request`'s host descriptor into an
 * `SshTargetConfig`, calls this function, and streams the result back.
 */
export type ProvisionAndPairStepId = ProvisionStepIdV1;
export type ProvisionAndPairStepStatus = ProvisionStepStatusV1;

export interface ProvisionAndPairProgress {
  step: ProvisionAndPairStepId;
  status: ProvisionAndPairStepStatus;
  message: string;
}

export interface ProvisionAndPairResult {
  ok: boolean;
  targetId: string;
  progress: ProvisionAndPairProgress[];
  failedStep?: ProvisionAndPairStepId;
  /** Set only once `resident_node_install` actually starts: the minted device id the new resident node announces itself under (`config.deviceId`). */
  deviceId?: string;
  /** Set only once `resident_node_install` actually starts: the nodeId the new resident node will connect/announce as. */
  residentNodeId?: string;
}

/** A step in `provision()`'s own sequence, in the fixed order it always runs them — used to synthesize a `'started'` event for the next one the moment this one settles `ok` (see this module's doc comment). */
const INNER_PROVISION_SEQUENCE: readonly ProvisionAndPairStepId[] = [
  'verify_and_persist',
  'runtime_bootstrap',
  'supervisor_install',
];

export interface ProvisionAndPairOptions {
  /** The relay URL the new resident node connects to — always the SAME relay this acting node itself is connected to. */
  relayUrl: string;
  accountId: string;
  /** This (acting) node's own bearer token, used to mint the new resident's token (issue #401's "a node can call the authenticated mint with its device token"). */
  actingAuthToken: string;
  /** This node's own currently-held AMK, wrapped for the new target's device pubkey. Never sent to the relay — see this module's doc comment. */
  amk: Uint8Array;
  /** This node's own currently-adopted AMK epoch; defaults to `@loombox/crypto`'s `AMK_HANDOFF_DEFAULT_EPOCH` (0) via `writeWrappedAmkHandoff` itself. */
  amkEpoch?: number;
  /** This node's own ECDH identity (private key + raw public key) — wraps the AMK for the target (`writeWrappedAmkHandoff`'s `actingIdentity`). */
  actingIdentity: AmkHandoffActingIdentity;
  /** Passed straight to `CLAUDE_CODE_OAUTH_TOKEN` on the new resident (`ResidentNodeConfig.claudeCodeOAuthToken`); omit to leave the resident's own agent credential to be configured separately. */
  claudeCodeOAuthToken?: string;
  /** The new resident's own device id; defaults to `target.id`. */
  deviceId?: string;
  /** The nodeId the new resident announces itself under; defaults to `target.id`. */
  residentNodeId?: string;
  /** Label attached to the minted node token (`POST /account/node-tokens`'s `label`, SPEC §8's "individually labeled" mitigation); defaults to `loombox node: <target.label>`. */
  tokenLabel?: string;
  /** Passed straight through to `provision()`'s own `runtime` option. */
  runtime?: { skip?: boolean; nodeVersion?: string };
  /** Passed straight through to `provision()`'s own `supervisor` option (issue #86's signed-artifact staging — required, exactly like `provision()` itself requires it, since there is no built-in default artifact source yet). */
  supervisor: PlanSupervisorProvisioningOptions;
  /** Overrides the remote base directory the new resident's state (identity file, wrapped-AMK handoff file) is written under; defaults to `$HOME/.loombox/node`, resolved on the remote. */
  residentStateDir?: string;
  /** Overrides the remote `systemd --user` unit directory (`planSystemdProvisioning`'s own `unitDir`); defaults to `$HOME/.config/systemd/user`, resolved on the remote. Tests MUST override this to a throwaway directory — `LocalProcessTransport`-backed tests write for real, and the real default would touch the actual machine running the test. */
  residentUnitDir?: string;
  transportFactory?: (config: SshTargetConfig) => RemoteTransport;
  store?: SshTargetStore;
  /** Injectable for tests; defaults to `./mint-node-token.ts`'s real HTTP-backed implementation. */
  mintNodeToken?: typeof defaultMintNodeToken;
  /** Called once per step, right after it changes state (`'started'`, then `'ok'`/`'failed'`) — the wizard's live-progress screen (`apps/web`) is driven by this, relayed over the wire as `provision_progress`. */
  onProgress?: (progress: ProvisionAndPairProgress) => void;
}

/** Resolves `$HOME/.loombox/node` on the remote (the resident node's own state-dir convention, shared with `identity.ts`'s local default and `./verify-and-persist.ts`'s `defaultNodeStateDir()`), unless `override` is given. */
async function resolveResidentStateDir(
  transport: RemoteTransport,
  override?: string,
): Promise<string> {
  if (override) return override;
  const result = await transport.exec('printf %s "$HOME/.loombox/node"');
  return result.stdout.trim();
}

export async function provisionAndPair(
  target: SshTargetConfig,
  options: ProvisionAndPairOptions,
): Promise<ProvisionAndPairResult> {
  const mintNodeTokenImpl = options.mintNodeToken ?? defaultMintNodeToken;
  const progress: ProvisionAndPairProgress[] = [];
  const onProgress = options.onProgress;

  const emit = (
    step: ProvisionAndPairStepId,
    status: ProvisionAndPairStepStatus,
    message: string,
  ): void => {
    const entry: ProvisionAndPairProgress = { step, status, message };
    progress.push(entry);
    onProgress?.(entry);
  };

  const fail = (step: ProvisionAndPairStepId, message: string): ProvisionAndPairResult => {
    emit(step, 'failed', message);
    return { ok: false, targetId: target.id, progress, failedStep: step };
  };

  const pool = new SshTransportPool();

  try {
    emit(
      'verify_and_persist',
      'started',
      `verifying ssh connectivity to "${target.id}" (${target.host})`,
    );

    const provisionResult = await provision(target, {
      transportFactory: options.transportFactory,
      store: options.store,
      transportPool: pool,
      runtime: options.runtime,
      supervisor: options.supervisor,
      // The zero-touch resident-node install is deliberately deferred and
      // re-run standalone below, once this module's own pairing steps have
      // produced the minted token + handoff path its Environment= needs —
      // see this module's doc comment. `config` here is never read: `skip:
      // true` short-circuits before `provision()` ever inspects it.
      residentNode: { skip: true, config: { relayUrl: options.relayUrl, nodeId: target.id } },
      onProgress: (step: ProvisionStep) => {
        // `provision()`'s own fourth step (`resident_node_install`) fires
        // here too, as an inert "skipped by caller" report — swallowed
        // rather than forwarded, since THIS module reports that same step
        // id itself, standalone, once pairing has actually produced what
        // its systemd unit needs (see this module's doc comment).
        // Forwarding both would announce `resident_node_install: ok` twice,
        // the first time confusingly early (right after supervisor_install,
        // before target_identity/mint/handoff have even started).
        if (step.step === 'resident_node_install') return;
        emit(step.step, step.ok ? 'ok' : 'failed', step.message);
        if (step.ok) {
          const nextIndex = INNER_PROVISION_SEQUENCE.indexOf(step.step) + 1;
          const next = INNER_PROVISION_SEQUENCE[nextIndex];
          if (next) emit(next, 'started', `starting ${next}`);
        }
      },
    });

    if (!provisionResult.ok) {
      return {
        ok: false,
        targetId: target.id,
        progress,
        failedStep: provisionResult.failedStep,
      };
    }

    const supervisorStep = provisionResult.steps.find(
      (step): step is SupervisorInstallStep => step.step === 'supervisor_install',
    );
    if (!supervisorStep) {
      // Unreachable in practice — `provisionResult.ok` is only true once
      // every step through `supervisor_install` has settled `ok` — but
      // guarded rather than asserted, since a missing baseDir would
      // otherwise surface as a much more confusing failure two steps down.
      return fail(
        'resident_node_install',
        'supervisor_install step result missing after a reported-ok provision()',
      );
    }

    const transport = await pool.get(target.id, () =>
      (options.transportFactory ?? defaultTransportFactory)(target),
    );
    const stateDir = await resolveResidentStateDir(transport, options.residentStateDir);

    // Step: target_identity — generate the new resident's own device
    // identity LOCALLY (this acting node has no way to run code on the
    // remote yet at this point in the sequence) and write it, in the exact
    // format `NodeIdentityStore` itself reads, to the remote's state dir —
    // so when the resident-node systemd unit starts, `main.ts`'s
    // `NodeIdentityStore.loadOrCreate()` reloads THIS keypair rather than
    // generating a fresh one this module never learned the pubkey of.
    emit('target_identity', 'started', `generating device identity for "${target.id}"`);
    let targetPublicKeyRaw: Uint8Array;
    try {
      const targetKeyPair = await generateEcdhKeyPair();
      targetPublicKeyRaw = await exportPublicKeyRaw(targetKeyPair.publicKey);
      const raw = await serializePersistedIdentityFile(targetKeyPair, targetPublicKeyRaw);
      const identityPath = `${stateDir}/${IDENTITY_FILE_NAME}`;
      const script = [
        `mkdir -p ${shQuote(stateDir)}`,
        `printf '%s' ${shQuote(raw)} > ${shQuote(identityPath)}`,
        `chmod 600 ${shQuote(identityPath)}`,
      ].join(' && ');
      const result = await transport.exec(script);
      if (result.exitCode !== 0) {
        return fail(
          'target_identity',
          `failed to write device identity to ${identityPath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      }
      emit('target_identity', 'ok', `device identity written to ${identityPath} (chmod 600)`);
    } catch (error) {
      return fail(
        'target_identity',
        `failed to generate/write device identity: ${errorMessage(error)}`,
      );
    }

    // Step: mint_node_token — the authenticated mint (issue #401/#398),
    // using THIS node's own bearer token, never a second device's approval.
    emit('mint_node_token', 'started', 'minting a node token for the new resident');
    let mintedToken: string;
    try {
      const minted = await mintNodeTokenImpl({
        relayUrl: options.relayUrl,
        authToken: options.actingAuthToken,
        label: options.tokenLabel ?? `loombox node: ${target.label}`,
      });
      mintedToken = minted.token;
      emit('mint_node_token', 'ok', 'node token minted');
    } catch (error) {
      return fail('mint_node_token', `failed to mint a node token: ${errorMessage(error)}`);
    }

    // Step: amk_handoff (issue #399) — wraps THIS node's own AMK for the
    // target's just-generated device pubkey and writes the one-shot handoff
    // file over this same already-encrypted SSH transport; never touches
    // the relay.
    emit('amk_handoff', 'started', 'handing off the account key over SSH');
    let wrappedAmkFilePath: string;
    try {
      const handoff = await writeWrappedAmkHandoff(transport, {
        amk: options.amk,
        accountId: options.accountId,
        epoch: options.amkEpoch,
        actingIdentity: options.actingIdentity,
        targetDeviceId: options.deviceId ?? target.id,
        targetDevicePublicKeyRaw: targetPublicKeyRaw,
        // Resolved from the SAME `stateDir` `target_identity` just wrote
        // to (rather than letting `writeWrappedAmkHandoff` independently
        // re-resolve `$HOME` on the remote) — they must agree, since the
        // resident-node unit's `LOOMBOX_WRAPPED_AMK_FILE` below points at
        // exactly this path.
        remotePath: `${stateDir}/${DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME}`,
      });
      if (!handoff.ok) {
        return fail('amk_handoff', handoff.message);
      }
      wrappedAmkFilePath = handoff.remotePath;
      emit('amk_handoff', 'ok', handoff.message);
    } catch (error) {
      return fail('amk_handoff', `failed to hand off the account key: ${errorMessage(error)}`);
    }

    // Step: resident_node_install — same primitive `provision()`'s own
    // fourth step uses (`./systemd-provisioning.ts`), run standalone now
    // that the minted token + handoff path exist to put in its Environment=.
    emit('resident_node_install', 'started', 'installing the resident-node systemd unit');
    const deviceId = options.deviceId ?? target.id;
    const residentNodeId = options.residentNodeId ?? target.id;
    const residentConfig: ResidentNodeConfig = {
      relayUrl: options.relayUrl,
      nodeId: residentNodeId,
      deviceId,
      deviceToken: mintedToken,
      accountId: options.accountId,
      wrappedAmkFilePath,
      claudeCodeOAuthToken: options.claudeCodeOAuthToken,
      stateDir: options.residentStateDir,
    };
    const unitConfig: SystemdUnitConfig = {
      execStart: `${supervisorStep.plan.baseDir}/supervisor-bin`,
      execArgs: ['--node'],
      environment: buildResidentNodeEnvironment(residentConfig),
      description: 'loombox resident node',
    };
    try {
      const plan = await planSystemdProvisioning(transport, {
        unit: unitConfig,
        unitDir: options.residentUnitDir,
      });
      if (plan.action === 'unsupported') {
        return fail('resident_node_install', plan.message);
      }
      const result = await executeSystemdProvisioning(transport, plan);
      if (!result.ok) {
        return fail('resident_node_install', result.error ?? plan.message);
      }
      emit('resident_node_install', 'ok', plan.message);
    } catch (error) {
      return fail(
        'resident_node_install',
        `failed to install the resident-node unit: ${errorMessage(error)}`,
      );
    }

    return { ok: true, targetId: target.id, progress, deviceId, residentNodeId };
  } finally {
    await pool.closeAll().catch(() => {
      /* best-effort cleanup of this call's own private pool */
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultTransportFactory(config: SshTargetConfig): RemoteTransport {
  // Mirrors `provision-target.ts`'s own private `defaultTransportFactory` —
  // duplicated rather than imported since that one isn't exported (kept
  // private to that module) and this file already needs its own fallback
  // for the extra remote calls (`transport.exec`) it makes AFTER
  // `provision()` returns, once `provision()`'s own default-vs-injected
  // choice no longer applies.
  return new Ssh2Transport({
    host: config.host,
    port: config.port,
    username: config.user ?? 'root',
    privateKeyPath: config.privateKeyPath,
    passphrase: config.passphrase,
    password: config.password,
    agent: config.agent,
  });
}
