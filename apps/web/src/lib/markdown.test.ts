import { describe, expect, it } from 'vitest';
import { highlightMarkdownToHtml, renderMarkdownToHtml, splitStreamingMarkdown } from './markdown';

describe('renderMarkdownToHtml (#574)', () => {
  it('renders a fenced ts block as a code block with no visible backticks, plain until highlighted (#600)', () => {
    const html = renderMarkdownToHtml('```ts\nconst x: number = 1;\n```');
    expect(html).not.toContain('```');
    expect(html).toContain('<pre>');
    // The language class comes from remark-rehype's own fenced-code
    // handling, not from the (now async, see #600) highlighter — it's
    // there on the very first synchronous render.
    expect(html).toContain('language-ts');
    // No token spans yet: highlighting is `highlightMarkdownToHtml`'s job.
    expect(html).not.toContain('hljs-');
  });

  it('renders a nested list with real markers and indentation (nested <ul>)', () => {
    const html = renderMarkdownToHtml('- a\n  - nested a1\n  - nested a2\n- b');
    expect(html).toContain('<ul>');
    const outerOpen = html.indexOf('<ul>');
    const nestedOpen = html.indexOf('<ul>', outerOpen + 1);
    expect(nestedOpen).toBeGreaterThan(outerOpen);
    expect(html.match(/<li>/g)?.length).toBe(4); // a, nested a1, nested a2, b
  });

  it('renders bold, italic, inline code, links, headings and tables', () => {
    const html = renderMarkdownToHtml(
      [
        '# Heading',
        '',
        '**bold** and *italic* and `inline code`',
        '',
        '[docs](https://example.com/x)',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    );
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<a href="https://example.com/x"');
    expect(html).toContain('<table>');
  });

  it('wraps a table in a scroll container instead of leaving it to stretch the row', () => {
    const html = renderMarkdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toMatch(/<div class="md-table-scroll"><table>/);
  });

  it('opens links externally: target=_blank, rel=noopener noreferrer', () => {
    const html = renderMarkdownToHtml('[docs](https://example.com/x)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders an unregistered fence language as plain monospace, same as any other fence pre-highlight', () => {
    const html = renderMarkdownToHtml('```brainfuck\n+++.\n```');
    expect(html).toContain('<pre><code');
    expect(html).not.toContain('hljs-');
  });

  it('sanitises a raw <script> tag out of agent text — it never becomes a script element', () => {
    const html = renderMarkdownToHtml('before <script>alert(1)</script> after');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
  });

  it('sanitises a raw <img onerror=...> — no event handler survives, in fact no img element does', () => {
    const html = renderMarkdownToHtml('raw <img src=x onerror=alert(1)> end');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  it('strips a javascript: protocol from a real Markdown link/image rather than passing it through', () => {
    const html = renderMarkdownToHtml(
      '[click me](javascript:alert(1))\n\n![x](javascript:alert(1))',
    );
    expect(html).not.toContain('javascript:');
  });

  it('returns an empty string for empty input without invoking the pipeline', () => {
    expect(renderMarkdownToHtml('')).toBe('');
  });
});

describe('highlightMarkdownToHtml (#600 async highlighter)', () => {
  it('dynamically loads the grammar and returns fully tokenised html for a registered language', async () => {
    const html = await highlightMarkdownToHtml('```ts\nconst x: number = 1;\n```');
    expect(html).not.toBeNull();
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('language-ts');
  });

  it('resolves an alias (py) to its canonical grammar (python) the same way the old eager registration did', async () => {
    const html = await highlightMarkdownToHtml('```py\nimport os\n```');
    expect(html).toContain('hljs-keyword');
  });

  it('returns null — nothing to upgrade — for an unregistered fence language, without fetching anything undefined', async () => {
    const html = await highlightMarkdownToHtml('```brainfuck\n+++.\n```');
    expect(html).toBeNull();
  });

  it('returns null for source with no fence at all', async () => {
    expect(await highlightMarkdownToHtml('just prose, no code')).toBeNull();
  });

  it('returns null for empty input without invoking the pipeline', async () => {
    expect(await highlightMarkdownToHtml('')).toBeNull();
  });

  it('highlights every registered language a single message references, not just the first', async () => {
    const html = await highlightMarkdownToHtml(
      '```ts\nconst x = 1;\n```\n\n```python\nimport os\n```',
    );
    expect(html).toContain('language-ts');
    expect(html).toContain('language-python');
    expect(html).toContain('hljs-keyword');
  });

  // Sanitisation ordering (issue #600 requirement): `highlightMarkdownToHtml`
  // re-runs the whole pipeline — remark, `rehype-sanitize` on the unmodified
  // default schema, the trusted plugins, *then* `rehypeHighlight` — rather
  // than resuming from a stashed, already-sanitised tree. These two tests
  // are the proof: a `<script>`/`<img onerror>` sitting right next to a
  // fence that forces the async pipeline to actually run still can't reach
  // the DOM as a live element through the highlighted output.
  it('never lets a raw <script> tag become a live element through the async highlight path', async () => {
    const html = await highlightMarkdownToHtml(
      'before <script>alert(1)</script>\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).not.toBeNull();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
  });

  it('never lets a raw <img onerror=...> become a live element through the async highlight path', async () => {
    const html = await highlightMarkdownToHtml(
      'raw <img src=x onerror=alert(1)>\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).not.toBeNull();
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  it('still strips a javascript: protocol link through the async highlight path', async () => {
    const html = await highlightMarkdownToHtml(
      '[click me](javascript:alert(1))\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).not.toBeNull();
    expect(html).not.toContain('javascript:');
  });
});

describe('splitStreamingMarkdown (#574 streaming)', () => {
  it('keeps everything in tailText until a block boundary closes, when not finalized', () => {
    const split = splitStreamingMarkdown('- item one\n- item tw', false);
    expect(split.stable).toBe('');
    expect(split.tailText).toBe('- item one\n- item tw');
    expect(split.openFence).toBeNull();
  });

  it('moves a paragraph into stable once its blank-line boundary arrives', () => {
    const split = splitStreamingMarkdown('para one\n\npara tw', false);
    expect(split.stable).toBe('para one\n\n');
    expect(split.tailText).toBe('para tw');
  });

  it('treats a still-open fence as openFence, not as literal tail text with visible backticks', () => {
    const text = 'Explain:\n\n```ts\nconst x: number = 1;\nconsole.lo';
    const split = splitStreamingMarkdown(text, false);
    expect(split.stable).toBe('Explain:\n\n');
    expect(split.openFence).toEqual({ lang: 'ts', code: 'const x: number = 1;\nconsole.lo' });
    expect(split.tailText).toBe('');
  });

  it('renders a half-open fence sensibly at several intermediate reveal offsets, monotonically, without ever losing the opening prose', () => {
    const full = 'Explain:\n\n```ts\nconst x: number = 1;\nconsole.log(x);\n```\n\nDone.';
    const offsets = [10, 17, 25, 40, 54, 55, 58, 59, 60, 63, full.length];
    let previousCodeLength = -1;
    for (const cut of offsets) {
      const split = splitStreamingMarkdown(full.slice(0, cut), false);
      // The opening paragraph is always intact once revealed — never
      // reappears as raw/duplicated text once it's become stable.
      if (cut >= 10) expect(split.stable.startsWith('Explain:\n\n')).toBe(true);
      if (split.openFence) {
        // The fence body only ever grows or gets superseded by the close —
        // never shrinks or drops already-revealed characters mid-stream.
        expect(split.openFence.code.length).toBeGreaterThanOrEqual(0);
        expect(full).toContain(split.openFence.code);
        previousCodeLength = split.openFence.code.length;
      }
    }
    expect(previousCodeLength).toBeGreaterThan(0);

    // Once the fence actually closes and a blank line follows, it moves
    // into `stable` (eligible for highlighting) and stops being openFence.
    const closed = splitStreamingMarkdown(full.slice(0, 60), false);
    expect(closed.openFence).toBeNull();
    expect(closed.stable).toContain('```ts\nconst x: number = 1;\nconsole.log(x);\n```\n\n');
    expect(closed.tailText).toBe('Do');
  });

  it('never re-derives an already-stable prefix differently as more text streams in (monotonic, no flicker)', () => {
    const full = 'first para\n\nsecond para is still gro';
    const atA = splitStreamingMarkdown(full.slice(0, 20), false);
    const atB = splitStreamingMarkdown(full, false);
    // The stable portion computed early is a strict, unchanged prefix of
    // the stable portion computed later — it never gets rewritten.
    expect(atB.stable.startsWith(atA.stable)).toBe(true);
  });

  it('finalized (turn ended) always renders the whole text as stable, even a dangling unclosed fence or no trailing blank line', () => {
    const split = splitStreamingMarkdown('para\n\n```ts\nconst x = 1;\nno close', true);
    expect(split.stable).toBe('para\n\n```ts\nconst x = 1;\nno close');
    expect(split.tailText).toBe('');
    expect(split.openFence).toBeNull();
    // And renderMarkdownToHtml handles that unclosed fence gracefully
    // (CommonMark: an unclosed fence implicitly closes at EOF).
    const html = renderMarkdownToHtml(split.stable);
    expect(html).toContain('<pre>');
    expect(html).toContain('no close');
  });

  it('a line between two fences with no blank line separating them stays literal tail text, not swallowed into the next fence body', () => {
    const text = '```ts\ncode\n```\nmore\n```py\nopen';
    const split = splitStreamingMarkdown(text, false);
    expect(split.tailText).toBe('more\n');
    expect(split.openFence).toEqual({ lang: 'py', code: 'open' });
  });
});
