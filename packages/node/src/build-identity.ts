import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { BuildIdentityV1 } from '@loombox/protocol';

const execFileAsync = promisify(execFile);

/** This module's own directory, used both to locate `../package.json` and as `git rev-parse`'s cwd — works whether this runs from `src/` (tsx, the real `scripts/dev.sh`/resident-node case) or a future compiled `dist/`. */
const moduleDir = dirname(fileURLToPath(import.meta.url));

function hasNonEmptyStringVersion(value: unknown): value is { version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    value.version.length > 0
  );
}

/**
 * `package.json`'s own `version` — already the release's source of truth
 * for "what version is this node", read once rather than invented a second
 * time. Tried at two locations, in order: co-located with this module
 * itself first (issue #817's bundled layout —
 * `bundlePackage`/`copyNativeModule` in `scripts/lib/` writes a trimmed
 * `<version>/node.mjs` + `<version>/package.json` side by side, flat, no
 * `src/`), then one directory up (today's dev-checkout layout, where this
 * module runs as `packages/node/src/build-identity.ts` and the package's
 * `package.json` is its parent's sibling). Never both at once — a bundle
 * ships its own trimmed `package.json`, so checking there first is what
 * makes this correct at `~/.loombox/versions/<version>/`, which has no
 * `src/` and no directory above it that means anything to this node.
 */
function readOwnVersion(): string {
  const candidates = [join(moduleDir, 'package.json'), join(moduleDir, '..', 'package.json')];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (hasNonEmptyStringVersion(parsed)) return parsed.version;
      lastError = new Error(`${candidate} has no valid "version" field`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `build-identity: no package.json with a valid "version" field found at ${candidates.join(' or ')} (${String(lastError)})`,
  );
}

async function defaultGitRevParse(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: moduleDir });
  return stdout.trim();
}

export interface ReadBuildIdentityOptions {
  /** Overrides `process.env`; only `LOOMBOX_BUILD_COMMIT` is read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Runs `git rev-parse HEAD` against this checkout, or an injected fake for tests. Only consulted when `LOOMBOX_BUILD_COMMIT` is unset. */
  gitRevParse?: () => Promise<string>;
}

/**
 * This node's own build identity (issue #655): `package.json`'s own
 * version — nothing new, the release already versions this package —
 * plus the commit it was built from, when that's honestly recoverable.
 * `main.ts` resolves this once at startup and hands it to `createNode` ->
 * `RelayConnection`, which sends it on every `initialize` (see
 * `@loombox/protocol`'s `handshake.ts` for why nothing downstream ever
 * parses it for ordering, only equality via `buildIdentityMismatch`).
 *
 * `commit` resolution, cheapest-first, no new build step for either case:
 * 1. `LOOMBOX_BUILD_COMMIT`, when the launching environment sets it — the
 *    hook for a future deployment shape that stages a built artifact
 *    rather than running from a checkout (#658's Linux-local systemd-user
 *    backend, or SSH-remote's signed-supervisor-artifact path once #86
 *    lands a real artifact source), where `git rev-parse` would have
 *    nothing to answer from.
 * 2. `git rev-parse HEAD` against this module's own directory. This is
 *    the common case TODAY, and the actual incident #655 was filed over:
 *    a node started via `tsx src/main.ts` (`AGENTS.md`'s dev loop, and
 *    #653's own "a bare `pnpm exec tsx` process" description of Lorenzo's
 *    resident node) runs unbundled, straight out of a git checkout, so
 *    its commit is already sitting right there for free — no build step
 *    to add.
 * 3. `undefined` — neither is available (no git binary, or a checkout
 *    with no `.git`), so this node announces its version alone.
 *    `BuildIdentityV1.commit` is optional exactly for this case.
 */
export async function readNodeBuildIdentity(
  options: ReadBuildIdentityOptions = {},
): Promise<BuildIdentityV1> {
  const version = readOwnVersion();
  // Written as a literal `process.env.LOOMBOX_BUILD_COMMIT` reference (not
  // routed through an intermediate `env` variable) specifically so
  // esbuild's `define` can replace it with a baked-in string literal at
  // bundle time (issue #817's `bundlePackage({ bakeBuildCommit: true })`,
  // see `scripts/lib/bundle-package.mjs`) — `define` only rewrites
  // expressions that are textually `process.env.KEY`; reading the same
  // value off a variable alias (`const env = ...; env.LOOMBOX_BUILD_COMMIT`)
  // is invisible to it, so a bundle built that way would silently keep
  // doing a real (always-empty, no checkout present) environment lookup at
  // runtime instead of reporting the commit it was built from.
  const fromEnv = (
    options.env ? options.env.LOOMBOX_BUILD_COMMIT : process.env.LOOMBOX_BUILD_COMMIT
  )?.trim();
  if (fromEnv) return { version, commit: fromEnv };

  const gitRevParse = options.gitRevParse ?? defaultGitRevParse;
  try {
    const commit = await gitRevParse();
    return commit ? { version, commit } : { version };
  } catch {
    return { version };
  }
}
