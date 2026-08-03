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
 * `Select`/context-line fact). `role` is no longer painted as a visible
 * word in the transcript (design spec `2026-08-03-cockpit-v6-design.md`
 * §3.4, issue #575: attribution moved to a glyph plus a quiet surface) —
 * it now backs the accessible name a screen reader gets instead, via
 * `MessageItem`'s visually-hidden label, so it stays a short, real word
 * rather than the raw id. `glyph` is that gutter mark's icon name, drawn
 * from `icon-paths.ts`'s `provider-*` set and always `aria-hidden` (the
 * `role` string is what carries the name to assistive tech, not the icon).
 *
 * Ids mirror `RESERVED_PROVIDER_IDS` (`@loombox/providers-core`), the v1
 * roadmap's full provider set: `generic` is the untranslated fallback
 * tier, deliberately never offered as a picker choice (see
 * `NewSessionDialog`'s own `providers` prop doc comment), and `gemini`
 * stays reserved — it has no spawn recipe yet. An id outside this map, or
 * none at all, is each caller's own problem to default; every current
 * caller falls back to "Agent"/`provider-generic` or the raw id rather
 * than indexing this table unguarded.
 */
import type { IconName } from './components/icons/icon-paths';

export const PROVIDER_LABELS: Record<string, { name: string; role: string; glyph: IconName }> = {
  claude: { name: 'Claude Code', role: 'Claude', glyph: 'provider-claude' },
  codex: { name: 'Codex', role: 'Codex', glyph: 'provider-codex' },
  gemini: { name: 'Gemini', role: 'Gemini', glyph: 'provider-gemini' },
  ohmypi: { name: 'Oh My Pi', role: 'Oh My Pi', glyph: 'provider-ohmypi' },
  generic: { name: 'Agent', role: 'Agent', glyph: 'provider-generic' },
};
