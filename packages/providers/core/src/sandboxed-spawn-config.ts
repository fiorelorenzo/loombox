import type { AcpSpawnConfig } from './types';

/**
 * Private brand key — deliberately not exported. The only way to produce a
 * value with this property set is {@link markSandboxed} below, which is
 * what makes {@link SandboxedSpawnConfig} an actual proof, not a naming
 * convention a caller could satisfy by accident.
 */
declare const SANDBOXED: unique symbol;

/**
 * An {@link AcpSpawnConfig} that has genuinely been run through a real
 * sandboxing wrapper (SPEC §7.17; issue #257) — e.g. `@loombox/node`'s
 * `session-sandbox.ts` `resolveSessionSandbox()`, which rewrites
 * `command`/`args` into a `bwrap` invocation confining the process to the
 * session's worktree before this type is produced.
 *
 * This is what `@loombox/supervisor`'s `AgentSupervisorStartOptions.
 * wrapSpawnConfig` is typed to return instead of a plain `AcpSpawnConfig`:
 * a hook typed `(config) => AcpSpawnConfig` would let a caller pass the
 * identity function, `(config) => config`, and it would still typecheck —
 * a no-op that silently believes it sandboxed something, exactly what
 * issue #257 rules out. Typed to return `SandboxedSpawnConfig` instead,
 * that same identity function fails to typecheck: a plain `AcpSpawnConfig`
 * is not assignable to a type carrying the private `SANDBOXED` brand,
 * which nothing outside this module can construct. A caller could still
 * force it with an explicit `as SandboxedSpawnConfig` cast, but that is a
 * visibly unsafe assertion a reviewer/linter can flag, not something that
 * merely "falls out" of writing an ordinary wrapper function.
 */
export interface SandboxedSpawnConfig extends AcpSpawnConfig {
  readonly [SANDBOXED]: true;
}

/**
 * The only legal way to produce a {@link SandboxedSpawnConfig} — call this
 * with the already-wrapped `command`/`args` a real sandbox primitive
 * produced (never with `config` unchanged; nothing stops that at the type
 * level, since this function's whole job is asserting "I really did wrap
 * this", but every caller in this codebase only ever calls it with a
 * sandbox tool's own output — see `@loombox/node`'s `session-sandbox.ts`).
 */
export function markSandboxed(config: AcpSpawnConfig): SandboxedSpawnConfig {
  return config as SandboxedSpawnConfig;
}
