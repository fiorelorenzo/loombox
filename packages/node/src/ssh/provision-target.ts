import type { SshTargetConfig } from '../target';
import {
  decommissionSshTarget,
  type DecommissionOptions,
  type DecommissionResult,
} from './decommission';
import {
  executeRuntimeBootstrap,
  planRuntimeBootstrap,
  type PlanRuntimeBootstrapOptions,
  type RuntimeBootstrapPlan,
  type RuntimeBootstrapResult,
} from './remote-runtime';
import type { RemoteTransport } from './remote-transport';
import { Ssh2Transport } from './ssh2-transport';
import { SshTransportPool } from './ssh-transport-pool';
import {
  executeSupervisorProvisioning,
  planSupervisorProvisioning,
  type PlanSupervisorProvisioningOptions,
  type SupervisorProvisionPlan,
  type SupervisorProvisionResult,
} from './supervisor-provisioning';
import {
  executeSystemdProvisioning,
  planSystemdProvisioning,
  type SystemdProvisionPlan,
  type SystemdProvisionResult,
  type SystemdUnitConfig,
} from './systemd-provisioning';
import {
  SshTargetStore,
  verifyAndPersistSshTarget,
  type SshVerifyResult,
} from './verify-and-persist';

/**
 * Composes the individually-tested `ssh:` provisioning primitives
 * (`./verify-and-persist.ts`, `./remote-runtime.ts`, `./supervisor-
 * provisioning.ts`, `./systemd-provisioning.ts`) into the one "add this
 * target and it provisions" flow SPEC §7.23 describes but that, before this
 * module, had no non-test caller (issue #400). Nothing here reimplements a
 * mechanism those modules already own — this file only sequences them,
 * carries state (the pooled transport, the resolved supervisor base dir)
 * between steps, and turns each primitive's own plan/execute result into one
 * step in a single ordered report.
 *
 * Deliberately does **not** mint or fetch the resident node's auth token or
 * AMK/recovery code — that's the zero-touch pairing work (issues #398/#399).
 * {@link ResidentNodeConfig} accepts them as plain parameters a caller (a
 * future add-target wizard, or those later issues) supplies.
 */
export type ProvisionStepId =
  'verify_and_persist' | 'runtime_bootstrap' | 'supervisor_install' | 'resident_node_install';

interface ProvisionStepBase {
  ok: boolean;
  /** Human-readable summary of this step's outcome, suitable for a progress log/UI. */
  message: string;
}

export interface VerifyAndPersistStep extends ProvisionStepBase {
  step: 'verify_and_persist';
  verify: SshVerifyResult;
}

export interface RuntimeBootstrapStep extends ProvisionStepBase {
  step: 'runtime_bootstrap';
  /** `true` when this step never touched the remote at all (`ProvisionOptions.runtime.skip`) — distinct from `plan.action === 'noop'`, which means the remote genuinely already has a runtime. */
  skipped: boolean;
  plan?: RuntimeBootstrapPlan;
  result?: RuntimeBootstrapResult;
}

export interface SupervisorInstallStep extends ProvisionStepBase {
  step: 'supervisor_install';
  plan: SupervisorProvisionPlan;
  result: SupervisorProvisionResult;
}

export interface ResidentNodeInstallStep extends ProvisionStepBase {
  step: 'resident_node_install';
  /** `true` when this step never touched the remote at all (`ProvisionOptions.residentNode.skip`) — the caller declined the opt-in resident node outright. */
  skipped: boolean;
  /** `true` only once a systemd unit was actually installed/updated on the remote. `false` for a skip, an `unsupported` host (no `systemd --user` — SPEC §7.23's "declining leaves the target fully usable"), or a genuine install failure. */
  installed: boolean;
  plan?: SystemdProvisionPlan;
  result?: SystemdProvisionResult;
}

export type ProvisionStep =
  VerifyAndPersistStep | RuntimeBootstrapStep | SupervisorInstallStep | ResidentNodeInstallStep;

export interface ProvisionResult {
  ok: boolean;
  targetId: string;
  /** Every step attempted, in order. Stops at the first failed step — later steps are simply absent, not reported as skipped (mirrors `local-guided-setup.ts`'s `LocalGuidedSetupResult.steps` contract). */
  steps: ProvisionStep[];
  /** The step {@link provision} stopped at, set only when `ok` is `false`. */
  failedStep?: ProvisionStepId;
}

/**
 * Inputs for the opt-in resident-node systemd unit (step 4). Field names
 * mirror `../config.ts`'s `NodeCliConfig`/env-var vocabulary exactly (see
 * {@link buildResidentNodeEnvironment}), since this is what actually ends up
 * in the generated unit's `Environment=` lines and must be genuinely
 * readable by `packages/node/src/main.ts` on the far end.
 *
 * `authToken`/`deviceToken` and `amk`/`recoveryCode` are accepted as plain
 * parameters, not minted here — the zero-touch pairing that fills them in
 * automatically is issues #398/#399, out of this module's scope.
 */
export interface ResidentNodeConfig {
  relayUrl: string;
  nodeId: string;
  /** Defaults to `nodeId` on the remote (same convention as `NodeCliConfig.deviceId`/`LocalGuidedSetupOptions.deviceId`); left undefined here, `main.ts` itself applies that default. */
  deviceId?: string;
  /** `LOOMBOX_AUTH_TOKEN`. Wins over `deviceToken` if both are set (mirrors `config.ts`'s own precedence). */
  authToken?: string;
  /** `LOOMBOX_DEVICE_TOKEN`. */
  deviceToken?: string;
  /** `LOOMBOX_ACCOUNT_ID`. */
  accountId?: string;
  /** `LOOMBOX_AMK`, base64. Wins over `recoveryCode` if both are set. */
  amk?: string;
  /** `LOOMBOX_RECOVERY_CODE`. */
  recoveryCode?: string;
  /** `CLAUDE_CODE_OAUTH_TOKEN` — the spawned Claude Code ACP agent's own credential (`deploy/node/README.md`'s "Get a device token"/env docs), not read by `@loombox/node` itself but inherited by the child process it spawns. */
  claudeCodeOAuthToken?: string;
  /** `LOOMBOX_NODE_STATE_DIR`. */
  stateDir?: string;
  /** Extra `Environment=` lines merged over the ones this function derives; a caller-supplied key never gets silently dropped even if this module doesn't yet know about it. */
  extraEnvironment?: Record<string, string>;
  /** Overrides the generated unit's file name; defaults to `systemd-provisioning.ts`'s `DEFAULT_UNIT_NAME`. */
  unitName?: string;
  /** Overrides the remote systemd user-unit directory; defaults to `$HOME/.config/systemd/user`. */
  unitDir?: string;
}

export interface ProvisionOptions {
  /** Builds the `RemoteTransport` for `target`; defaults to a real `Ssh2Transport` built the same way `NodeDaemon`'s own default `sshTransportFactory` does. Tests inject a `FakeTransport`/`LocalProcessTransport` factory instead. */
  transportFactory?: (config: SshTargetConfig) => RemoteTransport;
  /** Where step 1 persists `target` on success; defaults to a fresh `SshTargetStore()` (this node's default on-disk store). */
  store?: SshTargetStore;
  /**
   * The pooled, reconnecting transport steps 2-4 share. Pass the caller's
   * own long-lived pool (e.g. `NodeDaemon`'s) to leave the connection open
   * and reusable for the very first session afterward; omitted, this
   * function opens a private pool for the duration of the call and closes
   * it before returning (success or failure) so a one-shot `provision()`
   * call never leaks a connection.
   */
  transportPool?: SshTransportPool;
  runtime?: {
    /** Skips step 2 entirely — no remote call is made at all — for a caller that has already confirmed the runtime out of band. Defaults to `false`. */
    skip?: boolean;
    nodeVersion?: PlanRuntimeBootstrapOptions['nodeVersion'];
  };
  /** Step 3's inputs, passed straight through to `planSupervisorProvisioning`. */
  supervisor: PlanSupervisorProvisioningOptions;
  residentNode: {
    /** Declines the opt-in resident-node install outright (SPEC §7.23's "Optionally") — no remote call is made at all. Defaults to `false`. */
    skip?: boolean;
    config: ResidentNodeConfig;
    /** Appended after the staged supervisor binary in `ExecStart`; defaults to `['--node']` (the resident-node entry point, as opposed to a one-shot supervised session). */
    execArgs?: string[];
    workingDirectory?: string;
  };
  /** Called once per step, right after it completes, with the same object that lands in `ProvisionResult.steps` — a caller (a future add-target wizard/RPC) uses this to stream progress rather than waiting for the whole sequence. */
  onProgress?: (step: ProvisionStep) => void;
}

function defaultTransportFactory(config: SshTargetConfig): RemoteTransport {
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

/** Maps {@link ResidentNodeConfig} onto the exact `LOOMBOX_*`/`CLAUDE_CODE_OAUTH_TOKEN` env-var names `../config.ts`'s `loadNodeConfig` and `deploy/node/loombox-node.env.example` document, so the generated unit's `Environment=` lines are genuinely what `main.ts` reads on the far end. */
export function buildResidentNodeEnvironment(config: ResidentNodeConfig): Record<string, string> {
  const environment: Record<string, string> = {
    LOOMBOX_RELAY_URL: config.relayUrl,
    LOOMBOX_NODE_ID: config.nodeId,
  };
  if (config.deviceId) environment.LOOMBOX_DEVICE_ID = config.deviceId;
  if (config.authToken) {
    environment.LOOMBOX_AUTH_TOKEN = config.authToken;
  } else if (config.deviceToken) {
    environment.LOOMBOX_DEVICE_TOKEN = config.deviceToken;
  }
  if (config.accountId) environment.LOOMBOX_ACCOUNT_ID = config.accountId;
  if (config.amk) {
    environment.LOOMBOX_AMK = config.amk;
  } else if (config.recoveryCode) {
    environment.LOOMBOX_RECOVERY_CODE = config.recoveryCode;
  }
  if (config.claudeCodeOAuthToken)
    environment.CLAUDE_CODE_OAUTH_TOKEN = config.claudeCodeOAuthToken;
  if (config.stateDir) environment.LOOMBOX_NODE_STATE_DIR = config.stateDir;
  return { ...environment, ...(config.extraEnvironment ?? {}) };
}

/**
 * Runs the full `ssh:` auto-provisioning sequence (SPEC §7.23) against
 * `target`, in order:
 *
 * 1. **verify_and_persist** — `verifyAndPersistSshTarget`: tests the
 *    connection for real and, only on success, persists `target` to `store`.
 * 2. **runtime_bootstrap** — `planRuntimeBootstrap` +
 *    `executeRuntimeBootstrap`: detects the remote OS/arch and installs the
 *    runtime the agent CLI needs if missing.
 * 3. **supervisor_install** — `planSupervisorProvisioning` +
 *    `executeSupervisorProvisioning`: stages the signed agent-supervisor
 *    artifact.
 * 4. **resident_node_install** — `planSystemdProvisioning` +
 *    `executeSystemdProvisioning`: installs the opt-in `systemd --user`
 *    resident-node unit, `ExecStart`ing the just-staged supervisor binary
 *    with `--node` and an `Environment=` built from
 *    {@link buildResidentNodeEnvironment}.
 *
 * Each step is exactly as idempotent/re-runnable as the primitive it calls
 * (an unchanged remote replans to `noop` and touches nothing) — this
 * function adds no extra state of its own beyond passing the previous step's
 * resolved paths (the supervisor's `baseDir`) into the next one.
 *
 * Stops at the first failed step (`ProvisionResult.ok: false`,
 * `failedStep` naming it) — later steps are never attempted, matching
 * `local-guided-setup.ts`'s same contract. A host that genuinely can't run
 * the opt-in resident node (`action: 'unsupported'`, e.g. no `systemd
 * --user`) is **not** treated as a failure: SPEC §7.23 calls this step
 * optional, and "declining leaves the target fully usable" applies equally
 * whether a user declined or the host simply can't do it — surfaced as
 * `installed: false` on an otherwise-`ok` step instead.
 */
export async function provision(
  target: SshTargetConfig,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const transportFactory = options.transportFactory ?? defaultTransportFactory;
  const store = options.store ?? new SshTargetStore();
  const steps: ProvisionStep[] = [];
  const onProgress = options.onProgress;

  const emit = <T extends ProvisionStep>(step: T): T => {
    steps.push(step);
    onProgress?.(step);
    return step;
  };

  const verify = await verifyAndPersistSshTarget(target, transportFactory, store);
  const verifyStep = emit<VerifyAndPersistStep>({
    step: 'verify_and_persist',
    ok: verify.ok,
    message: verify.ok
      ? `connection to "${target.id}" (${target.host}) verified and persisted`
      : `failed to verify "${target.id}": ${verify.message}`,
    verify,
  });
  if (!verifyStep.ok) {
    return { ok: false, targetId: target.id, steps, failedStep: 'verify_and_persist' };
  }

  const ownsPool = !options.transportPool;
  const pool = options.transportPool ?? new SshTransportPool();

  try {
    const transport = await pool.get(target.id, () => transportFactory(target));

    // Step 2: runtime bootstrap.
    let runtimeStep: RuntimeBootstrapStep;
    if (options.runtime?.skip) {
      runtimeStep = emit<RuntimeBootstrapStep>({
        step: 'runtime_bootstrap',
        ok: true,
        skipped: true,
        message: 'runtime bootstrap skipped (caller already confirmed the remote runtime)',
      });
    } else {
      const plan = await planRuntimeBootstrap(transport, {
        nodeVersion: options.runtime?.nodeVersion,
      });
      const result = await executeRuntimeBootstrap(transport, plan);
      runtimeStep = emit<RuntimeBootstrapStep>({
        step: 'runtime_bootstrap',
        ok: result.ok,
        skipped: false,
        plan,
        result,
        message: result.ok
          ? plan.message
          : `runtime bootstrap failed${result.failedAt ? ` at "${result.failedAt}"` : ''}: ${plan.message}`,
      });
    }
    if (!runtimeStep.ok) {
      return { ok: false, targetId: target.id, steps, failedStep: 'runtime_bootstrap' };
    }

    // Step 3: signed supervisor artifact install/upgrade.
    const supervisorPlan = await planSupervisorProvisioning(transport, options.supervisor);
    const supervisorResult = await executeSupervisorProvisioning(transport, supervisorPlan);
    const supervisorStep = emit<SupervisorInstallStep>({
      step: 'supervisor_install',
      ok: supervisorResult.ok,
      plan: supervisorPlan,
      result: supervisorResult,
      message: supervisorResult.ok
        ? supervisorPlan.message
        : `supervisor install failed: ${supervisorResult.error ?? supervisorPlan.message}`,
    });
    if (!supervisorStep.ok) {
      return { ok: false, targetId: target.id, steps, failedStep: 'supervisor_install' };
    }

    // Step 4: opt-in resident-node systemd unit, ExecStart-ing the binary
    // step 3 just staged with `--node`.
    let residentNodeStep: ResidentNodeInstallStep;
    if (options.residentNode.skip) {
      residentNodeStep = emit<ResidentNodeInstallStep>({
        step: 'resident_node_install',
        ok: true,
        skipped: true,
        installed: false,
        message: 'resident-node install skipped by caller',
      });
    } else {
      const unitConfig: SystemdUnitConfig = {
        execStart: `${supervisorPlan.baseDir}/supervisor-bin`,
        execArgs: options.residentNode.execArgs ?? ['--node'],
        workingDirectory: options.residentNode.workingDirectory,
        environment: buildResidentNodeEnvironment(options.residentNode.config),
        description: 'loombox resident node',
      };
      const plan = await planSystemdProvisioning(transport, {
        unit: unitConfig,
        unitName: options.residentNode.config.unitName,
        unitDir: options.residentNode.config.unitDir,
      });
      if (plan.action === 'unsupported') {
        residentNodeStep = emit<ResidentNodeInstallStep>({
          step: 'resident_node_install',
          ok: true,
          skipped: false,
          installed: false,
          plan,
          message: plan.message,
        });
      } else {
        const result = await executeSystemdProvisioning(transport, plan);
        residentNodeStep = emit<ResidentNodeInstallStep>({
          step: 'resident_node_install',
          ok: result.ok,
          skipped: false,
          installed: result.ok,
          plan,
          result,
          message: result.ok ? plan.message : (result.error ?? plan.message),
        });
      }
    }
    if (!residentNodeStep.ok) {
      return { ok: false, targetId: target.id, steps, failedStep: 'resident_node_install' };
    }

    return { ok: true, targetId: target.id, steps };
  } finally {
    if (ownsPool) {
      await pool.closeAll().catch(() => {
        /* best-effort cleanup of this call's own private pool */
      });
    }
  }
}

export interface DecommissionOptionsInput extends Omit<DecommissionOptions, 'targetId'> {
  transportFactory?: (config: SshTargetConfig) => RemoteTransport;
  store?: SshTargetStore;
}

/**
 * Opens a fresh transport for `target`, decommissions it
 * (`decommissionSshTarget`), and always closes that transport before
 * returning — the counterpart to {@link provision}, reusing `./decommission.ts`
 * unchanged rather than reimplementing any of its stop/disable/revoke/
 * cleanup logic.
 */
export async function decommission(
  target: SshTargetConfig,
  options: DecommissionOptionsInput = {},
): Promise<DecommissionResult> {
  const {
    transportFactory = defaultTransportFactory,
    store = new SshTargetStore(),
    ...decommissionOptions
  } = options;
  const transport = transportFactory(target);
  await transport.connect();
  try {
    return await decommissionSshTarget(transport, store, {
      targetId: target.id,
      ...decommissionOptions,
    });
  } finally {
    await transport.close();
  }
}
