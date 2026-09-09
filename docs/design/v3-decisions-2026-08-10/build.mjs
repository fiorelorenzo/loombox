#!/usr/bin/env node
/**
 * Assembles the v3 decisions artifact into one self-contained HTML file.
 *
 *   node docs/design/v3-decisions-2026-08-10/build.mjs
 *
 * Self-contained on purpose: the output is opened from `file://`, so it
 * cannot fetch a stylesheet at runtime. Same shape as
 * docs/design/node-lifecycle-2026-08-06/build.mjs, minus the icon sprite
 * (this artifact is prose and citations, not rebuilt UI).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

/** Section order is the order Lorenzo reads them in: not urgent, urgent, then the
 * one with no engineering content in it at all. */
const SECTIONS = [
  { id: 'a', file: 'section-a-transport.html', label: 'Realtime voice transport' },
  { id: 'b', file: 'section-b-approval.html', label: 'Voice-approval scope' },
  { id: 'c', file: 'section-c-store-identity.html', label: 'Store identity' },
];

const present = SECTIONS.filter((s) => existsSync(join(here, s.file)));
const missing = SECTIONS.filter((s) => !existsSync(join(here, s.file)));

const nav = present
  .map((s) => `<a class="navlink" href="#sec-${s.id}">${s.label}</a>`)
  .join('\n        ');

const body = present
  .map(
    (s) => `
    <div class="sec" id="sec-${s.id}">
      <h2 class="sec-title"><span class="sec-letter">${s.id.toUpperCase()}</span> ${s.label}</h2>
${read(s.file)}
    </div>`,
  )
  .join('\n');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>loombox v3 decisions, 2026-08-10</title>
    <style>
${read('_shell.css')}

      .navlink {
        font-size: var(--text-small-size);
        color: var(--color-text-secondary);
        text-decoration: none;
        padding: var(--space-2xs) var(--space-sm);
        border-radius: var(--radius-md);
      }
      .navlink:hover {
        background: var(--color-fill-subtle);
        color: var(--color-text-primary);
      }
      .sec {
        margin-bottom: var(--space-3xl);
        scroll-margin-top: 4rem;
      }
      .sec-title {
        display: flex;
        align-items: center;
        gap: var(--space-md);
        font-size: var(--text-display-size);
        line-height: var(--text-display-line);
        font-weight: var(--text-display-weight);
        margin: 0 0 var(--space-xl);
        padding-bottom: var(--space-sm);
        border-bottom: 1px solid var(--color-border);
      }
      .sec-letter {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        border-radius: var(--radius-md);
        background: var(--color-accent-subtle);
        color: var(--color-accent);
        font-family: var(--font-mono);
        font-size: var(--text-title-size);
      }
      .howto {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-surface);
        padding: var(--space-lg);
        margin-bottom: var(--space-2xl);
      }
      .howto h3 {
        margin: 0 0 var(--space-sm);
        font-size: var(--text-title-size);
      }
      .howto ol {
        margin: 0;
        padding-left: var(--space-lg);
        color: var(--color-text-secondary);
      }
      .howto li {
        margin-bottom: var(--space-2xs);
      }
      .howto code,
      .item-note code,
      .opt-why code {
        font-family: var(--font-mono);
        font-size: var(--text-code-size);
        background: var(--color-fill-subtle);
        border-radius: var(--radius-sm);
        padding: 0 var(--space-2xs);
        color: var(--color-text-primary);
      }
      /* This artifact is prose, not rebuilt UI: one readable column of cards. */
      .options.stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
      }
      /* A one-line status next to an item's own id: not urgent / urgent /
         no decision, so the reading order also carries priority. */
      .item-status {
        font-size: var(--text-small-size);
        font-weight: 600;
        padding: var(--space-3xs) var(--space-sm);
        border-radius: var(--radius-full);
        margin-left: var(--space-sm);
      }
      .item-status.urgent {
        background: var(--color-danger-subtle);
        color: var(--color-danger);
      }
      .item-status.deferrable {
        background: var(--color-fill-subtle);
        color: var(--color-text-secondary);
      }
      .item-status.settled {
        background: var(--color-success-subtle);
        color: var(--color-success);
      }
      .item-head {
        flex-wrap: wrap;
      }
      .rec {
        border: 1px solid var(--color-accent-subtle);
        border-radius: var(--radius-lg);
        background: var(--color-accent-subtle);
        padding: var(--space-md) var(--space-lg);
        margin: var(--space-md) 0 var(--space-lg);
      }
      .rec p {
        margin: 0;
      }
      .rec .rec-label {
        font-weight: 600;
        color: var(--color-accent);
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <strong>loombox v3 decisions</strong>
      ${nav}
      <button class="lb-btn lb-btn-sm" id="theme">Light</button>
    </div>

    <div class="doc">
      <div class="doc-head">
        <h1>Three decisions before voice can start, 10 August 2026</h1>
        <p>
          #277's design (merged in #945) named two open questions on purpose rather than guessing at
          them. #283 raises a third that has nothing to do with voice but shares the same shape: a
          call only you can make, hard to reverse, that blocks real work otherwise ready to start
          (#278, #279, #280, and #283 itself).
        </p>
        <p>
          Each decision opens with what is true today, checked against this repo and, where the
          claim is about a vendor, against that vendor's own current documentation, cited by URL.
          Where I think one option is clearly right I say so and why the others are still worth
          reading; where it is genuinely your call, I say that too.
        </p>
      </div>

      <div class="howto">
        <h3>How to answer</h3>
        <ol>
          <li>Each decision has an id like <code>A1</code>.</li>
          <li>Pick one option per decision, by id: <code>A1-2</code>.</li>
          <li>If nothing fits, say so and what is missing — that is a useful answer.</li>
          <li>Reply with just the list, for example <code>A1-2, B1-1, C1-1</code>.</li>
        </ol>
      </div>

      ${
        missing.length
          ? `<div class="missing">Not yet written: ${missing.map((m) => m.label).join(', ')}.</div>`
          : ''
      }

${body}
    </div>

    <script>
      const root = document.documentElement;
      const themeBtn = document.getElementById('theme');
      themeBtn.addEventListener('click', () => {
        const light = root.getAttribute('data-theme') === 'light';
        root.setAttribute('data-theme', light ? 'dark' : 'light');
        themeBtn.textContent = light ? 'Light' : 'Dark';
      });
    </script>
  </body>
</html>
`;

const out = join(here, 'index.html');
writeFileSync(out, html);
console.log(`wrote ${out}`);
console.log(`sections: ${present.map((s) => s.id).join(', ') || 'none'}`);
if (missing.length) console.log(`missing: ${missing.map((s) => s.id).join(', ')}`);
