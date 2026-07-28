/**
 * The shared provider display-label table (forms + real providers design
 * spec §2/§3). Two places in the web app used to keep their own copy of
 * "provider id -> what a human calls it" — `NewSessionDialog`'s hardcoded
 * `PROVIDER_OPTIONS` (a product name, for a picker) and `MessageItem`'s
 * local `PROVIDER_ROLE_LABELS` (a short gutter word) — and they had already
 * drifted: the dialog called `claude` "Claude Code" while the transcript
 * gutter called the same session's turns just "Claude". One map, read by
 * both, so adding a provider is a single edit instead of two, and the two
 * surfaces can never disagree about the same id again.
 *
 * `name` is the full product name, for a picker (`NewSessionDialog`'s Agent
 * `Select`/context-line fact); `role` is the short word a transcript
 * gutter has room for (`MessageItem`).
 *
 * Ids mirror `RESERVED_PROVIDER_IDS` (`@loombox/providers-core`), the v1
 * roadmap's full provider set: `generic` is the untranslated fallback
 * tier, deliberately never offered as a picker choice (see
 * `NewSessionDialog`'s own `providers` prop doc comment), and `gemini`
 * stays reserved — it has no spawn recipe yet. An id outside this map, or
 * none at all, is each caller's own problem to default; every current
 * caller falls back to "Agent" or the raw id rather than indexing this
 * table unguarded.
 */
export const PROVIDER_LABELS: Record<string, { name: string; role: string }> = {
  claude: { name: 'Claude Code', role: 'Claude' },
  codex: { name: 'Codex', role: 'Codex' },
  gemini: { name: 'Gemini', role: 'Gemini' },
  ohmypi: { name: 'Oh My Pi', role: 'Oh My Pi' },
  generic: { name: 'Agent', role: 'Agent' },
};
