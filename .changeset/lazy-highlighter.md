---
'@loombox/web': patch
---

Lazily load the transcript Markdown syntax highlighter instead of shipping it in the cockpit's first chunk (issue #600)

#574 landed full Markdown rendering in the transcript, and `highlight.js` plus its 18 registered grammars (`rehype-highlight` in `apps/web/src/lib/markdown.ts`) landed eagerly in the cockpit route's own chunk — measured at +101,550 B gzip on top of #574's own pipeline. `$lib/markdown.ts`'s `renderMarkdownToHtml` (the synchronous first render every message goes through) no longer highlights at all; a new async `highlightMarkdownToHtml` dynamically imports `rehype-highlight` and only the grammar(s) a given message's fences actually reference, then upgrades the render in place once it resolves. A closed fence renders plain monospace (readable, escaped, already carrying its `language-xxx` class from `remark-rehype`'s own fenced-code handling) until then — the same state an _open_, still-streaming fence already renders as, so there's no new visual state and no flash to design around.

`MessageItem.svelte` composes the two independent async triggers (streaming's fence-close re-render, and the highlighter's own async arrival) without racing: a highlight result only applies if the stable source it was computed for is still current when it resolves.

Sanitisation ordering is unchanged — `highlightMarkdownToHtml` re-runs the identical pipeline (`remark-parse`/`remark-gfm` → `remark-rehype` without `allowDangerousHtml` → `rehype-sanitize` on the unmodified default schema → the trusted `externalLinks`/`wrapTables` plugins → `rehype-highlight` → `rehype-stringify`), just invoked asynchronously; highlighting still runs after sanitisation in every case.

Measured with `vite build` on `apps/web`: the cockpit route's own chunk (`nodes/2.*.js`) drops from 977,513 B / 269,244 B gzip to 811,570 B / 217,331 B gzip (−165,943 B raw, −51,913 B gzip, −19.3%). The highlighter and its grammars (~100 kB raw / ~33 kB gzip, in a shared chunk split out of the cockpit bundle) are now fetched only the first time a message's fence actually needs highlighting — never, for a session with no code blocks.
