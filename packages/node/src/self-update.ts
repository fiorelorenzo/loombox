import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildIdentityV1, type BuildIdentityV1 } from '@loombox/protocol';

import type { InstallLayoutDriver } from './install-layout';
import { rollbackVersion } from './install-layout';
import { compareVersions } from './ssh/target-update-monitor';
import { verifySupervisorArtifact } from './ssh/supervisor-artifact';

const execFileAsync = promisify(execFile);

/**
 * The node's own atomic self-update (issue #656; epic #653). Builds
 * directly on #817's install layout (`./install-layout.ts`'s
 * stage/activate/rollback verbs over `~/.loombox/versions/<version>/` +
 * `current`) — this module owns none of the filesystem/symlink mechanics
 * itself, only the sequencing: fetch, optionally verify a signature,
 * stage, verify the STAGED build actually starts and reports its own
 * identity (issue #656's "a version that cannot start never becomes
 * current"), and only then flip `current` and hand off to whatever
 * restarts this process (systemd/launchd's `Restart=always`/`KeepAlive`,
 * per the epic's "let the service manager do the restart").
 *
 * Deliberately never crosses the restart boundary to health-gate the NEW
 * process instance — see {@link applyNodeSelfUpdate}'s own doc comment for
 * why the staged-build probe already covers that without needing a second,
 * post-restart check.
 */

/** One fetched, not-yet-staged node bundle: `bytes` is the gzipped tar `install-layout.ts`'s `stageVersion` extracts (`node.mjs` + trimmed `package.json` + native modules, flat — `scripts/package-node-release.mjs`'s own layout). `signature` mirrors `SupervisorArtifact`'s own optional detached Ed25519 signature; today's real `node-<version>-<os>-<arch>.tar.gz` release assets ship unsigned (only the supervisor binary is signed), so this is `undefined` in production until a future release starts signing the node bundle too — {@link applyNodeSelfUpdate} only demands one when a `publicKey` is actually configured. */
export interface NodeUpdateArtifact {
  version: string;
  bytes: Uint8Array;
  signature: Uint8Array | undefined;
}

/**
 * Where this node learns about and fetches its own newer versions.
 * Deliberately just an interface, exactly like `SupervisorArtifactSource`'s
 * own doc comment explains for the same reason: the real implementation
 * (`./github-node-update-source.ts`, GitHub Releases) is one concrete
 * answer, injected wholesale so tests never need real network.
 */
export interface NodeUpdateSource {
  /** The newest version this source currently knows about, or `undefined` when that can't be determined (no releases found, nothing matches this platform) — never throws for "nothing newer", only for a real fetch failure (network error, malformed response). */
  checkLatest(): Promise<{ version: string; commit?: string } | undefined>;
  /** Downloads `version`'s bundle for this node's own platform. Rejects if `version` doesn't exist for this platform. */
  fetch(version: string): Promise<NodeUpdateArtifact>;
}

/**
 * Mirrors `@loombox/protocol`'s `NodeSelfUpdateStatusV1` field-for-field —
 * see that module's doc comment for why this uses its own vocabulary
 * rather than `TargetVersionStatus`'s `'behind'`/`'ahead'`.
 */
export type NodeUpdateStatus = 'current' | 'update_available' | 'unknown';

/** Pure comparison, no I/O: `latestVersion` absent (a check that failed, or never ran) is always `'unknown'` — never guessed as `'current'`, the same "absence never reads as an answer" contract `buildIdentityMismatch` and `compareTargetVersion` both already keep. */
export function evaluateNodeUpdateStatus(
  currentVersion: string,
  latestVersion: string | undefined,
): NodeUpdateStatus {
  if (!latestVersion) return 'unknown';
  return compareVersions(latestVersion, currentVersion) > 0 ? 'update_available' : 'current';
}

export interface VerifyStagedNodeBuildOptions {
  /**
   * Runs the staged bundle's own `--version` handler and returns its raw
   * stdout — defaults to a real `execFile(process.execPath, [entryPath,
   * '--version'])`, exactly what `main.ts`'s own `printBuildIdentity` doc
   * comment describes as "the one way to prove a freshly unpacked bundle
   * reports its real version+commit... before it's ever wired up with real
   * relay credentials". Tests inject a fake so "a deliberately broken
   * build" (issue #656's own acceptance phrase) never needs a real,
   * fully-dependency-resolved `@loombox/node` bundle on disk — a tiny
   * fixture script that prints JSON (or doesn't) is a real subprocess spawn
   * either way, never a mock of THIS module's own verification logic.
   */
  runVersionProbe?: (entryPath: string) => Promise<string>;
  /** Milliseconds before the probe subprocess is killed and treated as a failure (a build that hangs is exactly as disqualifying as one that crashes). Defaults to 10s — generous for a cold Node start, short enough that a hung update attempt fails fast rather than blocking the operator's one-tap action indefinitely. */
  timeoutMs?: number;
}

export type VerifyStagedNodeBuildResult =
  { ok: true; identity: BuildIdentityV1 } | { ok: false; message: string };

async function defaultVersionProbe(entryPath: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [entryPath, '--version'], {
    timeout: timeoutMs,
  });
  return stdout;
}

/**
 * Issue #656's "verify the staged version before the swap: it starts, it
 * reports its identity" gate. Spawns `entryPath --version` (a real
 * `@loombox/node` bundle resolves this to `main.ts`'s own
 * `printBuildIdentity`, which prints `{version, commit}` as JSON and exits
 * 0, touching no relay/identity/AMK) and checks the result actually parses
 * as a `BuildIdentityV1` reporting `expectedVersion` — never merely that
 * the process exited 0, since a build that starts but reports the WRONG
 * version (a packaging bug) is exactly as disqualifying as one that
 * crashes.
 */
export async function verifyStagedNodeBuild(
  entryPath: string,
  expectedVersion: string,
  options: VerifyStagedNodeBuildOptions = {},
): Promise<VerifyStagedNodeBuildResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const probe =
    options.runVersionProbe ?? ((entry: string) => defaultVersionProbe(entry, timeoutMs));

  let stdout: string;
  try {
    stdout = await probe(entryPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `staged build did not start: ${detail}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      message: `staged build's --version output was not valid JSON: ${stdout.trim().slice(0, 200)}`,
    };
  }
  const parsed = buildIdentityV1.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: `staged build reported an identity that does not parse: ${stdout.trim().slice(0, 200)}`,
    };
  }
  if (parsed.data.version !== expectedVersion) {
    return {
      ok: false,
      message: `staged build reports version ${parsed.data.version}, expected ${expectedVersion}`,
    };
  }
  return { ok: true, identity: parsed.data };
}

/** Every distinguishable outcome {@link applyNodeSelfUpdate} can report — mirrors `@loombox/protocol`'s `nodeSelfUpdateApplyResponse.message`'s free-text field, but kept as a discriminant here so a caller (`NodeSelfUpdateMonitor`, `NodeDaemon`) can branch on it without parsing prose. */
export type NodeSelfUpdateAction =
  | 'activated'
  | 'fetch_failed'
  | 'signature_invalid'
  | 'verification_failed'
  | 'activation_failed_rolled_back';

export interface NodeSelfUpdateOutcome {
  ok: boolean;
  action: NodeSelfUpdateAction;
  fromVersion: string;
  /** Present only when `ok` is `true` — a failed attempt never reports having moved. */
  toVersion?: string;
  message: string;
}

export interface ApplyNodeSelfUpdateOptions {
  /** `~/.loombox` (or an injected temp dir in tests) — `install-layout.ts`'s own `baseDir`, the parent of `versions/` and `current`. */
  baseDir: string;
  driver: InstallLayoutDriver;
  source: NodeUpdateSource;
  /** This node's own currently-running version (`readNodeBuildIdentity().version`) — the "from" state for both the outcome and rollback, sourced from the RUNNING process rather than re-derived from `driver.currentVersion`, so it's honest even if `current` and the live process have somehow drifted. */
  currentVersion: string;
  targetVersion: string;
  /** This node's pinned Ed25519 public key (raw 32 bytes), checked against the fetched artifact's signature when set — mirrors `PlanSupervisorProvisioningOptions.publicKey`. Omitted today: real `node-<version>-<os>-<arch>.tar.gz` release assets ship unsigned (see `NodeUpdateArtifact`'s own doc comment), so verification is opt-in rather than a lie about what's actually checked. */
  publicKey?: Uint8Array;
  /**
   * Hands control back to whatever supervises this process (systemd's
   * `Restart=always`, launchd's `KeepAlive`) — the epic's own "let the
   * service manager do the restart", never hand-rolled here. Defaults to
   * `() => process.exit(0)`; tests inject a no-op so a passing test suite
   * never actually kills the test runner's own process. Only ever called
   * AFTER `current` has been flipped to `targetVersion` and the staged
   * build has already proven it starts and reports the right identity —
   * see this function's own doc comment for why there's no SEPARATE
   * post-restart health gate to wait for.
   */
  restart: () => void | Promise<void>;
  /** See {@link VerifyStagedNodeBuildOptions.runVersionProbe}. */
  runVersionProbe?: (entryPath: string) => Promise<string>;
  probeTimeoutMs?: number;
}

/**
 * The whole stage -> verify -> activate -> restart sequence (issue #656),
 * run entirely within THIS process, never crossing the restart boundary:
 * {@link verifyStagedNodeBuild} spawns the exact same bundle a real restart
 * would hand control to, from the exact same files `activateVersion` would
 * point `current` at — so proving it starts and reports `targetVersion`
 * BEFORE ever flipping the symlink already IS the health gate the epic
 * describes ("health-gate after the swap and roll back... if the new one
 * does not come back"), just performed pre-swap rather than post-restart.
 * A pre-swap gate is strictly safer than a post-restart one: it can never
 * leave a live symlink pointed at a build that turned out to be broken.
 *
 * `driver.activateVersion` itself failing (a real filesystem/permission
 * problem, distinct from the build being bad) is the other rollback path:
 * caught and rolled back via {@link rollbackVersion} to `currentVersion`
 * — which install-layout's own `removeVersion` refuses to ever have
 * deleted while it was live, so it's always still staged and needs no
 * network to roll back to (issue #656's own "keep the previous version on
 * disk" requirement).
 *
 * `restart` is only ever called on the success path, once `current` is
 * already live at `targetVersion` — every failure path returns without
 * ever touching the running process, so "the node still runs" after a
 * failed update is true by construction, not by a separate check.
 */
export async function applyNodeSelfUpdate(
  options: ApplyNodeSelfUpdateOptions,
): Promise<NodeSelfUpdateOutcome> {
  const { baseDir, driver, source, currentVersion, targetVersion, publicKey, restart } = options;

  let artifact: NodeUpdateArtifact;
  try {
    artifact = await source.fetch(targetVersion);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action: 'fetch_failed',
      fromVersion: currentVersion,
      message: `failed to fetch node ${targetVersion}: ${detail}`,
    };
  }

  if (publicKey) {
    const verification = verifySupervisorArtifact(artifact, publicKey);
    if (!verification.ok) {
      return {
        ok: false,
        action: 'signature_invalid',
        fromVersion: currentVersion,
        message: `staged node ${targetVersion} failed signature verification (${verification.reason}); never staged live`,
      };
    }
  }

  await driver.stageVersion(baseDir, targetVersion, artifact.bytes);

  const stagedEntry = path.join(baseDir, 'versions', targetVersion, 'node.mjs');
  const verification = await verifyStagedNodeBuild(stagedEntry, targetVersion, {
    runVersionProbe: options.runVersionProbe,
    timeoutMs: options.probeTimeoutMs,
  });
  if (!verification.ok) {
    return {
      ok: false,
      action: 'verification_failed',
      fromVersion: currentVersion,
      message: `staged node ${targetVersion} failed to start/report its identity (${verification.message}); staying on ${currentVersion}`,
    };
  }

  try {
    await driver.activateVersion(baseDir, targetVersion);
  } catch (error) {
    await rollbackVersion(driver, baseDir, currentVersion).catch(() => {
      // Best-effort: `activateVersion(targetVersion)` above already threw,
      // meaning `current` most likely never moved off `currentVersion` in
      // the first place — a rollback failure here is never worse than the
      // activation failure already being reported.
    });
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action: 'activation_failed_rolled_back',
      fromVersion: currentVersion,
      message: `activating ${targetVersion} failed (${detail}); rolled back to ${currentVersion}`,
    };
  }

  await restart();

  return {
    ok: true,
    action: 'activated',
    fromVersion: currentVersion,
    toVersion: targetVersion,
    message: `updated ${currentVersion} -> ${targetVersion}; restarting to apply`,
  };
}
