import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root } from 'hast';
import type { LanguageFn } from 'highlight.js';

/** The `rehype-highlight` package's default export's type, taken via `typeof import(...)` rather than a value import — matches exactly what a static `import rehypeHighlight from 'rehype-highlight'` would bind, which is what `unified().use()`'s overload resolution needs to infer the plugin's options type; `loadRehypeHighlight` below resolves the actual runtime value through a dynamic `import()` instead. */
type RehypeHighlightFn = typeof import('rehype-highlight').default;

/**
 * Transcript Markdown (issue #574, design spec `2026-08-03-cockpit-v6-design.md`
 * §3.4; lazy highlighting issue #600): a full CommonMark + GFM (tables,
 * strikethrough, task lists) render path for agent/user turns, sanitised
 * because agent output is untrusted text that will contain HTML sooner or
 * later, and syntax-highlighted with an explicit, restricted `highlight.js`
 * language subset — never shipped eagerly, though: `highlight.js` plus its
 * grammars added ~100kB gzip to the cockpit's own chunk (#574's
 * measurement, this is a mobile-first client — see the PR for the current
 * one), so #600 moved the entire highlighter behind a dynamic `import()`
 * that only fires once a message actually contains a fenced code block in
 * a registered language. `renderMarkdownToHtml` (the synchronous entry
 * point every render starts with) never highlights; `highlightMarkdownToHtml`
 * (async) is the upgrade path — see both functions' doc comments below, and
 * `MessageItem.svelte`'s `rendered` derivation for how the two compose
 * without racing.
 *
 * Pipeline, in order, and why the order is load-bearing:
 *
 * 1. `remarkParse` + `remarkGfm` — CommonMark + GFM source into an mdast tree.
 * 2. `remarkRehype` — mdast into hast, WITHOUT `allowDangerousHtml`. That is
 *    the actual sanitisation boundary for literal raw HTML the agent typed
 *    (a `<script>`, an `<img onerror=…>`): `mdast-util-to-hast`'s `html`
 *    handler returns `undefined` for an `html` mdast node whenever
 *    `allowDangerousHtml` isn't set, so those nodes are dropped before a
 *    single hast element for them ever exists — not escaped-and-shown, not
 *    parsed-then-stripped, just never created. Turning `allowDangerousHtml`
 *    on and pairing it with `rehype-raw` (the documented way to actually
 *    render an agent's raw HTML) was deliberately not done: it would mean
 *    parsing arbitrary untrusted markup with a second, heavier HTML parser
 *    purely to still end up stripping most of it in the next step, for a
 *    case (a coding agent typing literal inline HTML in prose rather than
 *    fencing it) that is rare in practice.
 * 3. `rehypeSanitize` (default schema, unmodified — GitHub's own sanitation
 *    list via `hast-util-sanitize`) — the second boundary, for hast nodes
 *    mdast produced honestly from real Markdown syntax rather than raw HTML:
 *    a `[text](javascript:alert(1))` link or `![x](javascript:alert(1))`
 *    image becomes a real hast `a`/`img` element, and it's this step that
 *    strips the dangerous `href`/`src` protocol (the default schema only
 *    allows `http`/`https`/`mailto`/… — see its own "syntax highlighting"
 *    and "math" examples for why *later* trusted plugins, not a widened
 *    schema, are the documented way to add markup this step doesn't itself
 *    know about).
 * 4. `externalLinks` (this file) — runs *after* sanitisation on purpose: it
 *    is our own trusted code, so nothing after it needs to re-allow the
 *    `target`/`rel` it adds, exactly the pattern the `rehype-sanitize`
 *    "syntax highlighting" example uses for `rehype-highlight`'s injected
 *    classes.
 * 5. `wrapTables` (this file) — same reasoning: wraps every `table` in a
 *    `div.md-table-scroll` so a wide table scrolls horizontally inside the
 *    transcript measure (`MessageItem.svelte`'s CSS) instead of stretching
 *    the row, per the issue's acceptance.
 * 6. `rehypeStringify` — hast back to an HTML string. This is the LAST step
 *    of `renderMarkdownToHtml`'s synchronous pipeline (`baseProcessor`
 *    below): a fenced code block already carries its `language-xxx` class
 *    at this point (`remarkRehype`'s own fenced-code handling sets it, and
 *    `rehypeSanitize`'s default schema explicitly allows `className` on
 *    `code` — see its own "syntax highlighting" example for why), it just
 *    has no `hljs-*` token spans yet: plain, correctly escaped, readable
 *    monospace — exactly the state an *open* (still-streaming) fence
 *    already renders as, so there is no new visual state here, only a
 *    longer window before it upgrades.
 * 7. `rehypeHighlight`, in `highlightMarkdownToHtml` only — still runs in
 *    this exact pipeline position, immediately after the trusted plugins
 *    and before `rehypeStringify`, for the same trusted-after-sanitize
 *    reasoning as #574: it injects `hljs-*` token `<span>`s the sanitizer's
 *    default schema doesn't know about, and since sanitisation already ran
 *    earlier in this *same* pipeline invocation (the whole thing is re-run
 *    start to finish async, never resumed from a stashed tree), nothing
 *    strips them back out. Only the languages `source` actually references
 *    — resolved through `HIGHLIGHT_LANGUAGE_LOADERS` below and dynamically
 *    imported — are ever registered (never `lowlight`'s `common`/`all`
 *    bundles), so an unresolved fence language quietly stays plain,
 *    unhighlighted (but still monospaced) code, same as #574's behaviour.
 *
 * `renderMarkdownToHtml` uses `.processSync` (every stage of the base
 * pipeline is synchronous) because it is called from a Svelte `$derived` in
 * `MessageItem.svelte`, which must resolve synchronously.
 * `highlightMarkdownToHtml` is genuinely async — the `await` is the dynamic
 * import of the highlighter and the grammar modules it needs, not the
 * parse — and is `.processSync`-based too once those land, since
 * remark/rehype's own work is synchronous either way.
 */

const HIGHLIGHT_ALIASES = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py'],
  bash: ['sh', 'shell', 'zsh'],
  yaml: ['yml'],
  xml: ['html', 'svelte', 'vue'],
  markdown: ['md'],
  cpp: ['c++', 'cc'],
  csharp: ['cs'],
  ruby: ['rb'],
  dockerfile: ['docker'],
};

/**
 * The same 18-language set #574 curated, unchanged (issue #600's option 2:
 * cutting rarely-used grammars like `java`/`csharp`/`cpp`/`ruby`/
 * `dockerfile` was only ever a bundle-size trade-off, and that trade-off is
 * gone now that every single one of these is its own chunk, fetched only if
 * a fence actually names it — a grammar nobody's transcript ever references
 * costs nothing, eagerly registered or not. Expanding past #574's curated
 * set is a separate, unscoped product call (which languages loombox
 * transcripts should recognise) this chore issue didn't ask for, so it's
 * left alone rather than grown opportunistically.
 */
const HIGHLIGHT_LANGUAGE_LOADERS = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
} satisfies Record<string, () => Promise<{ default: unknown }>>;

type CanonicalHighlightLanguage = keyof typeof HIGHLIGHT_LANGUAGE_LOADERS;

const ALIAS_TO_CANONICAL: Record<string, CanonicalHighlightLanguage> = Object.fromEntries(
  Object.entries(HIGHLIGHT_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias, canonical as CanonicalHighlightLanguage]),
  ),
);

/** A fence's raw info-string language (`ts`, `Py`, `SH`, …) resolved to the canonical key `HIGHLIGHT_LANGUAGE_LOADERS` registers it under, or `undefined` for a language this pipeline never highlights — the same resolution `rehype-highlight`/`lowlight`'s own `aliases` option does internally, done here first so we know what to `import()`. */
function resolveHighlightLanguage(rawLang: string): CanonicalHighlightLanguage | undefined {
  const lang = rawLang.toLowerCase();
  if (lang in HIGHLIGHT_LANGUAGE_LOADERS) return lang as CanonicalHighlightLanguage;
  return ALIAS_TO_CANONICAL[lang];
}

/** Adds `target="_blank" rel="noopener noreferrer"` to every rendered link (issue #574 acceptance: "links visibly links and opening externally"). Runs after `rehypeSanitize` — see the module doc comment for why that ordering means the default schema needs no changes to keep these attributes. */
function externalLinks() {
  return (tree: Root) => {
    visitElements(tree, (node) => {
      if (node.tagName === 'a' && node.properties?.href) {
        node.properties.target = '_blank';
        node.properties.rel = ['noopener', 'noreferrer'];
      }
    });
  };
}

/** Wraps every rendered `<table>` in `div.md-table-scroll` so `MessageItem.svelte`'s CSS can give it its own horizontal scroller instead of letting a wide table stretch the transcript row (issue #574 acceptance). */
function wrapTables() {
  return (tree: Root) => {
    wrapTableChildren(tree);
  };
}

function wrapTableChildren<Node extends Root | Element>(node: Node): void {
  for (const child of node.children) {
    if (child.type === 'element') wrapTableChildren(child);
  }
  // `flatMap`'s result is provably a valid `Node['children']` (every
  // original child is kept as-is, or replaced by a `div` wrapper that is
  // itself valid content wherever the child it wraps was) — TS just can't
  // carry that through a generic array transform, hence the one cast.
  node.children = node.children.flatMap((child) => {
    if (child.type === 'element' && child.tagName === 'table') {
      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['md-table-scroll'] },
        children: [child],
      };
      return [wrapper];
    }
    return [child];
  }) as Node['children'];
}

function visitElements(node: Root | Element, fn: (node: Element) => void): void {
  if (node.type === 'element') fn(node);
  if (!('children' in node)) return;
  for (const child of node.children) {
    if (child.type === 'element') visitElements(child, fn);
  }
}

const baseProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, defaultSchema)
  .use(externalLinks)
  .use(wrapTables)
  .use(rehypeStringify);

/** Renders a Markdown source string to a sanitised, plain (never syntax-highlighted — see `highlightMarkdownToHtml` for that) HTML string, safe to insert via Svelte's `{@html}` — see the module doc comment for the full pipeline and its security reasoning. Callers only ever pass this a "stable" source (see `splitStreamingMarkdown`): a still-streaming, not-yet-closed construct is never parsed as Markdown at all, it renders as plain text/monospace until it closes. */
export function renderMarkdownToHtml(source: string): string {
  if (!source) return '';
  return String(baseProcessor.processSync(source));
}

export interface StreamingMarkdownSplit {
  /** Markdown source containing only fully closed blocks — safe to run through `renderMarkdownToHtml` in one pass. */
  stable: string;
  /** Plain prose after the last safe boundary and before any still-open fence (or the entire remainder, if there is no open fence) — rendered as literal text, never Markdown-parsed, until it becomes part of `stable` on a later call. */
  tailText: string;
  /** Set when the text ends inside a fenced code block that hasn't closed yet, so the caller can render its body as plain monospace — never syntax-highlighted — until the closing fence arrives (issue #574 acceptance). */
  openFence: { lang: string | undefined; code: string } | null;
}

interface FenceMarker {
  char: '`' | '~';
  len: number;
  lang: string | undefined;
}

// Backtick fences forbid a backtick in the info string (CommonMark's own
// disambiguation from inline code spans); tilde fences don't have that
// restriction. Fence indentation (up to 3 spaces, dedented from the
// content) is intentionally not modelled — every fence loombox's own
// providers stream is column-0, and under-modelling indentation only ever
// makes this function *more* conservative (content stays in the streaming
// tail a little longer), never incorrect.
function matchFenceOpen(line: string): FenceMarker | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1];
  const char = marker[0] as '`' | '~';
  const info = match[2].trim();
  if (char === '`' && info.includes('`')) return null;
  const lang = info.split(/\s+/)[0] || undefined;
  return { char, len: marker.length, lang };
}

function matchFenceClose(line: string, open: FenceMarker): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  if (!match) return false;
  const marker = match[1];
  return marker[0] === open.char && marker.length >= open.len;
}

/**
 * Scans `source` for fenced code block info strings without a real parse —
 * the same fence-matching `matchFenceOpen`/`matchFenceClose` already do for
 * `splitStreamingMarkdown`, just collecting languages instead of a safe
 * boundary. `source` is always a "stable" prefix by the time this runs
 * (`highlightMarkdownToHtml`'s only caller), so every fence it finds either
 * has a matching close inside `source` or is the finalized-turn's trailing
 * unclosed one — either way its info string, and therefore its language,
 * was already fully typed on the opening line, which is the only line this
 * needs to look at.
 */
function collectFenceLanguages(source: string): Set<string> {
  const languages = new Set<string>();
  let cursor = 0;
  let fence: FenceMarker | null = null;
  while (cursor <= source.length) {
    const newlineIndex = source.indexOf('\n', cursor);
    const line = newlineIndex === -1 ? source.slice(cursor) : source.slice(cursor, newlineIndex);
    if (fence) {
      if (matchFenceClose(line, fence)) fence = null;
    } else {
      const opened = matchFenceOpen(line);
      if (opened) {
        fence = opened;
        if (opened.lang) languages.add(opened.lang);
      }
    }
    if (newlineIndex === -1) break;
    cursor = newlineIndex + 1;
  }
  return languages;
}

// Each resolved language's module and the `rehype-highlight` package itself
// are fetched at most once per page load: `import()` already memoizes by
// specifier, but wrapping that in our own `Map`/single `Promise` means a
// concurrent request for the same language while the first is still
// in-flight reuses that one in-flight promise rather than racing a second
// `import()` for it.
const languageModuleCache = new Map<CanonicalHighlightLanguage, Promise<LanguageFn>>();
let rehypeHighlightModulePromise: Promise<RehypeHighlightFn> | null = null;

function loadLanguageModule(canonical: CanonicalHighlightLanguage): Promise<LanguageFn> {
  let cached = languageModuleCache.get(canonical);
  if (!cached) {
    cached = HIGHLIGHT_LANGUAGE_LOADERS[canonical]().then((mod) => mod.default);
    languageModuleCache.set(canonical, cached);
  }
  return cached;
}

function loadRehypeHighlight(): Promise<RehypeHighlightFn> {
  if (!rehypeHighlightModulePromise) {
    rehypeHighlightModulePromise = import('rehype-highlight').then((mod) => mod.default);
  }
  return rehypeHighlightModulePromise;
}

/**
 * The async upgrade path (issue #600): re-runs the *identical* pipeline
 * `renderMarkdownToHtml` uses — same parse, same `remarkRehype`
 * (`allowDangerousHtml` still unset), same `rehypeSanitize` on the
 * unmodified default schema, same trusted `externalLinks`/`wrapTables` —
 * and adds `rehypeHighlight` in the exact pipeline position #574 had it:
 * immediately after the trusted plugins, before `rehypeStringify`. The
 * only thing that changed from the old synchronous pipeline is *when* that
 * last step's two dependencies (the `rehype-highlight` package, and each
 * grammar's own module) get fetched — on demand, via `import()`, so
 * neither one sits in the cockpit's own chunk any more (~100kB gzip
 * combined, per #574's measurement — see the PR for the current one).
 *
 * Whole-pipeline re-run rather than resuming from `renderMarkdownToHtml`'s
 * already-built tree is deliberate: it means this function has no shared
 * mutable state with the synchronous render, so there is nothing for the
 * two to race over beyond the plain string result the caller compares a
 * source key against (`MessageItem.svelte`'s `rendered` derivation) — the
 * modest extra parse cost buys a correctness argument that's trivial to
 * verify instead of one that depends on hast tree identity surviving an
 * `await`.
 *
 * Returns `null` — instead of the unhighlighted html — when `source` has
 * no fence in a language `HIGHLIGHT_LANGUAGE_LOADERS` resolves: nothing to
 * fetch, nothing to upgrade, and the caller knows to leave
 * `renderMarkdownToHtml`'s plain render exactly where it is rather than
 * scheduling a pointless re-render with identical output.
 */
export async function highlightMarkdownToHtml(source: string): Promise<string | null> {
  if (!source) return null;

  const canonicalLanguages = new Set<CanonicalHighlightLanguage>();
  for (const lang of collectFenceLanguages(source)) {
    const resolved = resolveHighlightLanguage(lang);
    if (resolved) canonicalLanguages.add(resolved);
  }
  if (canonicalLanguages.size === 0) return null;

  const rehypeHighlightPromise = loadRehypeHighlight();
  const languageEntriesPromise = Promise.all(
    [...canonicalLanguages].map(async (name) => [name, await loadLanguageModule(name)] as const),
  );
  const rehypeHighlight = await rehypeHighlightPromise;
  const languages = Object.fromEntries(await languageEntriesPromise);

  const highlighted = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize, defaultSchema)
    .use(externalLinks)
    .use(wrapTables)
    .use(rehypeHighlight, { languages, aliases: HIGHLIGHT_ALIASES })
    .use(rehypeStringify)
    .processSync(source);
  return String(highlighted);
}

/**
 * Splits a streaming message's revealed text at the last position it is
 * *safe* to fully parse as Markdown (issue #574's central streaming
 * decision — see the design spec §3.4 and the PR for the measurement).
 *
 * `MessageItem` renders `item.text` exactly as it arrives, straight off the
 * wire (issue #757 — no pacing, no reveal ticks); re-running the full
 * parse+sanitize+highlight pipeline on the whole message on every chunk
 * arrival does not hold up on a long, code-heavy turn. This function is the
 * cheap part of the fix: a linear scan (no parsing) that finds the last
 * point at which every block opened so far has also closed, so the caller
 * (`MessageItem`) only needs to re-run `renderMarkdownToHtml` when `stable`
 * itself actually grows, not on every arrival — most chunks move the
 * boundary inside `tailText` instead, which is a plain string, not a
 * re-parse.
 *
 * A position is safe once every block that started before it has also
 * ended before it:
 *
 * - The end of a closing fence line is always safe, independent of blank
 *   lines — a fenced code block is self-terminating in CommonMark, the
 *   next line can start a new block immediately.
 * - Otherwise, the end of a blank line (outside any fence) is safe — every
 *   other block type this renders (paragraph, list, heading, table,
 *   blockquote) is blank-line-delimited, so this one rule generalises to
 *   all of them without needing a bespoke boundary rule per block type. It
 *   is conservative for a few single-line block types (an ATX heading
 *   technically closes at its own line end, not the next blank line) —
 *   that only means a heading renders one tick later than the earliest
 *   theoretically-safe moment, never incorrectly.
 * - A still-open fence at the end of the scan is carved out into its own
 *   `openFence` result (lang + code-so-far) so the caller can render its
 *   body as a plain monospace box instead of raw text with visible
 *   backticks, and highlight it only once `matchFenceClose` finally closes
 *   it (issue #574's "never re-highlight per tick, highlight once closed"
 *   requirement, satisfied for free by this split rather than as a special
 *   case).
 *
 * `finalized` is `MessageItem`'s `!turnActive` — the real `turn_ended`
 * signal. Once a turn is over nothing more is coming, so the entire text
 * is treated as stable regardless of a
 * trailing partial block or an unterminated fence (CommonMark itself
 * defines an unclosed fence as implicitly closing at end of document, so
 * `renderMarkdownToHtml` handles that correctly on its own).
 */
export function splitStreamingMarkdown(text: string, finalized: boolean): StreamingMarkdownSplit {
  if (finalized) return { stable: text, tailText: '', openFence: null };

  let cursor = 0;
  let boundary = 0;
  let fence: FenceMarker | null = null;
  let fenceStart = -1;

  while (true) {
    const newlineIndex = text.indexOf('\n', cursor);
    if (newlineIndex === -1) break; // a still-typing final line is never itself a boundary source
    const line = text.slice(cursor, newlineIndex);
    const afterLine = newlineIndex + 1;

    if (fence) {
      if (matchFenceClose(line, fence)) {
        fence = null;
        fenceStart = -1;
        boundary = afterLine;
      }
    } else {
      const opened = matchFenceOpen(line);
      if (opened) {
        fence = opened;
        fenceStart = cursor;
      } else if (line.trim().length === 0) {
        boundary = afterLine;
      }
    }

    cursor = afterLine;
  }

  const stable = text.slice(0, boundary);
  if (fence) {
    const codeStart = text.indexOf('\n', fenceStart) + 1;
    return {
      stable,
      tailText: text.slice(boundary, fenceStart),
      openFence: { lang: fence.lang, code: text.slice(codeStart) },
    };
  }
  return { stable, tailText: text.slice(boundary), openFence: null };
}
