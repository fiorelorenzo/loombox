import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import type {
  ProvisionOptions,
  ProvisionResult,
  ProvisionStep,
  SshTargetConfig,
} from '@loombox/node';

import type { ProvisionProgressStep, ProvisionTargetResult } from '../../shared/bridge';

// `@loombox/node`'s barrel eagerly loads native modules (@napi-rs/keyring,
// node-pty) whose prebuilt binaries match Node's ABI, not Electron's, which
// would crash the main process at startup. We only need `provision` when the
// user actually provisions a target, so load it lazily via a dynamic import
// to keep app launch free of any native-module load (issue #403 follow-up).

/**
 * The public half of the Ed25519 keypair every fetched supervisor artifact
 * is checked against (SPEC §16: "the node ships a pinned public key";
 * `verifySupervisorArtifact`'s own doc comment) — generated once via
 * `scripts/generate-supervisor-signing-key.mjs` (issue #817). The matching
 * private key signs release artifacts in `.github/workflows/release-
 * node.yml`, held only as the `SUPERVISOR_SIGNING_KEY` repo secret; it is
 * never checked in. Rotating: generate a new pair, ship the new public key
 * in a node release *before* signing anything with the new private key.
 */
const PINNED_SUPERVISOR_PUBLIC_KEY_B64 = 'thERD9oRaYndgS8xJUDQ6YHzRzfuLqGxegQwXZWH37A=';

/** Where {@link resolveSupervisorArtifactDeps} looks for staged releases by default — `scripts/package-node-release.mjs`'s own output directory, and the shape `createLocalFsSupervisorArtifactSource` reads (issue #817). Overridable so a build pulling from a real download cache (a future GitHub-Releases-backed source, same interface) can point elsewhere without this module changing. */
function defaultReleasesDir(): string {
  return join(homedir(), '.loombox', 'releases');
}

/** `@loombox/supervisor`'s own `package.json` `version` — every ssh: target this desktop app provisions is brought to exactly that version (`PlanSupervisorProvisioningOptions.targetVersion`'s own contract: "every target this node updates is brought to exactly this version"). Resolved via `require.resolve`, not a hardcoded path, so it always matches whatever `@loombox/supervisor` this app actually shipped with. */
async function resolveSupervisorTargetVersion(): Promise<string> {
  const require = createRequire(import.meta.url);
  const supervisorEntry = require.resolve('@loombox/supervisor');
  // `supervisorEntry` resolves through the package's own `exports` map
  // (`"." -> "./src/index.ts"`) to `.../packages/supervisor/src/index.ts`;
  // its `package.json` lives two directories up from there.
  const packageJsonPath = join(dirname(dirname(supervisorEntry)), 'package.json');
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    throw new Error(`provision-target-bridge: ${packageJsonPath} has no valid "version" field`);
  }
  return parsed.version;
}

/**
 * The real, working half of what {@link runProvisionTarget} needs beyond the
 * target itself (issue #817): a {@link SupervisorArtifactSource} plus its
 * pinned public key and target version, satisfying `supervisor-artifact.ts`'s
 * `verifySupervisorArtifact` signature check for real. Backed by
 * `createLocalFsSupervisorArtifactSource` — a local directory tree, not a
 * GitHub Releases fetch (out of reach from this pass; see that module's own
 * doc comment for why this is a genuine implementation and not a stub).
 */
export async function resolveSupervisorArtifactDeps(
  options: { releasesDir?: string } = {},
): Promise<Pick<ProvisionOptions, 'supervisor'>> {
  const { createLocalFsSupervisorArtifactSource } = await import('@loombox/node');
  const publicKey = new Uint8Array(Buffer.from(PINNED_SUPERVISOR_PUBLIC_KEY_B64, 'base64'));
  const targetVersion = await resolveSupervisorTargetVersion();
  return {
    supervisor: {
      artifactSource: createLocalFsSupervisorArtifactSource({
        releasesDir: options.releasesDir ?? defaultReleasesDir(),
      }),
      targetVersion,
      publicKey,
    },
  };
}

/**
 * Everything {@link runProvisionTarget} needs to actually drive
 * `@loombox/node`'s `provision()` (issue #400) end to end, beyond the
 * target itself: a signed supervisor-release artifact source + pinned
 * public key (SPEC §16 "Signed supervisor binary" — now real, see
 * {@link resolveSupervisorArtifactDeps}), and the resident node's
 * relay/identity config (the mint-token #398 + AMK-handoff #399 flows this
 * bridge is meant to eventually carry). Only the second half is still
 * missing — this app has no relay URL or device-identity source of its own
 * yet (`../local-node/bridge.ts`'s own TODO, same #398/#399 dependency) —
 * so {@link resolveProvisionTargetDeps} still returns `undefined` today,
 * honestly, rather than inventing a `residentNode.config`. A caller (a
 * future add-target wizard) supplies the full deps, spreading
 * {@link resolveSupervisorArtifactDeps}'s result in, once those issues
 * land; `runProvisionTarget` itself is real and fully wired today,
 * exercised in `provision-target-bridge.test.ts` against `@loombox/node`'s
 * own `FakeTransport`.
 */
export type ProvisionTargetDeps = Pick<
  ProvisionOptions,
  | 'transportFactory'
  | 'store'
  | 'transportPool'
  | 'runtime'
  | 'supervisor'
  | 'residentNode'
  | 'onProgress'
>;

/** TODO(#403 follow-up, tracked with #398/#399): no resident-node relay/identity config is wired into the desktop app yet — see this module's doc comment. The supervisor-artifact half is real ({@link resolveSupervisorArtifactDeps}); this still returns `undefined` because `residentNode.config` has no honest source. */
export function resolveProvisionTargetDeps(): ProvisionTargetDeps | undefined {
  return undefined;
}

/**
 * Runs the real `@loombox/node` `provision()` sequence against `target` and
 * projects its result onto the bridge's plain-data {@link
 * ProvisionTargetResult} shape (issue #403). `deps` is required here (not
 * defaulted to {@link resolveProvisionTargetDeps}'s `undefined`) so this
 * function has no "silently does nothing" mode of its own — the caller
 * (`../ipc/handlers.ts`) is the one place that decides what to do when deps
 * aren't configured yet.
 */
export async function runProvisionTarget(
  target: SshTargetConfig,
  deps: ProvisionTargetDeps,
): Promise<ProvisionTargetResult> {
  const { provision } = await import('@loombox/node');
  const result: ProvisionResult = await provision(target, deps);
  return {
    ok: result.ok,
    targetId: result.targetId,
    steps: result.steps.map(toProgressStep),
    failedStep: result.failedStep,
  };
}

function toProgressStep(step: ProvisionStep): ProvisionProgressStep {
  return { step: step.step, ok: step.ok, message: step.message };
}
