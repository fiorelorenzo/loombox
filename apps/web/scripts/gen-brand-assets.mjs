// Generates loombox's real favicon/PWA icon assets from the single locked
// "Warp & Weft" mark (issue #194, SPEC.md §4's logo — a 2x2 plain weave
// inside a rounded-square frame). Every pixel is rasterized by resvg from
// the exact vector paths defined below, at each target's real size —
// nothing here is hand-drawn or faked (replaces the old zero-dependency
// placeholder generator, `gen-icons.mjs`, now that a real brand mark
// exists to bake in).
//
// Since issue #459 this script covers BOTH apps: `apps/web/static/icons`
// (favicon/PWA) AND `apps/desktop/assets` (dock icon + menu-bar tray
// icons) — both are rasterized from the exact same `MARK_PATHS` constant,
// so nobody should add a second, hand-drawn desktop asset pipeline later.
//
// Run with: pnpm --filter @loombox/web exec node scripts/gen-brand-assets.mjs
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = path.join(webDir, 'static');
const iconsDir = path.join(staticDir, 'icons');
const desktopAssetsDir = path.join(webDir, '..', 'desktop', 'assets');
mkdirSync(iconsDir, { recursive: true });
mkdirSync(desktopAssetsDir, { recursive: true });

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
// `tokens.css`'s `--color-accent-contrast` — the AA-correct ink for content
// drawn on top of the azure accent itself (as opposed to azure-on-dark
// everywhere else in this file). The desktop dock icon (issue #459) draws
// the mark ON an azure tile rather than beside one, so it needs this
// contrast color instead of AZURE/TILE_BG.
const ACCENT_CONTRAST = '#0a0a0a';

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

/**
 * The mark centered on a padded azure rounded-square ("squircle") tile —
 * the desktop dock icon's shape (issue #459). Unlike `tiledMarkSvg`, the
 * tile itself is inset from the full canvas (macOS Dock icons all carry
 * this margin so they read as the same visual size next to every other
 * app), and it's radiused rather than square, using the same corner-radius
 * proportion as the mark's own outer frame (`rx="14"` on a 64-wide rect,
 * i.e. ~22% of the tile). The mark is drawn in `ACCENT_CONTRAST`, not
 * `AZURE`, since it now sits ON the accent color instead of beside it.
 */
function squircleTileSvg(canvas, { tileFraction = 0.82, markFraction = 0.6 } = {}) {
  const tileSize = canvas * tileFraction;
  const tileOffset = (canvas - tileSize) / 2;
  const cornerRadius = tileSize * (14 / 64);
  const markCanvasSize = tileSize * markFraction;
  const markOffset = (canvas - markCanvasSize) / 2;
  const scale = markCanvasSize / 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <rect x="${tileOffset}" y="${tileOffset}" width="${tileSize}" height="${tileSize}" rx="${cornerRadius}" fill="${AZURE}" />
  <g transform="translate(${markOffset} ${markOffset}) scale(${scale})" fill="none" stroke="${ACCENT_CONTRAST}" stroke-width="3.4" stroke-linecap="round">${MARK_PATHS}</g>
</svg>`;
}

function rasterize(svg, size, filename, dir = iconsDir) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  writeFileSync(path.join(dir, filename), png);
  console.log(
    `wrote ${path.relative(webDir, path.join(dir, filename))} (${size}x${size}, ${png.length} bytes)`,
  );
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

// 5. Desktop dock icon (issue #459): the mark on a padded azure squircle
//    tile, at the 1024x1024 electron-builder/`app.dock.setIcon` expects.
rasterize(squircleTileSvg(1024), 1024, 'icon.png', desktopAssetsDir);

// 6. Desktop tray ("menu bar") icons (issue #459). The `Template` filename
//    suffix tells macOS to treat this as a template image: ignore its
//    actual color and use only the alpha channel as a mask it tints
//    automatically for the light/dark menu bar — so, unlike every asset
//    above, this one must stay a plain transparent mark with NO azure tile
//    (a colored background would just show through as an opaque blob).
//    22px is the native macOS menu-bar glyph size; the `@2x` sibling is
//    Electron's own HiDPI convention (same name, `@2x` suffix, auto-paired).
for (const [filename, size] of [
  ['tray-iconTemplate.png', 22],
  ['tray-iconTemplate@2x.png', 44],
]) {
  rasterize(markSvg('#000000'), size, filename, desktopAssetsDir);
}
