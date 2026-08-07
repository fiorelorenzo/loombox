import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Resolves — and, on Linux, feeds into `session-sandbox.ts`'s
 * `extraReadWriteMounts` — the one host directory that makes an
 * `npx`-launched provider (`claude`, `codex`) reuse its downloaded ACP
 * bridge package across sandboxed sessions instead of re-fetching it every
 * single time (issue #831; `session-sandbox.ts`'s own doc comment names
 * this exact gap: `bwrap`'s unbound root is a fresh writable `tmpfs`, so
 * without a real mount `npx` populates and then discards an empty cache on
 * every sandboxed invocation).
 *
 * **Sharing scope: per-node, which in this deployment is exactly
 * per-account, deliberately not per-session or per-project.** A `NodeCliConfig`
 * is scoped to exactly one `accountId` (`config.ts`'s own doc comment: a
 * node's sessions are "scoped under" one account, with no multi-account
 * config shape at all) — so "the directory this process resolves once and
 * reuses for the rest of its life" and "the directory this account's
 * sessions share" are the same set, not two different ones a broader
 * per-node cache would need to be defended against conflating. Per-session
 * would defeat the entire point (a fresh cache every session is exactly
 * today's bug). Per-project is strictly worse than per-node for no safety
 * gain: two projects belonging to the same account already share the same
 * npm registry, the same package names, and — via this same account's
 * other mounts and env injection — plenty of other channels a determined
 * project could already use to signal another; narrowing the cache to
 * "per-project" would just make every project pay the first-run cost
 * again without closing anything a project-level compromise couldn't
 * already do another way.
 *
 * **Why a shared writable cache is not the hole #257 exists to rule out.**
 * The content itself is not secret: it is exactly what an ordinary,
 * unsandboxed `npx` invocation on this same account's machine would have
 * cached anyway — public npm package tarballs, keyed by npm's own
 * content-addressable `_cacache` store (integrity-hash-keyed, so a session
 * cannot silently overwrite what a DIFFERENT package/version resolves to;
 * it can at most add or evict entries, which is what a normal cache
 * directory the account already trusted npm to manage would let any local
 * process do too). What this module refuses to do is widen WHERE that
 * mount can point: see {@link isDangerouslyBroadCacheDir} for the exact
 * guard against the class of bug #257 already hit once (a heuristic that
 * can compute something as broad as `/` or `$HOME` and mount it
 * read-write, rather than a narrow, single-purpose cache leaf).
 */
export interface ResolveNpmCacheDirOptions {
  /** Overridable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests; defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** Overridable for tests; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Replaces the real `npm config get cache` spawn. Overridable so a test can exercise every branch without depending on whether `npm` is actually installed on this host — this repo's own tests-must-not-depend-on-the-box convention. */
  probe?: (npmPath: string) => string | undefined;
}

const NPM_BIN = 'npm';

/**
 * The real functional check, run only when `NPM_CONFIG_CACHE` itself was
 * not already set (that env var is what `npm` itself honors first, so
 * asking `npm` again when it's already set would either agree — a wasted
 * spawn — or, on a broken install, disagree in a way this module should
 * not silently prefer over the value the operator/npm's own env contract
 * already settled). A 5s timeout, matching `linux-sandbox.ts`'s
 * `realBubblewrapSelfTest` convention, treats a hang as "could not
 * resolve" rather than blocking session creation indefinitely.
 */
function realNpmConfigGetCache(npmPath: string): string | undefined {
  const result = spawnSync(npmPath, ['config', 'get', 'cache'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The defensive guard #257's own history is the reason this exists:
 * `session-sandbox.ts`'s `toolchainRootFor` once had to be hardened
 * against a heuristic that could walk all the way up to `/` and mount the
 * entire host filesystem read-only. This module's mount is read-WRITE, so
 * the equivalent failure here is worse, not merely redundant — refuse to
 * return (and therefore never mount) a directory that IS, or CONTAINS,
 * the account's home directory, or that is the filesystem root itself. A
 * correctly configured npm install never resolves its cache to any of
 * these; a badly misconfigured `.npmrc`, or a `NPM_CONFIG_CACHE=/` typo,
 * now degrades to "no cache mount, first-run cost stays" instead of
 * "silently bind-mount the operator's entire home directory read-write
 * into every sandboxed session."
 */
function isDangerouslyBroadCacheDir(dir: string, home: string): boolean {
  const normalized = path.resolve(dir);
  if (normalized === path.sep) return true;
  if (normalized === home) return true;
  return home.startsWith(`${normalized}${path.sep}`);
}

function computeNpmCacheDir(options: ResolveNpmCacheDirOptions): string | undefined {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();

  // Exactly one of these three sources is ever consulted, in npm's own
  // precedence order — never a ranked list of fallbacks tried in turn: if
  // the source precedence actually settles on turns out to be dangerously
  // broad (see `isDangerouslyBroadCacheDir`), this refuses outright rather
  // than silently trying the NEXT source instead, which would mean an
  // operator's explicit (bad) `NPM_CONFIG_CACHE` gets silently ignored in
  // favor of a value they never asked for.
  let candidate: string | undefined;
  const explicit = env.NPM_CONFIG_CACHE?.trim();
  if (explicit) {
    candidate = explicit;
  } else {
    const pathEnv = options.pathEnv ?? env.PATH ?? '';
    const npmPath = pathEnv
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, NPM_BIN))
      .find((candidatePath) => existsSync(candidatePath));
    const fromNpm = npmPath ? (options.probe ?? realNpmConfigGetCache)(npmPath) : undefined;
    // POSIX default (verified against this exact deployment in issue
    // #831's own body: `npm config get cache` → `/home/dev/.npm`) — the
    // fallback for a host where `npm` isn't on `PATH` at all (a bare
    // `npx`/`bunx` shim without the full npm CLI) or the spawn above
    // failed to resolve anything.
    candidate = fromNpm ?? (home ? path.join(home, '.npm') : undefined);
  }

  if (!candidate) return undefined;
  return isDangerouslyBroadCacheDir(candidate, home) ? undefined : candidate;
}

/**
 * Creates the resolved directory on the host if it does not exist yet —
 * required because `buildBubblewrapArgv`'s `--bind` (unlike its `/usr`/
 * `/etc` mounts) never checks `existsSync` first: `bwrap` itself refuses
 * to bind-mount a source path that does not exist. A brand-new account
 * whose real, unsandboxed `npx` has never run yet has no `~/.npm`
 * directory at all — this mirrors exactly what npm's own first real
 * invocation would `mkdir -p` for itself. Failure (permissions, a
 * read-only `$HOME`) degrades to "no cache mount" rather than throwing:
 * this is a performance optimization, never a reason to refuse a session.
 */
function ensureDirExists(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Cached across calls with no override, same rationale and shape as
 * `linux-sandbox.ts`'s `detectSandboxCapability`: a real call may spawn
 * `npm` (a real process — issue #516's "no unbounded/repeated spawn"
 * lesson applies here too) and this host's npm cache location cannot
 * change within one daemon process's lifetime. Any override argument
 * bypasses the cache entirely, so a test never sees a stale result from
 * an earlier test in the same run.
 */
let cachedDir: string | undefined;
let cachedComputed = false;

export function resolveNpmCacheDir(options: ResolveNpmCacheDirOptions = {}): string | undefined {
  const usesDefaults =
    options.env === undefined &&
    options.pathEnv === undefined &&
    options.homeDir === undefined &&
    options.probe === undefined;
  if (usesDefaults && cachedComputed) return cachedDir;

  const dir = computeNpmCacheDir(options);
  const resolved = dir ? ensureDirExists(dir) : undefined;
  if (usesDefaults) {
    cachedDir = resolved;
    cachedComputed = true;
  }
  return resolved;
}

/** Test-only escape hatch: clears the process-lifetime cache {@link resolveNpmCacheDir} otherwise keeps for its no-override call shape. */
export function resetNpmCacheDirCacheForTests(): void {
  cachedDir = undefined;
  cachedComputed = false;
}
