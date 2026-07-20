import { detectRemoteOsArch, type RemoteOsArch } from './remote-runtime';
import { shQuote, type RemoteTransport } from './remote-transport';
import {
  verifySupervisorArtifact,
  type ArtifactVerifyFailureReason,
  type SupervisorArtifact,
  type SupervisorArtifactSource,
} from './supervisor-artifact';

/**
 * Auto-provisions and idempotently re-provisions the agent-supervisor on an
 * `ssh:` target (issues #86, #87; SPEC §7.23). Two files under one
 * `baseDir` on the remote are this module's entire on-disk footprint:
 * `<baseDir>/VERSION` (a plain text version marker — the state
 * {@link readRemoteSupervisorVersion} reads and idempotency is decided
 * against) and `<baseDir>/supervisor-bin` (the staged artifact payload,
 * `chmod +x`'d). Both are written only after
 * {@link verifySupervisorArtifact} has accepted the artifact, and the
 * version marker is written last and re-read to confirm it stuck (the
 * "install-then-verify" recipe SPEC §16 calls out as novel) — a caller can
 * trust that a `readRemoteSupervisorVersion` reporting `targetVersion` means
 * the matching signed bytes are genuinely staged, not that a marker file
 * was written optimistically.
 *
 * Follows the same **plan/execute split** `remote-runtime.ts` already
 * established: {@link planSupervisorProvisioning} only reads (remote OS/arch,
 * remote version marker) plus fetches+verifies a candidate artifact
 * (no remote writes), and returns a diff of what running it would change
 * (issue #87's "each run prints a diff... before applying anything");
 * {@link executeSupervisorProvisioning} is the only function that writes to
 * the remote, and only ever for a plan whose `action` is `install`/`upgrade`.
 */
export type SupervisorProvisionAction = 'noop' | 'install' | 'upgrade' | 'unsupported' | 'refused';

export interface SupervisorProvisionPlan {
  osArch: RemoteOsArch;
  /** The remote directory (resolved via `$HOME`, or overridden) this target's supervisor is staged under. */
  baseDir: string;
  currentVersion: string | undefined;
  targetVersion: string;
  action: SupervisorProvisionAction;
  message: string;
  /** What this run would change, in order, shown to the user before {@link executeSupervisorProvisioning} ever runs. Empty for `noop`/`unsupported`/`refused`. */
  changes: string[];
  /** Set only when `action` is `install`/`upgrade`: the already-verified artifact `executeSupervisorProvisioning` will stage. Never set otherwise — a `refused` plan carries no artifact forward, so nothing downstream can accidentally use bytes that just failed verification. */
  artifact?: SupervisorArtifact;
  /** Set only when `action` is `refused`: why the fetched artifact was rejected. */
  refusalReason?: ArtifactVerifyFailureReason;
}

export interface PlanSupervisorProvisioningOptions {
  /** Where a candidate artifact for the remote's OS/arch comes from (issue #86); see `supervisor-artifact.ts`'s doc comment for why this is an injected interface rather than a built-in fetcher. */
  artifactSource: SupervisorArtifactSource;
  targetVersion: string;
  /** This node's pinned Ed25519 public key (raw 32 bytes), checked against every fetched artifact before it's ever staged. */
  publicKey: Uint8Array;
  /** Overrides the remote base directory; defaults to `$HOME/.loombox/supervisor`, resolved via the transport. */
  baseDir?: string;
}

const VERSION_MARKER_NAME = 'VERSION';
const ARTIFACT_FILE_NAME = 'supervisor-bin';

/** Resolves `$HOME/.loombox/supervisor` on the remote (mirrors `RemoteProcessRunner.resolveBaseDir`'s own convention for its sibling `~/.loombox/remote-sessions` directory). */
export async function resolveSupervisorBaseDir(transport: RemoteTransport): Promise<string> {
  const result = await transport.exec('printf %s "$HOME/.loombox/supervisor"');
  return result.stdout.trim();
}

/** Reads the remote's currently-staged supervisor version, or `undefined` if nothing is staged yet (no marker file, or an empty one). Read-only — never used for anything except deciding whether/what to provision. */
export async function readRemoteSupervisorVersion(
  transport: RemoteTransport,
  baseDir: string,
): Promise<string | undefined> {
  const result = await transport.exec(
    `cat ${shQuote(`${baseDir}/${VERSION_MARKER_NAME}`)} 2>/dev/null`,
  );
  const version = result.stdout.trim();
  return version.length > 0 ? version : undefined;
}

/**
 * Detects the remote OS/arch and current staged version, and decides what
 * (if anything) needs to change to reach `options.targetVersion` — without
 * writing anything to the remote. An unrecognized OS/arch short-circuits to
 * `'unsupported'` before ever calling `options.artifactSource.fetch` (no
 * point fetching a build for a host that can't run it); an already-current
 * remote short-circuits to `'noop'` the same way (no point fetching a build
 * that won't be used). Only when an actual install/upgrade might be needed
 * does this fetch a candidate artifact and verify its signature
 * (`verifySupervisorArtifact`) — a verification failure becomes `'refused'`,
 * carrying no artifact forward, so nothing downstream can ever stage or run
 * bytes this function didn't trust.
 */
export async function planSupervisorProvisioning(
  transport: RemoteTransport,
  options: PlanSupervisorProvisioningOptions,
): Promise<SupervisorProvisionPlan> {
  const osArch = await detectRemoteOsArch(transport);
  const baseDir = options.baseDir ?? (await resolveSupervisorBaseDir(transport));

  if (osArch.os === 'unknown' || osArch.arch === 'unknown') {
    return {
      osArch,
      baseDir,
      currentVersion: undefined,
      targetVersion: options.targetVersion,
      action: 'unsupported',
      changes: [],
      message:
        `loombox doesn't know how to provision the supervisor on ${osArch.rawOs}/${osArch.rawArch} — ` +
        'this host needs manual setup before it can run an ssh: target session.',
    };
  }

  const currentVersion = await readRemoteSupervisorVersion(transport, baseDir);

  if (currentVersion === options.targetVersion) {
    return {
      osArch,
      baseDir,
      currentVersion,
      targetVersion: options.targetVersion,
      action: 'noop',
      changes: [],
      message: `supervisor ${options.targetVersion} is already staged at ${baseDir} — nothing to do.`,
    };
  }

  const artifact = await options.artifactSource.fetch(osArch, options.targetVersion);
  const verification = verifySupervisorArtifact(artifact, options.publicKey);
  if (!verification.ok) {
    return {
      osArch,
      baseDir,
      currentVersion,
      targetVersion: options.targetVersion,
      action: 'refused',
      changes: [],
      refusalReason: verification.reason,
      message: `refusing to provision supervisor ${options.targetVersion}: ${verification.message}`,
    };
  }

  const action: SupervisorProvisionAction = currentVersion === undefined ? 'install' : 'upgrade';
  const changes = [
    `stage supervisor ${options.targetVersion} (${artifact.bytes.byteLength} bytes) at ${baseDir}/${ARTIFACT_FILE_NAME}`,
    `write version marker ${baseDir}/${VERSION_MARKER_NAME} = ${options.targetVersion}`,
  ];

  return {
    osArch,
    baseDir,
    currentVersion,
    targetVersion: options.targetVersion,
    action,
    changes,
    artifact,
    message:
      action === 'install'
        ? `installing supervisor ${options.targetVersion} on ${osArch.rawOs}/${osArch.rawArch}.`
        : `upgrading supervisor from ${currentVersion} to ${options.targetVersion} on ${osArch.rawOs}/${osArch.rawArch}.`,
  };
}

export interface SupervisorProvisionResult {
  ok: boolean;
  action: SupervisorProvisionAction;
  /** The version now staged on the remote, once `ok` — for `noop` this is `plan.currentVersion` (nothing changed); for `install`/`upgrade` it's `plan.targetVersion`, re-read from the remote marker to confirm the write actually stuck. */
  installedVersion?: string;
  error?: string;
}

/**
 * Applies `plan` (from {@link planSupervisorProvisioning}) to the remote.
 * `noop` and `unsupported`/`refused` plans never touch the transport at all
 * — a `noop` because there's genuinely nothing to do, `unsupported`/`refused`
 * because running anything would defeat the point of refusing. Only
 * `install`/`upgrade` actually writes: the artifact bytes (base64-transported
 * over `exec`'s string-only stdin, decoded remotely — `RemoteTransport` has
 * no binary-safe channel, see its own doc comment), `chmod +x`, then the
 * version marker last, re-read back to confirm the install truly landed
 * before reporting success.
 */
export async function executeSupervisorProvisioning(
  transport: RemoteTransport,
  plan: SupervisorProvisionPlan,
): Promise<SupervisorProvisionResult> {
  if (plan.action === 'noop') {
    return { ok: true, action: 'noop', installedVersion: plan.currentVersion };
  }
  if (plan.action === 'unsupported' || plan.action === 'refused') {
    return { ok: false, action: plan.action, error: plan.message };
  }

  if (!plan.artifact) {
    // A hand-built plan claiming install/upgrade without a verified artifact
    // is a caller bug (planSupervisorProvisioning never produces one), not a
    // remote-side failure — fail loudly rather than silently no-op.
    throw new Error(
      `executeSupervisorProvisioning: plan.action is "${plan.action}" but plan.artifact is missing`,
    );
  }

  const mkdirResult = await transport.exec(`mkdir -p ${shQuote(plan.baseDir)}`);
  if (mkdirResult.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      error: `mkdir -p ${plan.baseDir} failed (exit ${mkdirResult.exitCode}): ${mkdirResult.stderr}`,
    };
  }

  const binPath = `${plan.baseDir}/${ARTIFACT_FILE_NAME}`;
  const base64Payload = Buffer.from(plan.artifact.bytes).toString('base64');
  const writeResult = await transport.exec(`base64 -d > ${shQuote(binPath)}`, {
    input: base64Payload,
  });
  if (writeResult.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      error: `staging ${binPath} failed (exit ${writeResult.exitCode}): ${writeResult.stderr}`,
    };
  }

  const chmodResult = await transport.exec(`chmod +x ${shQuote(binPath)}`);
  if (chmodResult.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      error: `chmod +x ${binPath} failed (exit ${chmodResult.exitCode}): ${chmodResult.stderr}`,
    };
  }

  const markerPath = `${plan.baseDir}/${VERSION_MARKER_NAME}`;
  const markerResult = await transport.exec(
    `printf '%s' ${shQuote(plan.targetVersion)} > ${shQuote(markerPath)}`,
  );
  if (markerResult.exitCode !== 0) {
    return {
      ok: false,
      action: plan.action,
      error: `writing ${markerPath} failed (exit ${markerResult.exitCode}): ${markerResult.stderr}`,
    };
  }

  // Install-then-verify (SPEC §16): re-read the marker rather than trusting
  // the write's exit code alone.
  const installedVersion = await readRemoteSupervisorVersion(transport, plan.baseDir);
  if (installedVersion !== plan.targetVersion) {
    return {
      ok: false,
      action: plan.action,
      error:
        `post-install verification failed: remote ${markerPath} reads ` +
        `${JSON.stringify(installedVersion)}, expected ${JSON.stringify(plan.targetVersion)}`,
    };
  }

  return { ok: true, action: plan.action, installedVersion };
}
