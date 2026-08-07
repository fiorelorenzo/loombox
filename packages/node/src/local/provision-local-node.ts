import { exportPublicKeyRaw, generateEcdhKeyPair } from '@loombox/crypto';

import { NodeIdentityStore, type NodeIdentity } from '../identity';
import {
  DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME,
  writeWrappedAmkHandoff,
  type AmkHandoffActingIdentity,
} from '../ssh/amk-handoff-provision';
import { LocalProcessTransport } from '../ssh/local-process-transport';
import { mintNodeToken as defaultMintNodeToken } from '../ssh/mint-node-token';
import { buildResidentNodeEnvironment, type ResidentNodeConfig } from '../ssh/provision-target';
import type { RemoteTransport } from '../ssh/remote-transport';
import {
  executeRuntimeBootstrap,
  planRuntimeBootstrap,
  type PlanRuntimeBootstrapOptions,
} from '../ssh/remote-runtime';
import { defaultNodeStateDir } from '../ssh/verify-and-persist';
import type { SupervisorBackend } from '../supervisor-backend';

/**
 * Composes the shared zero-touch pairing primitives the `ssh:` reference
 * (`../ssh/provision-and-pair.ts`) already uses — `target_identity` (this
 * package's own `NodeIdentityStore`), `mint_node_token`
 * (`../ssh/mint-node-token.ts`), `amk_handoff`
 * (`../ssh/amk-handoff-provision.ts`) — with a `../supervisor-backend.ts`
 * install for the LOCAL machine's own resident node (issue #654's "the
 * node is installed as part of connecting"). Nothing here is ssh-specific:
 * `runtime_bootstrap` reuses `../ssh/remote-runtime.ts` unchanged against a
 * `RemoteTransport` — by default a real {@link LocalProcessTransport}
 * running commands on THIS machine, exactly the reuse this issue calls
 * for ("LocalProcessTransport already implements the transport interface
 * against the local machine") — and `resident_node_install` is dispatched
 * through the injected `options.backend`, never a platform check. That
 * makes this module itself the seam's second reusable half, alongside
 * `../supervisor-backend.ts`: #658/#659 (Linux/Windows local) reuse this
 * exact function unchanged, only swapping which `SupervisorBackend` they
 * pass in — never a fork of the orchestration sequence.
 *
 * **What this deliberately does not do:** decide the acting credentials.
 * `actingAuthToken` (a Better Auth session token or an existing device
 * token — `mintNodeToken`'s own doc comment: either works) and `amk` (the
 * account's own currently-unlocked AMK) are accepted as plain parameters,
 * exactly like `provisionAndPair`'s `actingAuthToken`/`amk` — this module
 * has no relay client of its own and no opinion on where those come from
 * (a desktop app's already-logged-in renderer, decision D1-1's "the
 * desktop app is the only install surface").
 *
 * **The acting identity for the AMK wrap is a throwaway keypair,
 * generated fresh for this one call and never persisted anywhere** —
 * unlike `provisionAndPair`'s `actingIdentity` (an ALREADY-paired node's
 * own durable device identity, doing the provisioning on another node's
 * behalf), there is no separate "acting node" here: the caller (this same
 * machine's own account session) is the one provisioning. Only the acting
 * public key needs to survive past this call (it's embedded in the
 * envelope so the resident node can derive the same ECDH shared secret
 * back on its own first start) — decision C1-2's "no durable secret at
 * rest" applies to this acting side too: the private half is used once,
 * in memory, and discarded when this function returns.
 */
export type LocalProvisionStepId =
  | 'runtime_bootstrap'
  | 'target_identity'
  | 'mint_node_token'
  | 'amk_handoff'
  | 'resident_node_install';

export type LocalProvisionStepStatus = 'started' | 'ok' | 'failed';

export interface LocalProvisionProgress {
  step: LocalProvisionStepId;
  status: LocalProvisionStepStatus;
  message: string;
}

export interface LocalProvisionResult {
  ok: boolean;
  /** Every step attempted, in order. Stops at the first failed step — later steps are simply absent, not reported as skipped (mirrors `provisionAndPair`'s own `ProvisionAndPairResult.progress` contract). */
  progress: LocalProvisionProgress[];
  failedStep?: LocalProvisionStepId;
  /** Set once `resident_node_install` actually starts: the device id the new resident node announces itself under. */
  deviceId?: string;
  /** Set once `resident_node_install` actually starts: the nodeId the new resident node connects/announces as. */
  nodeId?: string;
}

export interface LocalProvisionOptions {
  relayUrl: string;
  accountId: string;
  /** This caller's own bearer token — a Better Auth session token or an existing device token (`../ssh/mint-node-token.ts`'s own doc comment: either is accepted) — used to mint the new resident node's token. Never persisted by this module. */
  actingAuthToken: string;
  /** The account's currently-unlocked AMK, wrapped once for the freshly generated local device pubkey and handed off (decision C1-2). Never sent to the relay. */
  amk: Uint8Array;
  /** This caller's own currently-adopted AMK epoch; defaults to `@loombox/crypto`'s `AMK_HANDOFF_DEFAULT_EPOCH` (0) via `writeWrappedAmkHandoff` itself. */
  amkEpoch?: number;
  /** The nodeId the new resident node connects/announces as. */
  nodeId: string;
  /** The new resident's own device id; defaults to `nodeId`. */
  deviceId?: string;
  /** Label attached to the minted node token (`POST /account/node-tokens`'s `label`); defaults to `loombox node: <nodeId>`. */
  tokenLabel?: string;
  /** Passed straight to `CLAUDE_CODE_OAUTH_TOKEN` on the resident node (`ResidentNodeConfig.claudeCodeOAuthToken`); omit to leave that credential to be configured separately. */
  claudeCodeOAuthToken?: string;
  /** Overrides this node's own state dir (identity, the one-shot AMK-handoff file); defaults to `../ssh/verify-and-persist.ts`'s `defaultNodeStateDir()` (`~/.loombox/node`). Tests MUST override this — `defaultNodeStateDir()` refuses to run under Vitest (see its own doc comment). */
  stateDir?: string;
  /** The node-bundle version {@link SupervisorBackend.install} stages and activates. */
  version: string;
  /** Fetches the tar.gz bytes for `version` — passed straight through to `SupervisorBackend.install`. */
  fetchArchive: (version: string) => Promise<Uint8Array>;
  /** The platform's own `SupervisorBackend` — required, exactly like `provision()`/`provisionAndPair()` require `supervisor` with no built-in default: this module has no opinion on which platform it's running on. */
  backend: SupervisorBackend;
  runtime?: {
    /** Skips the runtime-bootstrap plan/execute entirely — no command beyond resolving `node`'s own path is run — for a caller that has already confirmed the local runtime out of band. Defaults to `false`. */
    skip?: boolean;
    nodeVersion?: PlanRuntimeBootstrapOptions['nodeVersion'];
  };
  /** The transport `runtime_bootstrap`/`target_identity`/`amk_handoff` run their commands over; defaults to a real {@link LocalProcessTransport} (this machine). Tests inject a `FakeTransport` instead. */
  transport?: RemoteTransport;
  /** Injectable for tests; defaults to a real `NodeIdentityStore({ stateDir })`. */
  identityStore?: NodeIdentityStore;
  /** Injectable for tests; defaults to `../ssh/mint-node-token.ts`'s real HTTP-backed implementation. */
  mintNodeToken?: typeof defaultMintNodeToken;
  /** Called once per step, right after it changes state (`'started'`, then `'ok'`/`'failed'`) — a caller (the desktop bridge) streams this to its own progress UI. */
  onProgress?: (progress: LocalProvisionProgress) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function provisionLocalNode(
  options: LocalProvisionOptions,
): Promise<LocalProvisionResult> {
  const mintNodeTokenImpl = options.mintNodeToken ?? defaultMintNodeToken;
  const stateDir = options.stateDir ?? defaultNodeStateDir();
  const nodeId = options.nodeId;
  const deviceId = options.deviceId ?? nodeId;

  const progress: LocalProvisionProgress[] = [];
  const onProgress = options.onProgress;
  const emit = (
    step: LocalProvisionStepId,
    status: LocalProvisionStepStatus,
    message: string,
  ): void => {
    const entry: LocalProvisionProgress = { step, status, message };
    progress.push(entry);
    onProgress?.(entry);
  };
  const fail = (step: LocalProvisionStepId, message: string): LocalProvisionResult => {
    emit(step, 'failed', message);
    return { ok: false, progress, failedStep: step };
  };

  const ownsTransport = !options.transport;
  const transport = options.transport ?? new LocalProcessTransport();

  try {
    // Step: runtime_bootstrap — reuses `../ssh/remote-runtime.ts` unchanged.
    // Connecting is folded into this step (rather than its own step, unlike
    // the ssh path's separate `verify_and_persist`): a local transport has
    // no "wrong host/credentials" failure mode of its own to name
    // separately, so a `connect()` failure is reported here.
    emit('runtime_bootstrap', 'started', 'checking for a system Node runtime');
    let nodeExecutable: string;
    try {
      await transport.connect();
      if (!options.runtime?.skip) {
        const plan = await planRuntimeBootstrap(transport, {
          nodeVersion: options.runtime?.nodeVersion,
        });
        const result = await executeRuntimeBootstrap(transport, plan);
        if (!result.ok) {
          return fail(
            'runtime_bootstrap',
            `runtime bootstrap failed${result.failedAt ? ` at "${result.failedAt}"` : ''}: ${plan.message}`,
          );
        }
      }
      const resolvedNode = await transport.exec('command -v node');
      nodeExecutable = resolvedNode.stdout.trim();
      if (!nodeExecutable) {
        return fail(
          'runtime_bootstrap',
          'no `node` executable found on PATH after runtime bootstrap',
        );
      }
    } catch (error) {
      return fail('runtime_bootstrap', `runtime bootstrap failed: ${errorMessage(error)}`);
    }
    emit('runtime_bootstrap', 'ok', `system Node runtime resolved at ${nodeExecutable}`);

    // Step: target_identity — this device's own durable identity (issue
    // #815's keyring-backed `NodeIdentityStore`), generated (or reused, on
    // a retried run) directly under `stateDir` — no shell round trip
    // needed, unlike the ssh path, since this machine IS the target.
    emit(
      'target_identity',
      'started',
      `preparing this node's own device identity under ${stateDir}`,
    );
    let identity: NodeIdentity;
    try {
      const identityStore = options.identityStore ?? new NodeIdentityStore({ stateDir });
      identity = await identityStore.loadOrCreate();
      emit('target_identity', 'ok', `device identity ready under ${stateDir}`);
    } catch (error) {
      return fail('target_identity', `failed to prepare device identity: ${errorMessage(error)}`);
    }

    // Step: mint_node_token — the authenticated mint, using the caller's
    // own bearer token, never a second device's approval.
    emit('mint_node_token', 'started', 'minting a node token for this device');
    let mintedToken: string;
    try {
      const minted = await mintNodeTokenImpl({
        relayUrl: options.relayUrl,
        authToken: options.actingAuthToken,
        label: options.tokenLabel ?? `loombox node: ${nodeId}`,
      });
      mintedToken = minted.token;
      emit('mint_node_token', 'ok', 'node token minted');
    } catch (error) {
      return fail('mint_node_token', `failed to mint a node token: ${errorMessage(error)}`);
    }

    // Step: amk_handoff — see this module's own doc comment for why the
    // acting identity here is a throwaway, never-persisted keypair.
    emit('amk_handoff', 'started', 'handing off the account key to this node');
    let wrappedAmkFilePath: string;
    try {
      const actingKeyPair = await generateEcdhKeyPair();
      const actingPublicKeyRaw = await exportPublicKeyRaw(actingKeyPair.publicKey);
      const actingIdentity: AmkHandoffActingIdentity = {
        keyPair: actingKeyPair,
        publicKeyRaw: actingPublicKeyRaw,
      };
      const handoff = await writeWrappedAmkHandoff(transport, {
        amk: options.amk,
        accountId: options.accountId,
        epoch: options.amkEpoch,
        actingIdentity,
        targetDeviceId: deviceId,
        targetDevicePublicKeyRaw: identity.publicKeyRaw,
        remotePath: `${stateDir}/${DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME}`,
      });
      if (!handoff.ok) return fail('amk_handoff', handoff.message);
      wrappedAmkFilePath = handoff.remotePath;
      emit('amk_handoff', 'ok', handoff.message);
    } catch (error) {
      return fail('amk_handoff', `failed to hand off the account key: ${errorMessage(error)}`);
    }

    // Step: resident_node_install — dispatched through the platform's own
    // `SupervisorBackend`, never a platform check in this module.
    emit('resident_node_install', 'started', 'installing and starting the resident node');
    try {
      const residentConfig: ResidentNodeConfig = {
        relayUrl: options.relayUrl,
        nodeId,
        deviceId,
        deviceToken: mintedToken,
        accountId: options.accountId,
        wrappedAmkFilePath,
        claudeCodeOAuthToken: options.claudeCodeOAuthToken,
        stateDir,
      };
      const installResult = await options.backend.install({
        version: options.version,
        fetchArchive: options.fetchArchive,
        nodeExecutable,
        environment: buildResidentNodeEnvironment(residentConfig),
      });
      if (!installResult.ok) {
        return fail('resident_node_install', installResult.message);
      }
      emit('resident_node_install', 'ok', installResult.message);
    } catch (error) {
      return fail(
        'resident_node_install',
        `failed to install the resident node: ${errorMessage(error)}`,
      );
    }

    return { ok: true, progress, deviceId, nodeId };
  } finally {
    if (ownsTransport) {
      await transport.close().catch(() => {
        /* best-effort cleanup of this call's own private transport */
      });
    }
  }
}
