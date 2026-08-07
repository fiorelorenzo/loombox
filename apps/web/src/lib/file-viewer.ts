/**
 * The read-only file viewer's syntax-highlighting adapter (issue #737):
 * wraps a file's raw content in a Markdown fenced code block tagged with
 * `$lib/diff.ts`'s own `languageForPath` guess — the exact tag
 * `DiffViewer` already derives for its own per-line coloring class, reused
 * here rather than a second file-extension table — then hands the whole
 * thing to `$lib/markdown.ts`'s `renderMarkdownToHtml`/
 * `highlightMarkdownToHtml`, the same lazy-loaded highlighter #600 built
 * for a transcript's own fenced code blocks. `FileEditor.svelte`'s view
 * mode (issue #205 renamed and extended #737's read-only `FileViewer`) is the
 * only caller; this module holds the one pure, independently testable
 * piece — building a fence CommonMark can never parse as closing early,
 * given arbitrary file content — while the render-trigger orchestration
 * (the sync plain render first, the async highlighted one upgrading it)
 * stays inline in the component, the same two-step split
 * `MessageItem.svelte`'s own `rendered` derivation already uses.
 */
import { languageForPath } from './diff';

/**
 * CommonMark requires a fenced code block's CLOSING fence to be at least
 * as long as its opening one — so a run of backticks inside `content`
 * longer than or equal to a bare ```` ``` ```` opener would let the
 * parser close the fence early, right there in the file's own text, and
 * start reinterpreting the rest of the file as Markdown instead of
 * literal code. Opening with a fence one backtick longer than the
 * longest run actually present in `content` makes that structurally
 * impossible: no substring of `content` can ever close it early, so
 * everything between open and close renders as inert text regardless of
 * what the file contains.
 */
function fenceLength(content: string): number {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return Math.max(3, longest + 1);
}

/**
 * Wraps `content` in a fenced code block tagged with `path`'s guessed
 * language (via `languageForPath`; its `'plain'` fallback renders an
 * untagged fence — `$lib/markdown.ts`'s own highlighter already leaves an
 * unresolved fence language as plain monospace, the identical fallback a
 * transcript fence gets). The trailing newline before the closing fence
 * guards content that doesn't itself end in one — CommonMark's own
 * fence-closing rule needs the closer on its own line.
 */
export function fenceWrapFileContent(path: string, content: string): string {
  const lang = languageForPath(path);
  const fence = '`'.repeat(fenceLength(content));
  const info = lang === 'plain' ? '' : lang;
  const body = content === '' || content.endsWith('\n') ? content : `${content}\n`;
  return `${fence}${info}\n${body}${fence}\n`;
}
