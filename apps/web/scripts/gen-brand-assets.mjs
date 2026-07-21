// Generates loombox's real favicon/PWA icon assets from the single locked
// "Warp & Weft" mark (issue #194, SPEC.md §4's logo — a 2x2 plain weave
// inside a rounded-square frame). Every pixel is rasterized by resvg from
// the exact vector paths defined below, at each target's real size —
// nothing here is hand-drawn or faked (replaces the old zero-dependency
// placeholder generator, `gen-icons.mjs`, now that a real brand mark
// exists to bake in).
//
// Run with: pnpm --filter @loombox/web exec node scripts/gen-brand-assets.mjs
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const iconsDir = path.join(staticDir, 'icons');
mkdirSync(iconsDir, { recursive: true });

// The exact locked geometry from issue #194 — do not redraw. Mirrors
// `$lib/components/BrandMark.svelte`'s inline SVG, which uses
// `stroke="currentColor"` instead of a baked color since it lives in the
// themed app UI; these static assets need a literal color because a
// `<link rel="icon">`/manifest icon has no CSS custom properties to read.
const MARK_PATHS = `
  <rect x="8" y="8" width="48" height="48" rx="14" stroke-width="3.2" />
  <path d="M24 16 V36" /><path d="M24 44 V48" />
  <path d="M40 16 V20" /><path d="M40 28 V48" />
  <path d="M16 24 H20" /><path d="M28 24 H48" />
  <path d="M16 40 H36" /><path d="M44 40 H48" />
`;

// The default accent (#376) — the one color these static, pre-JS assets
// bake in, since none of them can read the runtime accent-theming system.
const AZURE = '#3b9df7';
// `tokens.css`'s dark `--color-bg` — the tile color behind the mark
// wherever a raster asset needs an opaque background (Android maskable
// icons *require* one to survive OS masking; the apple-touch-icon uses the
// same tile by the same reasoning: iOS composites a transparent PNG's
// empty pixels as solid black rather than leaving them see-through, so an
// explicit dark tile reads intentional instead of like a rendering bug).
const TILE_BG = '#0b0d10';

/** The bare mark, transparent background, at its native 64x64 viewBox. */
function markSvg(strokeColor) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="${strokeColor}" stroke-width="3.4" stroke-linecap="round">${MARK_PATHS}</svg>`;
}

/**
 * The mark centered on a solid `canvas`x`canvas` tile, scaled so its
 * outer footprint is `markFraction` of the tile — used for both the
 * apple-touch-icon (avoid transparent-renders-as-black) and the maskable
 * icon (Android crops to a circle/rounded-square/squircle depending on the
 * launcher, so real content must stay inside a safe zone well short of the
 * full canvas).
 */
function tiledMarkSvg(canvas, markFraction) {
  const markCanvasSize = canvas * markFraction;
  const offset = (canvas - markCanvasSize) / 2;
  const scale = markCanvasSize / 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <rect width="${canvas}" height="${canvas}" fill="${TILE_BG}" />
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${AZURE}" stroke-width="3.4" stroke-linecap="round">${MARK_PATHS}</g>
</svg>`;
}

function rasterize(svg, size, filename) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  writeFileSync(path.join(iconsDir, filename), png);
  console.log(`wrote static/icons/${filename} (${size}x${size}, ${png.length} bytes)`);
}

// 1. The favicon SVG itself — modern browsers render this directly at any
//    size, no rasterization needed. Transparent background, azure mark.
const faviconSvg = markSvg(AZURE);
writeFileSync(path.join(staticDir, 'favicon.svg'), faviconSvg);
console.log(`wrote static/favicon.svg (${faviconSvg.length} bytes)`);

// 2. Raster fallbacks + PWA icons: the plain transparent mark, azure.
for (const [filename, size] of [
  ['favicon-16.png', 16],
  ['favicon-32.png', 32],
  ['pwa-192.png', 192],
  ['pwa-512.png', 512],
]) {
  rasterize(markSvg(AZURE), size, filename);
}

// 3. apple-touch-icon: opaque dark tile, mark filling most of it (iOS
//    rounds the corners itself — no Android-style safe zone needed).
rasterize(tiledMarkSvg(180, 0.82), 180, 'apple-touch-icon-180.png');

// 4. Maskable 512: opaque dark tile, mark scaled well inside the ~80%
//    safe-zone circle every Android masking shape (circle/squircle/
//    rounded-square) preserves.
rasterize(tiledMarkSvg(512, 0.625), 512, 'maskable-512.png');
