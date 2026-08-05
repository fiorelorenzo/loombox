import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { BuildIdentityV1 } from '@loombox/protocol';

const execFileAsync = promisify(execFile);

/** This module's own directory, used both to locate `../package.json` and as `git rev-parse`'s cwd — works whether this runs from `src/` (tsx, dev/`scripts/dev.sh`) or a future compiled `dist/`. */
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

/** `packages/relay/package.json`'s own `version` — already the release's source of truth for "what version is this relay", read once rather than invented a second time. Relay carries no zod dependency of its own (it only ever consumes `@loombox/protocol`'s already-built schemas), so this is a narrow runtime guard rather than a new schema for one field. */
function readOwnVersion(): string {
  const raw = readFileSync(join(moduleDir, '..', 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!hasNonEmptyStringVersion(parsed)) {
    throw new Error('build-identity: packages/relay/package.json has no valid "version" field');
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
 * This relay's own build identity (issue #655): `package.json`'s own
 * version — nothing new, the release already versions this package —
 * plus the commit it was built from, when that's honestly recoverable.
 * `main.ts` resolves this once at boot and hands it to `startRelay`, which
 * echoes it back in every `initialize_result` (a connecting peer's baseline
 * for "what is actually being served") — see `handshake.ts`'s own doc
 * comment on why nothing here is ever parsed for ordering.
 *
 * `commit` resolution, cheapest-first, no new build step for either case:
 * 1. `LOOMBOX_BUILD_COMMIT`, when the deploy environment sets it —
 *    `deploy/relay/docker-compose.yml` passes through the exact same `$SHA`
 *    `scripts/deploy-prod.sh` already computes and writes to
 *    `DEPLOYED.json` (`git -C "$REPO_ROOT" rev-parse HEAD` at deploy time),
 *    never a second, independently-computed value. This is the production
 *    path: the relay's Docker image build context is `/opt/apps/loombox`
 *    (`scripts/deploy-prod.sh`'s own rsync excludes `.git` on purpose, so
 *    the deploy dir is deliberately not a git checkout — AGENTS.md's
 *    "Shipping to prod" section), so `git rev-parse` genuinely cannot
 *    answer inside that container; env is the honest way to get it there
 *    without adding an actual build step (no new compiled artifact, no new
 *    pipeline stage — just one more `environment:` line already-computed
 *    data flows through, exactly like `DATABASE_URL`/`RELAY_PUBLIC_URL`
 *    above it).
 * 2. `git rev-parse HEAD` against this module's own directory. This is
 *    `scripts/dev.sh`'s path: a relay started via `tsx src/main.ts` from a
 *    real git checkout (no Docker involved) has its commit sitting right
 *    there for free.
 * 3. `undefined` — neither is available (a git binary genuinely missing,
 *    or a checkout with no `.git`), so this relay announces its version
 *    alone. `BuildIdentityV1.commit` is optional exactly for this case.
 */
export async function readRelayBuildIdentity(
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
