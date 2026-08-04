import { expect, sendSessionUpdate, test } from './fixtures';

/**
 * The Markdown syntax highlighter (`highlight.js` plus its grammars,
 * `rehype-highlight` in `$lib/markdown.ts`) is dynamically imported rather
 * than shipped in the cockpit's own chunk (issue #600 — split out of #574
 * once that landed full Markdown rendering and cost the cockpit ~100kB
 * gzip up front). Browser-driven on purpose: bundle-splitting is a build
 * + network-request fact, not something a jsdom component test observes —
 * `MessageItem.test.ts`'s async-highlight tests cover the render logic,
 * this spec covers the actual chunk never reaching the network until a
 * fence needs it.
 */
test.describe('lazy highlighter (issue #600)', () => {
  test('fetches no highlighter/grammar chunk until a message actually contains a fenced code block', async ({
    page,
    loombox,
  }) => {
    const requestedUrls: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/_app/immutable/')) requestedUrls.push(url);
    });

    await page.goto('/');
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    // A plain-text message — the common case, no code at all — must not
    // pull in the highlighter either.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-plain',
      text: 'Just a plain reply, no code here.',
    });
    await expect(page.getByText('Just a plain reply, no code here.')).toBeVisible();

    // No JS chunk requests fetched so far resemble the highlighter or a
    // grammar module reaching the network — the whole point of #600. Vite
    // hashes chunk filenames, so this can't be proven by name; instead the
    // fenced-code trigger below is the only thing that adds *any* further
    // `_app/immutable` request from here, which is the network-level half
    // of the proof — the DOM half (below) is that the token spans that
    // only the dynamically-imported grammar can produce actually land.
    const requestsBeforeFence = requestedUrls.length;

    // Now a fenced code block arrives — this is the trigger.
    await sendSessionUpdate(loombox.node, loombox.session, {
      kind: 'agent_message_chunk',
      turnId: 'turn-1',
      messageId: 'msg-code',
      text: '```ts\nconst answer: number = 42;\n```',
    });

    // Plain, unhighlighted, structurally correct first — same state an
    // open (still-streaming) fence already renders as, per #600's design.
    const codeBlock = page.locator('pre code.language-ts');
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock.locator('.hljs-keyword')).toHaveCount(0);

    // The dynamic import actually fires, and the render upgrades in place
    // once it resolves — no page reload, no layout change, just the token
    // spans landing.
    await expect(codeBlock.locator('.hljs-keyword')).toHaveCount(1, { timeout: 10_000 });
    expect(requestedUrls.length).toBeGreaterThan(requestsBeforeFence);
  });
});
