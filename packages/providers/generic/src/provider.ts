import type { AcpProviderModule, AcpSpawnConfig } from '@loombox/providers-core';

/**
 * The zero-code ACP fallback adapter (issue #183; SPEC.md §5.5: "Generic ACP
 * adapter... flat tool-call list, ToolKind-generic rows, plain permission
 * buttons, ResourceLink for file/image references"). Unlike Claude's fixed
 * spawn command (`@loombox/providers-claude`'s `CLAUDE_ACP_COMMAND`), there
 * is no single binary here — any spec-compliant ACP agent registers under
 * its own provider id with whatever command actually launches it, and gets
 * a working session through this module (plus this package's
 * `mapGenericPermissionOptions`/`classifyGenericToolKind`/image helpers)
 * with no bespoke `enrich()` at all.
 *
 * `enrich` is deliberately omitted (not even a no-op function) — per
 * `ProviderRegistry.enrich()`'s own doc comment, a module that supplies
 * none gets the registry's built-in pass-through automatically, so a
 * caller registering an arbitrary agent this way needs to write zero
 * per-provider glue code.
 */
export function createGenericProvider(id: string, spawnConfig: AcpSpawnConfig): AcpProviderModule {
  return {
    id,
    spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
      return { ...spawnConfig, cwd: opts.cwd };
    },
  };
}
