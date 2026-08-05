#!/usr/bin/env node
/**
 * Assembles the Zed-parity decision artifact into one self-contained HTML file.
 *
 *   node docs/design/zed-parity-2026-08-05/build.mjs
 *
 * Self-contained on purpose: the output is opened from `file://` on Lorenzo's
 * Mac, so it cannot fetch a stylesheet or a sprite at runtime.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

/** Section order is the order Lorenzo reviews them in. */
const SECTIONS = [
  { id: 'a', file: 'section-a-look.html', label: 'The look' },
  { id: 'b', file: 'section-b-chrome.html', label: 'Chrome & layout' },
  { id: 'c', file: 'section-c-transcript.html', label: 'The thread' },
  { id: 'd', file: 'section-d-agents-mcp.html', label: 'Agents & MCP' },
  { id: 'e', file: 'section-e-speed.html', label: 'Speed' },
  { id: 'f', file: 'section-f-keyboard.html', label: 'Keyboard' },
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
    <title>loombox vs Zed, 2026-08-05</title>
    <style>
${read('_shell.css')}

      /* Artifact-only chrome for the assembled page */
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
      .missing {
        border: 1px dashed var(--color-warning);
        background: var(--color-warning-subtle);
        color: var(--color-warning);
        border-radius: var(--radius-lg);
        padding: var(--space-md);
        margin-bottom: var(--space-xl);
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
      .howto code {
        font-family: var(--font-mono);
        font-size: var(--text-code-size);
        background: var(--color-fill-subtle);
        border-radius: var(--radius-sm);
        padding: 0 var(--space-2xs);
        color: var(--color-text-primary);
      }
    </style>
  </head>
  <body>
${read('_icons.html')}

    <div class="toolbar">
      <strong>loombox vs Zed</strong>
      ${nav}
      <button class="lb-btn lb-btn-sm" id="theme">Light</button>
      <button class="lb-btn lb-btn-sm" id="narrow">Narrow</button>
    </div>

    <div class="doc">
      <div class="doc-head">
        <h1>How far do we go toward Zed?</h1>
        <p>
          You said Zed's UX is what you want, more dev-oriented than what we ship, and faster.
          This takes that apart into the decisions it actually implies: the look, the chrome, the
          thread, agents and MCP, speed, and the keyboard. Every decision shows what loombox does
          today, rebuilt from the current code, and two to four ways it could work instead.
        </p>
        <p>
          Nothing here is built. The trade sentence on each option says what it costs, not only
          what it looks like. Where an option depends on plumbing we have not written, it says so
          in its first line. What needs no decision from you is already on the board.
        </p>
      </div>

      <div class="howto">
        <h3>How to answer</h3>
        <ol>
          <li>Go through the decisions in order. Each has an id like <code>C1</code>.</li>
          <li>Pick one option per decision, by id: <code>C1-2</code>.</li>
          <li>
            If nothing fits, say so on that decision and what is missing. That is a useful answer,
            not a failure.
          </li>
          <li>
            Reply with just the list, for example
            <code>A1-2, A2-1, A3-2, B1-1, ...</code>
          </li>
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

      // Squeezes every stage to a phone-ish measure, so an option can be
      // judged at 390px without resizing the window.
      const narrowBtn = document.getElementById('narrow');
      narrowBtn.addEventListener('click', () => {
        const on = document.body.classList.toggle('is-narrow');
        narrowBtn.textContent = on ? 'Wide' : 'Narrow';
      });
    </script>
    <style>
      body.is-narrow .options {
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }
      body.is-narrow .stage {
        max-width: 390px;
      }
    </style>
  </body>
</html>
`;

const out = join(here, 'index.html');
writeFileSync(out, html);
console.log(`wrote ${out}`);
console.log(`sections: ${present.map((s) => s.id).join(', ') || 'none'}`);
if (missing.length) console.log(`missing: ${missing.map((s) => s.id).join(', ')}`);
