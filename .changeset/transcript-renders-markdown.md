---
'@loombox/web': patch
---

Render Markdown in the transcript instead of printing it literally

`MessageItem.svelte` interpolated `displayText` straight into a `<p>` with
`white-space: pre-wrap`, so a fenced code block showed its own backtick
fences and a `-` list showed dashes with no markers. There was no Markdown
dependency anywhere in `apps/web`. This was the largest finding of the v6
cockpit audit: most turns of real substance from a coding agent contain code
or a list, or both.

Agent and user turns now go through a real pipeline: `remark-parse` +
`remark-gfm` for CommonMark plus tables/strikethrough/task lists,
`remark-rehype` (without `allowDangerousHtml`, so a literal `<script>` or
`<img onerror=…>` typed by the agent is dropped before it ever becomes an
element rather than escaped-and-shown or executed), `rehype-sanitize` on
GitHub's own default schema (strips a `javascript:` link/image protocol),
then two small trusted plugins that run after sanitisation on purpose (an
external-link `target`/`rel` setter and a table-scroll wrapper), and finally
`rehype-highlight` with an explicit ~18-language `highlight.js` subset
(`typescript`, `javascript`, `python`, `bash`, `json`, `go`, `rust`, `sql`,
css/yaml/xml/markdown/dockerfile/java/cpp/csharp/ruby/diff and their common
aliases) rather than every grammar it ships. `$lib/markdown.ts` documents the
full ordering and why each step has to come where it does.

The transcript streams character by character (`TextPacer`, issue #137), and
re-running that whole pipeline on every 32ms reveal tick does not hold up on
a long turn. `splitStreamingMarkdown` finds the last point in the revealed
text where every block that has opened has also closed — the end of a
closing fence, or a blank line outside any fence — and only that "stable"
prefix is parsed; `MessageItem` only re-runs the real render when that
boundary itself advances, not on every tick. A still-open fenced code block
renders as a plain monospace box (the same code surface `GenericToolRow`'s
`.output` and `BashWidget`'s terminal already use, not a second visual
language) and is only syntax-highlighted the instant its closing fence
arrives, so a half-typed fence never flickers through a half-tokenised
state. Everything else (lists, tables, headings, emphasis) is styled with
Deck tokens directly in `MessageItem.svelte`'s own `<style>` block, not a
library stylesheet; a wide table scrolls horizontally inside its own wrapper
instead of stretching the transcript row.

`PlanCard` and tool-call output are explicitly out of scope here: `$lib/markdown`
is a plain, reusable module, but `ToolCallRow.svelte`/`PlanCard.svelte` and
the `tool-widgets/` tree were being worked on concurrently by other agents
during this change, so wiring them in is left as a small follow-up rather
than risking a collision.

Bundle cost, measured with `vite build` on `apps/web`: the client JS under
`_app/immutable` goes from 813,029 bytes raw / 231,245 bytes gzip to
1,144,276 bytes raw / 332,795 bytes gzip (+331,247 raw, +101,550 gzip, about
+44% gzip) — almost entirely inside the cockpit route's own chunk
(`nodes/2.*.js`, 265,788 bytes gzip on its own), which the client only loads
once a session is actually opened, not on first paint of the sign-in/inbox
screens.
