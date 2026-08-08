// A plain source-scan, not a rendered-DOM test: Svelte component `<style>`
// blocks never make it into jsdom's `document` under this repo's vitest
// setup (no CSS-in-JS injection happens for component tests here), so the
// only way to actually exercise "does every custom-property reference
// resolve" is to read the same text `grep` would. This is deliberately the
// exact method the coherence v5 §5 token-hygiene audit used (issue #508):
// diff every custom property DEFINED in `styles/*.css` against every one
// USED (via a CSS `var()` call) anywhere under `apps/web/src`.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(stylesDir, '..', '..'); // apps/web/src

const TOKEN_DEF = /^\s*(--[a-z0-9-]+):/gm;
const TOKEN_USE = /var\((--[a-z0-9-]+)/g;
// `.css`/`.svelte`/JS block comments all share `/* ... */` syntax, so one
// strip handles both a CSS doc comment (`tokens.css`'s reduced-motion note)
// and a `<script>`-block JSDoc comment (`Button.svelte`'s motion-discipline
// note) — neither is a stylesheet rule, so a token they merely *mention*
// (e.g. the wildcard pattern `--duration-*`) must never fail this check.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// Only these extensions ever produce CSS a browser actually parses. `.ts`
// test files can contain a token's name in an assertion string (this file's
// own DirectoryPicker regression test does) without that being real CSS.
const STYLE_BEARING_EXTENSIONS = new Set(['.css', '.svelte']);

function definedTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const file of readdirSync(stylesDir)) {
    if (!file.endsWith('.css')) continue;
    const text = readFileSync(join(stylesDir, file), 'utf8').replace(BLOCK_COMMENT, '');
    for (const match of text.matchAll(TOKEN_DEF)) tokens.add(match[1]);
  }
  return tokens;
}

/** Every regular file under `dir`, recursively — mirrors `grep -r`'s walk. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every distinct custom property used via `var(...)` in real CSS, mapped to one file that uses it (for a readable failure message). */
function usedTokens(files: string[]): Map<string, string> {
  const usages = new Map<string, string>();
  for (const file of files) {
    if (!STYLE_BEARING_EXTENSIONS.has(extname(file))) continue;
    const text = readFileSync(file, 'utf8').replace(BLOCK_COMMENT, '');
    for (const match of text.matchAll(TOKEN_USE)) {
      const token = match[1];
      // Defensive backstop: no real custom property is ever named with a
      // trailing bare `-` — that shape only occurs when the greedy match
      // runs into a character outside `[a-z0-9-]` right after a hyphen.
      if (token.endsWith('-')) continue;
      if (!usages.has(token)) usages.set(token, file);
    }
  }
  return usages;
}

describe('design tokens (coherence v5 §5 token hygiene, issue #508)', () => {
  it('every custom-property reference under apps/web/src resolves to a property defined in styles/*.css', () => {
    const defined = definedTokens();
    // Sanity check on the fixture itself: if this collapses to near-zero,
    // `definedTokens()`'s glob or regex broke silently rather than the
    // real invariant passing vacuously.
    expect(defined.size).toBeGreaterThan(50);

    const used = usedTokens(walk(srcDir));
    const missing = [...used.entries()].filter(([token]) => !defined.has(token));

    expect(
      missing,
      missing.map(([token, file]) => `${token} (used in ${file}, never defined)`).join('\n'),
    ).toEqual([]);
  });
});

describe('issue #580 stragglers migration (icon sizes, dialog geometry, one-off dimensions)', () => {
  const iconSizeTokens = ['--icon-size-sm', '--icon-size-md', '--icon-size-lg'];
  const dialogGeometryTokens = ['--dialog-width-sm', '--dialog-width-md', '--dialog-max-height'];
  const dimensionTokens = [
    '--status-meter-track-width',
    '--status-meter-track-height',
    '--attachment-thumb-size',
    '--attachment-chip-max-width',
    '--diff-gutter-width',
    '--diff-marker-width',
    '--scroll-cap-height',
    '--swatch-icon-size',
    '--swatch-size',
    '--swatch-check-size',
    '--swatch-custom-size',
  ];

  it('every token this pass added is both defined and actually consumed somewhere under apps/web/src', () => {
    const defined = definedTokens();
    const used = usedTokens(walk(srcDir));
    for (const token of [...iconSizeTokens, ...dialogGeometryTokens, ...dimensionTokens]) {
      expect(defined.has(token), `${token} must be defined in styles/*.css`).toBe(true);
      expect(
        used.has(token),
        `${token} must be read via var() somewhere under apps/web/src — a defined-but-unused
         token is exactly the drift this pass exists to close, and the hygiene test above only
         catches the opposite direction (used but never defined)`,
      ).toBe(true);
    }
  });

  it("DirectoryPicker's git-badge icon and its file-list scroll cap read the shared tokens, not a re-inlined literal", () => {
    const text = readFileSync(join(srcDir, 'lib', 'components', 'DirectoryPicker.svelte'), 'utf8');
    expect(text).toContain('size="var(--icon-size-md)"');
    expect(text).toContain('max-height: var(--scroll-cap-height)');
    // The pre-migration literals never come back by hand.
    expect(text).not.toContain('size="0.85em"');
    expect(text).not.toContain('max-height: 12rem');
  });
});
