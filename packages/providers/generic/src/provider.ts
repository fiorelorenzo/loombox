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
    // The generic tier has no vendor CLI behind a bridge (unlike claude's/
    // codex's npx-wrapped bridges) — the caller-supplied spawnConfig.command
    // *is* the whole agent, so requiredCommand deliberately names that same
    // value, not a copy-paste slip. It also never gates a picker: `generic`
    // is deliberately never advertised to users (SPEC "generic is NOT
    // advertised" — it's the fallback tier for an unknown provider, not a
    // pickable agent), so this field exists only to satisfy
    // AcpProviderModule's contract, not to drive any availability check.
    requiredCommand: spawnConfig.command,
    spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
      return { ...spawnConfig, cwd: opts.cwd };
    },
  };
}
