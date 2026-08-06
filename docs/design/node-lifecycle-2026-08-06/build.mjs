#!/usr/bin/env node
/**
 * Assembles the node-lifecycle decision artifact into one self-contained HTML
 * file.
 *
 *   node docs/design/node-lifecycle-2026-08-06/build.mjs
 *
 * Self-contained on purpose: the output is scp'd to Lorenzo's Mac and opened
 * from `file://`, so it cannot fetch a stylesheet at runtime. Same shape as
 * docs/design/ux-review-2026-08-05/build.mjs, minus the icon sprite (this
 * artifact has no rebuilt UI stages, only prose and code).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

/** Section order is the order Lorenzo reads them in: the blocker first. */
const SECTIONS = [
  { id: 'a', file: 'section-a-runtime.html', label: 'What runs' },
  { id: 'b', file: 'section-b-order.html', label: 'Platform order' },
  { id: 'c', file: 'section-c-secrets.html', label: 'Secrets' },
  { id: 'd', file: 'section-d-entrypoint.html', label: 'Who installs' },
  { id: 'e', file: 'section-e-uninstall.html', label: 'Uninstall' },
  { id: 'f', file: 'section-f-found.html', label: 'Found tonight' },
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
    <title>loombox node lifecycle, 2026-08-06</title>
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
    </style>
  </head>
  <body>
    <div class="toolbar">
      <strong>node lifecycle</strong>
      ${nav}
      <button class="lb-btn lb-btn-sm" id="theme">Light</button>
    </div>

    <div class="doc">
      <div class="doc-head">
        <h1>Making the node survive, 6 August 2026</h1>
        <p>
          Your devbox node is a supervised service again as of tonight (F1), but that is a unit file
          I wrote by hand on one machine. Turning it into the product is epic #653, and five
          decisions there are yours. A1 is the one that blocks the other four.
        </p>
        <p>
          The red dashed card is what the code does today, checked against the source, not
          remembered. Every option says what it buys and what it costs.
        </p>
      </div>

      <div class="howto">
        <h3>How to answer</h3>
        <ol>
          <li>Each decision has an id like <code>A1</code>.</li>
          <li>Pick one option per decision, by id: <code>A1-2</code>.</li>
          <li>If nothing fits, say so on that decision and what is missing.</li>
          <li>Reply with just the list, for example <code>A1-4, B1-2, C1-1, D1-2, E1-1</code>.</li>
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
