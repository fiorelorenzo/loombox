import type { AcpSpawnConfig, AcpTranscriptUpdate } from './types';

/**
 * Provider ids the roadmap already names (SPEC.md §5.5): `claude` and
 * `codex` ship v1 adapter modules, `gemini` is reserved for a future v2
 * module, and `generic` is the fallback tier any other ACP agent gets
 * automatically. Purely documentation/convention — `ProviderRegistry` itself
 * accepts any string id, so registering under `'gemini'` later needs no core
 * API change (issue #181's last acceptance bullet).
 */
export const RESERVED_PROVIDER_IDS = ['claude', 'codex', 'gemini', 'generic'] as const;

/**
 * The v1 per-provider adapter module contract (SPEC.md §5.5): the spawn
 * recipe for that provider's agent, plus an optional `enrich(update, raw)`
 * hook that promotes a vendor's `_meta` fields onto the core's fixed
 * transcript-update shape — starting with Claude Code's
 * `_meta.claudeCode.parentToolUseId` -> `parentToolCallId` (v2 work, not
 * built here; only the hook plumbing is). `enrich` is optional: a module
 * that adds neither it nor any UI wiring "simply falls back to the generic
 * tier everywhere" (§5.5) — the registry supplies the no-op pass-through
 * itself (see `ProviderRegistry.enrich`), so a stub module doesn't need to
 * implement an identity function just to satisfy the type.
 *
 * Deliberately a separate type from the v0 `AcpProvider` (types.ts), which
 * `packages/providers/claude` and `packages/supervisor` already depend on
 * with `enrich(update)` as a required, single-argument method — changing
 * that interface would break those packages. `AcpProviderModule` is the v1
 * surface this registry and a future v1 supervisor build against instead.
 */
export interface AcpProviderModule {
  readonly id: string;
  spawnConfig(opts: { cwd: string }): AcpSpawnConfig;
  enrich?(update: AcpTranscriptUpdate, raw: unknown): AcpTranscriptUpdate;
}

/**
 * The provider-module registry (SPEC.md §5.5; issue #181): register a
 * module by its ACP provider id, look it up when a session starts, and run
 * its `enrich` hook (or a no-op pass-through, when it doesn't have one) over
 * every incoming `session/update`.
 */
export class ProviderRegistry {
  private readonly modules = new Map<string, AcpProviderModule>();

  /** Registers (or replaces) a module under its own id. */
  register(module: AcpProviderModule): void {
    this.modules.set(module.id, module);
  }

  /** Looks up a registered module by provider id; `undefined` if none is registered under it yet. */
  lookup(id: string): AcpProviderModule | undefined {
    return this.modules.get(id);
  }

  /**
   * Runs the module registered under `id`'s `enrich` hook over one update,
   * if it supplied one; otherwise returns `update` unchanged (the no-op
   * pass-through every tier without a bespoke module gets automatically).
   * Also the pass-through for an id nothing is registered under at all.
   */
  enrich(id: string, update: AcpTranscriptUpdate, raw: unknown): AcpTranscriptUpdate {
    const module = this.modules.get(id);
    return module?.enrich ? module.enrich(update, raw) : update;
  }
}
