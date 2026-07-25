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
 * file/folder marks, attach/copy icons. Call-site swaps are out of scope
 * here (wave 2/3 issues) — this ships only the shared set.
 */

export const ICON_NAMES = [
  'sessions',
  'inbox',
  'targets',
  'command',
  'settings',
  'collapse-chevron',
  'health-ok',
  'health-warn',
  'health-danger',
  'tool-bash',
  'tool-edit',
  'tool-generic',
  'file',
  'folder',
  'attach',
  'copy',
  'close',
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
  // A speech bubble with a tail plus two text lines — "Sessions" (the
  // rail's conversation list).
  sessions: [
    'M22 14 H42 A8 8 0 0 1 50 22 V34 A8 8 0 0 1 42 42 H28 L20 50 L24 42 H22 A8 8 0 0 1 14 34 V22 A8 8 0 0 1 22 14 Z',
    'M20 24 H44',
    'M20 32 H36',
  ],

  // An open tray with an arrow feeding into its notch — "Inbox".
  inbox: ['M14 30 H24 L28 38 H36 L40 30 H50 V48 H14 Z', 'M32 12 V30', 'M24 22 L32 30 L40 22'],

  // Three connected nodes — "Targets/Nodes".
  targets: [
    'M14 46 A4 4 0 1 0 22 46 A4 4 0 1 0 14 46',
    'M42 46 A4 4 0 1 0 50 46 A4 4 0 1 0 42 46',
    'M28 16 A4 4 0 1 0 36 16 A4 4 0 1 0 28 16',
    'M20 44 L30 19',
    'M44 44 L34 19',
    'M22 46 H42',
  ],

  // The four-loop "command" glyph (mirrors the physical ⌘ key) —
  // "Command palette".
  command: [
    'M26 26 V19 A6.5 6.5 0 1 1 38 19 V26',
    'M38 26 H45 A6.5 6.5 0 1 1 45 38 H38',
    'M38 38 V45 A6.5 6.5 0 1 1 26 45 V38',
    'M26 38 H19 A6.5 6.5 0 1 1 19 26 H26',
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

  // A wrench (open jaw + shaft) — any other/generic tool call.
  'tool-generic': ['M40 14 A9 9 0 1 0 48 26', 'M44 22 L18 48', 'M14 44 L22 52'],

  // A page with a folded corner plus two content lines — a file reference.
  file: ['M18 12 H38 L46 20 V52 H18 Z', 'M38 12 V20 H46', 'M24 30 H40', 'M24 38 H36'],

  // A tabbed folder — a directory entry.
  folder: ['M12 22 H26 L30 28 H52 V50 H12 Z'],

  // A single continuous paperclip curve — the attachment affordance.
  attach: ['M40 18 L24 34 A8 8 0 0 0 36 46 L48 34 A4 4 0 0 0 42 28 L30 40'],

  // Two overlapping squares — the copy affordance.
  copy: ['M26 14 H46 V34 H26 Z', 'M14 26 H34 V46 H14 Z'],

  // An X — close/dismiss.
  close: ['M18 18 L46 46', 'M46 18 L18 46'],
};
