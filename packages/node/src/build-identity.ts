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

/** `packages/node/package.json`'s own `version` — already the release's source of truth for "what version is this node", read once rather than invented a second time. */
function readOwnVersion(): string {
  const raw = readFileSync(join(moduleDir, '..', 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!hasNonEmptyStringVersion(parsed)) {
    throw new Error('build-identity: packages/node/package.json has no valid "version" field');
  }
  return parsed.version;
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
  const env = options.env ?? process.env;
  const fromEnv = env.LOOMBOX_BUILD_COMMIT?.trim();
  if (fromEnv) return { version, commit: fromEnv };

  const gitRevParse = options.gitRevParse ?? defaultGitRevParse;
  try {
    const commit = await gitRevParse();
    return commit ? { version, commit } : { version };
  } catch {
    return { version };
  }
}
