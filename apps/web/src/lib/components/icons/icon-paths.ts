/**
 * The bespoke hand-drawn icon set (redesign v2 §2 "Icon system", issue #457):
 * every path here is authored inside the exact same `viewBox="0 0 64 64"`
 * convention as `BrandMark.svelte`'s "Warp & Weft" mark, meant to be drawn
 * with that component's stroke (`stroke="currentColor"`, `stroke-width:
 * 3.4`, `stroke-linecap: round`) and no fill. `Icon.svelte` owns those
 * presentation attributes at the `<svg>` root so every path below is a bare
 * `d` string with no per-path stroke override — that is what keeps the
 * whole set visually consistent with the mark, and what `Icon.test.ts`
 * asserts instead of relying on eyeballing it.
 *
 * This is a plain data module (no Svelte, no DOM) so it's trivially
 * testable and importable from anywhere that needs the raw path data
 * (e.g. `scripts/gen-brand-assets.mjs`-style tooling later), independent of
 * the `Icon.svelte` component that renders it.
 *
 * Replaces the letter/unicode placeholders named in #457: the rail's S/I/N
 * spans, the `⌘K` glyph, the session-group `▾` chevron, tool-call glyphs,
 * file/folder marks, attach/copy icons.
 *
 * Redesign v3 (§3.7, issue #502) redraws the three glyphs the audit found
 * didn't carry their concept at rail/tab-bar size — `sessions` read as a
 * speech bubble, `inbox` as a download arrow, `command` as a plain "add"
 * cross — and adds the names the rest of the redesign consumes (chevron,
 * search, overflow, plus, refresh, check, alert, terminal, pin). Additive
 * and redraws only: every name that shipped in #457 still resolves.
 *
 * v6 turn-attribution pass (design spec `2026-08-03-cockpit-v6-design.md`
 * §3.4, issue #575) adds five `provider-*` marks: the small glyph a
 * transcript row now carries in place of the caption-case "CLAUDE"/"CODEX"/…
 * word `MessageItem`'s gutter used to paint. Each is a plain abstract mark,
 * not a reproduction of any provider's real logo — starburst for Claude,
 * a hexagon with a cursor tick for Codex, two overlapping rings for Gemini,
 * a literal π for loombox's own "Oh My Pi" harness, and a bare open ring
 * for `provider-generic`, the same "deliberately plain" register as
 * `FALLBACK_ICON_PATHS` for an unrecognized or omitted provider id.
 */

export const ICON_NAMES = [
  'sessions',
  'inbox',
  'targets',
  'tracker',
  'command',
  'settings',
  'collapse-chevron',
  'chevron-down',
  'search',
  'more',
  'plus',
  'refresh',
  'check',
  'alert',
  'health-ok',
  'health-warn',
  'health-danger',
  'tool-bash',
  'tool-edit',
  'tool-generic',
  'tool-read',
  'tool-delete',
  'tool-move',
  'tool-search',
  'tool-think',
  'tool-fetch',
  'terminal',
  'file',
  'folder',
  'attach',
  'copy',
  'fork',
  'pin',
  'checkpoint',
  'close',
  'sidebar-panel',
  'provider-claude',
  'provider-codex',
  'provider-gemini',
  'provider-ohmypi',
  'provider-generic',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/**
 * A distinct, deliberately plain glyph (an open diamond) rendered by
 * `Icon.svelte` when `name` doesn't match anything in `ICON_PATHS` — so an
 * unrecognized name degrades to a visible-but-inert placeholder instead of
 * throwing (#457's "unknown-name fallback that doesn't throw").
 */
export const FALLBACK_ICON_PATHS: readonly string[] = ['M32 14 L50 32 L32 50 L14 32 Z'];

/**
 * Each entry is the ordered list of `<path d="…">` values for that icon,
 * all sharing the one `viewBox="0 0 64 64"` / stroke-width-3.4 / round-cap
 * convention applied once at the `<svg>` root by `Icon.svelte`.
 */
export const ICON_PATHS: Record<IconName, readonly string[]> = {
  // Three rows of a leading marker plus a text line — a stacked list of
  // conversation threads, the exact anatomy of a session row (3.2)
  // repeated three times — "Sessions".
  sessions: [
    'M14 18 A4 4 0 1 0 22 18 A4 4 0 1 0 14 18',
    'M28 18 H48',
    'M14 32 A4 4 0 1 0 22 32 A4 4 0 1 0 14 32',
    'M28 32 H44',
    'M14 46 A4 4 0 1 0 22 46 A4 4 0 1 0 14 46',
    'M28 46 H40',
  ],

  // An open tray with a notched rim — "Inbox". No feed arrow: a tray
  // reads as a tray on its own, the arrow was what made it read as
  // "download" instead.
  inbox: ['M12 26 H24 L28 34 H36 L40 26 H52 V50 H12 Z'],

  // Three connected nodes — "Targets/Nodes".
  targets: [
    'M14 46 A4 4 0 1 0 22 46 A4 4 0 1 0 14 46',
    'M42 46 A4 4 0 1 0 50 46 A4 4 0 1 0 42 46',
    'M28 16 A4 4 0 1 0 36 16 A4 4 0 1 0 28 16',
    'M20 44 L30 19',
    'M44 44 L34 19',
    'M22 46 H42',
  ],

  // The four-loop "command"/⌘ glyph, traced as one continuous outline
  // (outer loop edges and the inner crossbar in a single closed path) so
  // it reads as four loops joined by a bridge rather than — at rail size —
  // a thick plus sign wearing rounded corners.
  command: [
    'M48 8 A8 8 0 0 0 40 16 V48 A8 8 0 0 0 48 56 A8 8 0 0 0 56 48 A8 8 0 0 0 48 40 H16 A8 8 0 0 0 8 48 A8 8 0 0 0 16 56 A8 8 0 0 0 24 48 V16 A8 8 0 0 0 16 8 A8 8 0 0 0 8 16 A8 8 0 0 0 16 24 H48 A8 8 0 0 0 56 16 A8 8 0 0 0 48 8 Z',
  ],

  // A gear (outer ring + hub + eight teeth) — "Settings".
  settings: [
    'M16 32 A16 16 0 1 0 48 32 A16 16 0 1 0 16 32',
    'M26 32 A6 6 0 1 0 38 32 A6 6 0 1 0 26 32',
    'M48 32 L54 32',
    'M43 43 L48 48',
    'M32 48 L32 54',
    'M21 43 L16 48',
    'M16 32 L10 32',
    'M21 21 L16 16',
    'M32 16 L32 10',
    'M43 21 L48 16',
  ],

  // A single open chevron — the disclosure/collapse toggle (rotated by the
  // caller's CSS for expanded/collapsed states, same convention as the
  // `▾`/`▸` glyph it replaces).
  'collapse-chevron': ['M18 26 L32 40 L46 26'],

  // A single open chevron pointing down — a fixed-orientation disclosure
  // indicator (unlike `collapse-chevron`, this one is never rotated).
  'chevron-down': ['M16 24 L32 40 L48 24'],

  // A magnifying glass — search/filter.
  search: ['M16 28 A12 12 0 1 0 40 28 A12 12 0 1 0 16 28', 'M37 37 L50 50'],

  // Three round dots in a row (drawn as zero-length round-capped strokes,
  // same trick as `health-warn`'s exclamation dot) — the horizontal
  // overflow/"more" affordance.
  more: ['M18 32 L18 32.1', 'M32 32 L32 32.1', 'M46 32 L46 32.1'],

  // A plain cross — add/new.
  plus: ['M32 14 V50', 'M14 32 H50'],

  // An almost-complete ring left open on one side, with an arrowhead at
  // the open end — refresh/retry.
  refresh: ['M42 20 A18 18 0 1 0 42 44', 'M34 15 L42 20 L46 11'],

  // A single checkmark — confirmation/success.
  check: ['M15 33 L27 45 L49 19'],

  // A triangle with an exclamation mark — generic warning/error affordance
  // (distinct from `health-warn`, which is specifically a target/node
  // state; this is the one connection-chip/notice icon uses).
  alert: ['M32 11 L54 49 H10 Z', 'M32 24 V37', 'M32 43 L32 43.1'],

  // A ring with a checkmark — healthy target/node.
  'health-ok': ['M16 32 A16 16 0 1 0 48 32 A16 16 0 1 0 16 32', 'M23 33 L29 40 L43 24'],

  // A triangle with an exclamation mark — degraded target/node.
  'health-warn': ['M32 12 L52 48 H12 Z', 'M32 24 V38', 'M32 44 L32 44.1'],

  // A ring with an X — unreachable/failed target/node.
  'health-danger': [
    'M16 32 A16 16 0 1 0 48 32 A16 16 0 1 0 16 32',
    'M25 25 L39 39',
    'M39 25 L25 39',
  ],

  // A terminal frame with a prompt caret and cursor — the bash tool call.
  'tool-bash': ['M14 16 H50 V48 H14 Z', 'M22 28 L30 34 L22 40', 'M32 42 H42'],

  // A pencil silhouette with a ferrule band — the edit tool call.
  'tool-edit': ['M40 14 L50 24 L26 48 L14 50 L16 38 Z', 'M32 22 L42 32'],

  // A wrench (open jaw + shaft) — any other/generic tool call, and the
  // fallback for a `toolKind` this set doesn't (yet) have its own glyph
  // for (issue #744: an unrecognized future ACP tool kind degrades to
  // this rather than a broken icon reference — see `$lib/tool-widgets.ts`'s
  // `toolKindIcon`).
  'tool-generic': ['M40 14 A9 9 0 1 0 48 26', 'M44 22 L18 48', 'M14 44 L22 52'],

  // An open book (two facing pages, spine implied by the pinch at centre)
  // — the `read` tool call (issue #744, decisions doc C3-3: search, read,
  // fetch, delete and move used to all draw this same wrench).
  'tool-read': ['M14 16 V48', 'M50 16 V48', 'M14 16 Q32 22 50 16', 'M14 48 Q32 42 50 48'],

  // A trash can (lid, body, two shred lines) — the `delete` tool call.
  'tool-delete': [
    'M14 20 H50',
    'M22 20 V14 H42 V20',
    'M18 20 L20 52 H44 L46 20',
    'M28 28 V44',
    'M36 28 V44',
  ],

  // Four short arrowheads radiating off a plus — the classic "move"
  // four-direction cursor glyph — the `move` tool call.
  'tool-move': [
    'M32 10 V54',
    'M10 32 L54 32',
    'M32 10 L26 18',
    'M32 10 L38 18',
    'M32 54 L26 46',
    'M32 54 L38 46',
    'M10 32 L18 26',
    'M10 32 L18 38',
    'M54 32 L46 26',
    'M54 32 L46 38',
  ],

  // Same magnifying-glass anatomy as `search` under its own name for the
  // `search` tool call, same "own name, shared anatomy" convention as
  // `terminal` reusing `tool-bash`'s frame below.
  'tool-search': ['M16 28 A12 12 0 1 0 40 28 A12 12 0 1 0 16 28', 'M37 37 L50 50'],

  // A lightbulb (bulb, base, filament cap) — the `think` tool call (an
  // agent's own reasoning/thinking step surfaced as a tool call by some
  // providers, distinct from the streamed `agent_thought_chunk` transcript
  // item `icon-paths.ts` has no glyph for at all).
  'tool-think': [
    'M22 26 A10 10 0 1 1 42 26 A10 10 0 0 1 36 34 V40 H28 V34 A10 10 0 0 1 22 26',
    'M28 46 H36',
    'M30 52 H34',
  ],

  // A downward arrow landing on a baseline — inbound/"fetched" data — the
  // `fetch` tool call.
  'tool-fetch': ['M32 12 V40', 'M22 30 L32 40 L42 30', 'M14 48 H50'],

  // Same terminal-frame anatomy as `tool-bash` (frame, prompt caret,
  // cursor) under its own name for surfaces that mean "open a terminal"
  // rather than "this was a bash tool call".
  terminal: ['M12 15 H52 V49 H12 Z', 'M20 27 L28 33 L20 39', 'M31 41 H41'],

  // A page with a folded corner plus two content lines — a file reference.
  file: ['M18 12 H38 L46 20 V52 H18 Z', 'M38 12 V20 H46', 'M24 30 H40', 'M24 38 H36'],

  // A tabbed folder — a directory entry.
  folder: ['M12 22 H26 L30 28 H52 V50 H12 Z'],

  // A single continuous paperclip curve — the attachment affordance.
  attach: ['M40 18 L24 34 A8 8 0 0 0 36 46 L48 34 A4 4 0 0 0 42 28 L30 40'],

  // Two overlapping squares — the copy affordance.
  copy: ['M26 14 H46 V34 H26 Z', 'M14 26 H34 V46 H14 Z'],

  // A single node splitting into two — the fork-a-session affordance
  // (issue #746): "one thing becomes two, diverging from here", the same
  // three-connected-nodes register `targets` already draws, just read
  // top-to-bottom instead of left-to-right.
  fork: [
    'M28 14 A4 4 0 1 0 36 14 A4 4 0 1 0 28 14',
    'M14 48 A4 4 0 1 0 22 48 A4 4 0 1 0 14 48',
    'M42 48 A4 4 0 1 0 50 48 A4 4 0 1 0 42 48',
    'M32 18 V30',
    'M32 30 L18 44',
    'M32 30 L46 44',
  ],

  // A pushpin — pin/unpin affordance.
  pin: ['M26 12 H38 L36 24 L46 36 H18 L28 24 Z', 'M32 36 V52'],

  // A flag on a pole — a checkpoint/waypoint marker (SPEC §7.20; issue
  // #268): "a point you can come back to", read literally rather than
  // reusing `pin` (already the session pin/unpin affordance, a distinct
  // concept) or `refresh` (already retry/reload).
  checkpoint: ['M20 10 V54', 'M20 12 L46 20 L20 28 Z'],

  // An X — close/dismiss.
  close: ['M18 18 L46 46', 'M46 18 L18 46'],

  // A panel with one column marked — the Sessions sidebar's own show/hide
  // control, and deliberately NOT a chevron. Two reasons it is drawn as the
  // object rather than a direction. First, `collapse-chevron` is the
  // disclosure mark eight rows already use (tool calls, message expand,
  // project groups), so spending it on a whole panel made one glyph mean two
  // unrelated things. Second, a chevron only says "that way", while every
  // comparable tool (VS Code, Zed, Linear) names the surface being toggled.
  //
  // It is also asymmetric on purpose: the caller mirrors it with
  // `scaleX(-1)` to show which side the panel is on, and the chevron this
  // replaced was symmetric about x=32 — so that mirror rendered an identical
  // glyph and the control silently had no state at all.
  'sidebar-panel': [
    'M18 12 H46 A6 6 0 0 1 52 18 V46 A6 6 0 0 1 46 52 H18 A6 6 0 0 1 12 46 V18 A6 6 0 0 1 18 12 Z',
    'M27 12 V52',
  ],

  // A six-ray starburst through the centre — Claude's gutter glyph
  // (issue #575). Deliberately abstract, not a copy of the real mark.
  'provider-claude': ['M32 10 V54', 'M11 21 L53 43', 'M53 21 L11 43'],

  // A hexagon (one bounded unit, the code-block shape) with a short
  // vertical tick at its centre (a cursor) — Codex's gutter glyph.
  'provider-codex': ['M32 8 L54 20 V44 L32 56 L10 44 V20 Z', 'M32 26 V38'],

  // Two overlapping rings — "twins" — Gemini's gutter glyph.
  'provider-gemini': [
    'M12 32 A12 12 0 1 0 36 32 A12 12 0 1 0 12 32',
    'M28 32 A12 12 0 1 0 52 32 A12 12 0 1 0 28 32',
  ],

  // A literal π — loombox's own "Oh My Pi" harness provider's gutter glyph.
  'provider-ohmypi': ['M14 20 H50', 'M22 20 V48', 'M42 20 V48'],

  // A bare open ring, no inner mark — the deliberately plain glyph for an
  // unrecognized or omitted provider id, same register as
  // `FALLBACK_ICON_PATHS` but its own name so a missing/legacy provider id
  // still reads as "an agent", not as a broken icon reference.
  'provider-generic': ['M18 32 A14 14 0 1 0 46 32 A14 14 0 1 0 18 32'],

  // A three-column frame — the kanban board's own shape at rail size
  // (issue #212). Deliberately the literal board, not a checklist/ticket
  // glyph: `file`/`folder` already own the document register, and this is
  // the one icon in the set that means "a board of columns", not "a
  // single item".
  tracker: ['M12 12 H52 V52 H12 Z', 'M28 12 V52', 'M40 12 V52'],
};
