import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root } from 'hast';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Transcript Markdown (issue #574, design spec `2026-08-03-cockpit-v6-design.md`
 * §3.4): a full CommonMark + GFM (tables, strikethrough, task lists) render
 * path for agent/user turns, sanitised because agent output is untrusted text
 * that will contain HTML sooner or later, and syntax-highlighted with an
 * explicit, restricted `highlight.js` language subset rather than shipping
 * every grammar (this is a mobile-first client — see the PR for the measured
 * bundle cost).
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
 * 6. `rehypeHighlight` — deliberately the LAST content-producing step, for
 *    the same trusted-after-sanitize reasoning: it injects `hljs-*` token
 *    `<span>`s that the sanitizer's default schema doesn't know about, and
 *    since sanitisation already happened, nothing strips them back out.
 *    Only `HIGHLIGHT_LANGUAGES` below is registered (not `lowlight`'s
 *    `common`/`all` bundles), so an unlisted fence language quietly renders
 *    as plain, unhighlighted (but still monospaced) code — never an error.
 * 7. `rehypeStringify` — hast back to an HTML string.
 *
 * `processor.processSync` (every stage above is synchronous) rather than the
 * async `.process()`: this is called from a Svelte `$derived` in
 * `MessageItem.svelte`, which must resolve synchronously.
 */

const HIGHLIGHT_LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  ruby,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

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

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, defaultSchema)
  .use(externalLinks)
  .use(wrapTables)
  .use(rehypeHighlight, { languages: HIGHLIGHT_LANGUAGES, aliases: HIGHLIGHT_ALIASES })
  .use(rehypeStringify);

/** Renders a Markdown source string to a sanitised HTML string, safe to insert via Svelte's `{@html}` — see the module doc comment for the full pipeline and its security reasoning. Callers only ever pass this a "stable" source (see `splitStreamingMarkdown`): a still-streaming, not-yet-closed construct is never parsed as Markdown at all, it renders as plain text/monospace until it closes. */
export function renderMarkdownToHtml(source: string): string {
  if (!source) return '';
  return String(processor.processSync(source));
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
 * Splits a streaming message's revealed text at the last position it is
 * *safe* to fully parse as Markdown (issue #574's central streaming
 * decision — see the design spec §3.4 and the PR for the measurement).
 *
 * `MessageItem`'s `TextPacer` reveals `displayText` a few characters at a
 * time on a 32ms tick; re-running the full parse+sanitize+highlight
 * pipeline on the whole message every tick does not hold up on a long,
 * code-heavy turn. This function is the cheap part of the fix: a linear
 * scan (no parsing) that finds the last point at which every block opened
 * so far has also closed, so the caller (`MessageItem`) only needs to
 * re-run `renderMarkdownToHtml` when `stable` itself actually grows, not on
 * every tick — most ticks move the boundary inside `tailText` instead,
 * which is a plain string, not a re-parse.
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
 * signal `TextPacer.flush` already keys off. Once a turn is over nothing
 * more is coming, so the entire text is treated as stable regardless of a
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
