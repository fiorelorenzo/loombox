import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  LocalProvisionOptions,
  LocalProvisionProgress,
  SupervisorBackend,
} from '@loombox/node';

import type {
  LocalProvisionProgressStep,
  ProvisionLocalNodeRequest,
  ProvisionLocalNodeResult,
} from '../../shared/bridge';

// Same native-module-avoidance reason as `./provision-target-bridge.ts`'s own
// top comment: `@loombox/node`'s barrel eagerly loads node-pty/@napi-rs/
// keyring, whose prebuilt binaries match Node's ABI, not Electron's — every
// runtime import below is therefore a lazy `await import('@loombox/node')`,
// only reached once a caller actually provisions.

/** Where a staged node release is read from by default — mirrors `./provision-target-bridge.ts`'s own `defaultReleasesDir()` for the sibling supervisor artifact (same root, `scripts/package-node-release.mjs`'s own `release/` layout deployed to `~/.loombox/releases`). */
function defaultReleasesDir(): string {
  return join(homedir(), '.loombox', 'releases');
}

/** `@loombox/node`'s own `package.json` `version` — every macOS-local node this app installs is brought to exactly that version, the same convention `./provision-target-bridge.ts`'s `resolveSupervisorTargetVersion` uses for the ssh: supervisor artifact. */
async function resolveNodeTargetVersion(): Promise<string> {
  const require = createRequire(import.meta.url);
  const nodeEntry = require.resolve('@loombox/node');
  // `nodeEntry` resolves through the package's own `exports` map
  // (`"." -> "./src/index.ts"`) to `.../packages/node/src/index.ts`; its
  // `package.json` lives two directories up from there — same derivation
  // `resolveSupervisorTargetVersion` uses for `@loombox/supervisor`,
  // since neither package's `exports` map defines a `./package.json`
  // subpath for `require.resolve` to reach directly.
  const packageJsonPath = join(dirname(dirname(nodeEntry)), 'package.json');
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`provision-local-node-bridge: ${packageJsonPath} has no valid "version" field`);
  }
  return parsed.version;
}

interface HostOsArch {
  os: 'linux' | 'darwin' | 'unknown';
  arch: 'x64' | 'arm64' | 'unknown';
  rawOs: string;
  rawArch: string;
}

/** This host's `RemoteOsArch`-shaped os/arch (`@loombox/node`'s own vocabulary, `scripts/package-node-release.mjs`'s `hostOsArch()` mirrored here) — an `'unknown'` os/arch never blocks resolving these deps; it surfaces as `SupervisorBackend.install`'s own `unsupported` action once actually attempted. */
function hostOsArch(): HostOsArch {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'unknown';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'unknown';
  return { os, arch, rawOs: process.platform, rawArch: process.arch };
}

/**
 * Everything {@link runProvisionLocalNode} needs beyond the request itself
 * (issue #654): the node-bundle version to install, where its bytes come
 * from (decision A1-2 + issue #817's real `createLocalFsNodeReleaseSource`),
 * and this platform's own `SupervisorBackend` (macOS-local: launchd). All
 * three are resolvable for real today — unlike `./provision-target-bridge
 * .ts`'s `resolveProvisionTargetDeps` (still `undefined`, waiting on
 * desktop-side account/AMK wiring), nothing here is missing: this half is
 * genuinely wired. What IS still missing is `ProvisionLocalNodeRequest`'s
 * own `actingAuthToken`/`amkBase64` — not a "deps" concern at all, since
 * those are per-call, renderer-supplied credentials (decision D1-1), not a
 * static dependency this module could resolve once at startup.
 */
export type ProvisionLocalNodeDeps = Pick<
  LocalProvisionOptions,
  | 'version'
  | 'fetchArchive'
  | 'backend'
  | 'transport'
  | 'identityStore'
  | 'mintNodeToken'
  | 'stateDir'
>;

export async function resolveProvisionLocalNodeDeps(
  options: { releasesDir?: string } = {},
): Promise<ProvisionLocalNodeDeps> {
  const { createLaunchdSupervisorBackend, createLocalFsNodeReleaseSource, createNodeLaunchdIo } =
    await import('@loombox/node');
  const version = await resolveNodeTargetVersion();
  const source = createLocalFsNodeReleaseSource({
    releasesDir: options.releasesDir ?? defaultReleasesDir(),
  });
  const osArch = hostOsArch();
  return {
    version,
    fetchArchive: (fetchVersion) => source.fetch(osArch, fetchVersion),
    backend: createLaunchdSupervisorBackend(createNodeLaunchdIo()),
  };
}

/**
 * Runs the real `@loombox/node` `provisionLocalNode()` sequence and
 * projects its result onto the bridge's plain-data
 * {@link ProvisionLocalNodeResult} shape — the macOS-local counterpart to
 * `./provision-target-bridge.ts`'s `runProvisionTarget`.
 */
export async function runProvisionLocalNode(
  request: ProvisionLocalNodeRequest,
  deps: ProvisionLocalNodeDeps,
): Promise<ProvisionLocalNodeResult> {
  const { provisionLocalNode } = await import('@loombox/node');
  const result = await provisionLocalNode({
    relayUrl: request.relayUrl,
    accountId: request.accountId,
    actingAuthToken: request.actingAuthToken,
    amk: new Uint8Array(Buffer.from(request.amkBase64, 'base64')),
    amkEpoch: request.amkEpoch,
    nodeId: request.nodeId,
    deviceId: request.deviceId,
    tokenLabel: request.tokenLabel,
    claudeCodeOAuthToken: request.claudeCodeOAuthToken,
    ...deps,
  });
  return {
    ok: result.ok,
    progress: result.progress.map(toProgressStep),
    failedStep: result.failedStep,
    deviceId: result.deviceId,
    nodeId: result.nodeId,
  };
}

function toProgressStep(progress: LocalProvisionProgress): LocalProvisionProgressStep {
  return { step: progress.step, status: progress.status, message: progress.message };
}
