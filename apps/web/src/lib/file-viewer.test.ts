import { describe, expect, it } from 'vitest';
import { fenceWrapFileContent } from './file-viewer';
import { renderMarkdownToHtml } from './markdown';

describe('fenceWrapFileContent', () => {
  it('wraps content in a triple-backtick fence tagged with the path-derived language', () => {
    const wrapped = fenceWrapFileContent('src/foo.ts', 'const x = 1;\n');
    expect(wrapped).toBe('```js\nconst x = 1;\n```\n');
  });

  it('leaves the fence untagged for a path languageForPath cannot guess (its own "plain" fallback)', () => {
    const wrapped = fenceWrapFileContent('README.txt', 'hello\n');
    expect(wrapped).toBe('```\nhello\n```\n');
  });

  it('appends a trailing newline before the closing fence when content does not already end in one', () => {
    const wrapped = fenceWrapFileContent('src/foo.py', 'x = 1');
    expect(wrapped).toBe('```python\nx = 1\n```\n');
  });

  it('handles empty content without producing a malformed fence', () => {
    const wrapped = fenceWrapFileContent('src/foo.py', '');
    expect(wrapped).toBe('```python\n```\n');
  });

  it("widens the fence past the longest backtick run in content — CommonMark's closing-fence rule can never let the file's own text close it early", () => {
    const content = 'here is a ``` triple backtick run\n';
    const wrapped = fenceWrapFileContent('README.txt', content);
    expect(wrapped.startsWith('````\n')).toBe(true);
    expect(wrapped.endsWith('````\n')).toBe(true);

    const evenWider = 'a run of ```` four backticks\n';
    const wrappedWider = fenceWrapFileContent('README.txt', evenWider);
    expect(wrappedWider.startsWith('`````\n')).toBe(true);
  });

  it('round-trips pathological content (embedded backtick fences, raw HTML) through the real markdown pipeline as literal, inert text', () => {
    const content = [
      'not markdown, just a file that happens to contain:',
      '```js',
      'still literal',
      '```',
      '<script>alert(1)</script>',
      '',
    ].join('\n');
    const wrapped = fenceWrapFileContent('notes.txt', content);
    const html = renderMarkdownToHtml(wrapped);

    // Everything landed inside ONE <pre><code> block, not parsed as a
    // second real fence or as raw HTML breaking out of it.
    expect(html).toContain('<pre>');
    expect(html.match(/<pre>/g)).toHaveLength(1);
    expect(html).toContain('still literal');
    // The embedded <script> is inert text inside the code block, not a
    // real (and dangerous) <script> element in the rendered DOM.
    expect(html).not.toMatch(/<script>alert/);
  });
});
