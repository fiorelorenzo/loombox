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
// Since issue #566 it also emits the Windows/Linux desktop targets:
// `assets/icon.ico` (rasterized PNG sizes packed into one .ico via
// `png-to-ico`, since @resvg/resvg-js only renders PNG), the Linux icon
// set `assets/icons/<N>x<N>.png` electron-builder's linux target reads,
// and the non-template `assets/tray-icon-azure{,@2x}.png` pair `tray.ts`
// picks on anything that isn't darwin (a template image needs OS tinting
// that only macOS provides).
//
// Run with: pnpm --filter @loombox/web exec node scripts/gen-brand-assets.mjs
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = path.join(webDir, 'static');
const iconsDir = path.join(staticDir, 'icons');
const desktopAssetsDir = path.join(webDir, '..', 'desktop', 'assets');
const linuxIconsDir = path.join(desktopAssetsDir, 'icons');
mkdirSync(iconsDir, { recursive: true });
mkdirSync(desktopAssetsDir, { recursive: true });
mkdirSync(linuxIconsDir, { recursive: true });

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
// The single white tile every asset that needs an opaque background sits
// on: the desktop dock icon's squircle (`squircleTileSvg`) and, since
// issue #565, the apple-touch-icon and maskable Android icon too
// (`tiledMarkSvg`) — one tile color across every platform instead of a
// per-target accident. Two things forced an opaque tile in the first
// place, independent of its color: iOS composites a transparent PNG's
// empty pixels as solid black rather than leaving them see-through, and
// the maskable-icon spec (web.dev/articles/maskable-icon) requires an
// opaque image so the OS mask has something to crop. Neither spec ties
// that requirement to a particular color, and the maskable safe zone is
// about keeping real content inside the central 80% circle, not about
// tile contrast, so white doesn't conflict with either — it's a real
// choice, not an oversight.
const TILE_BG = '#ffffff';

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
 * The mark centered on a padded white rounded-square ("squircle") tile —
 * the desktop dock icon's shape (issue #459). Inverted for issue #565:
 * the tile is white and the mark is stroked in `AZURE`, the same as every
 * other azure-on-light asset this script produces, instead of an azure
 * tile with the mark punched out in a near-black contrast ink. Same
 * geometry as before the inversion — only the two fills swapped. Unlike
 * `tiledMarkSvg`, the tile itself is inset from the full canvas (macOS
 * Dock icons all carry this margin so they read as the same visual size
 * next to every other app), and it's radiused rather than square, using
 * the same corner-radius proportion as the mark's own outer frame
 * (`rx="14"` on a 64-wide rect, i.e. ~22% of the tile).
 */
function squircleTileSvg(canvas, { tileFraction = 0.82, markFraction = 0.6 } = {}) {
  const tileSize = canvas * tileFraction;
  const tileOffset = (canvas - tileSize) / 2;
  const cornerRadius = tileSize * (14 / 64);
  const markCanvasSize = tileSize * markFraction;
  const markOffset = (canvas - markCanvasSize) / 2;
  const scale = markCanvasSize / 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <rect x="${tileOffset}" y="${tileOffset}" width="${tileSize}" height="${tileSize}" rx="${cornerRadius}" fill="${TILE_BG}" />
  <g transform="translate(${markOffset} ${markOffset}) scale(${scale})" fill="none" stroke="${AZURE}" stroke-width="3.4" stroke-linecap="round">${MARK_PATHS}</g>
</svg>`;
}

function rasterizeToBuffer(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
}

function rasterize(svg, size, filename, dir = iconsDir) {
  const png = rasterizeToBuffer(svg, size);
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

// 3. apple-touch-icon: opaque white tile, mark filling most of it (iOS
//    rounds the corners itself — no Android-style safe zone needed).
rasterize(tiledMarkSvg(180, 0.82), 180, 'apple-touch-icon-180.png');

// 4. Maskable 512: opaque white tile, mark scaled well inside the ~80%
//    safe-zone circle every Android masking shape (circle/squircle/
//    rounded-square) preserves.
rasterize(tiledMarkSvg(512, 0.625), 512, 'maskable-512.png');

// 5. Desktop dock icon (issue #459): the mark on a padded white squircle
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

// 7. Windows installer/taskbar icon (issue #566). @resvg/resvg-js only
//    renders PNG (see `rasterizeToBuffer` above), so the `.ico` container
//    itself is assembled by `png-to-ico`, a small pure-JS packer (MIT,
//    zero native deps — see `pnpm license:check`) rather than hand-writing
//    the ICO header format. Same squircle tile as the macOS dock icon, at
//    the sizes Windows actually asks a shell icon for.
const WIN_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoBuffer = await pngToIco(
  WIN_ICON_SIZES.map((size) => rasterizeToBuffer(squircleTileSvg(size), size)),
);
writeFileSync(path.join(desktopAssetsDir, 'icon.ico'), icoBuffer);
console.log(
  `wrote apps/desktop/assets/icon.ico (${WIN_ICON_SIZES.join('/')}, ${icoBuffer.length} bytes)`,
);

// 8. Linux icon set (issue #566). electron-builder's linux target reads a
//    directory of pre-rasterized PNGs named by pixel size (`NxN.png`)
//    rather than a single file — same squircle tile again.
for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
  rasterize(squircleTileSvg(size), size, `${size}x${size}.png`, linuxIconsDir);
}

// 9. Colored tray icon for Windows/Linux (issue #566): the same plain
//    transparent mark as the macOS template pair above, stroked in azure
//    instead of black, at the same 22/44 sizes. Windows and a dark Linux
//    panel apply no automatic tinting the way macOS does for a `Template`
//    image, so an untinted template render would sit on the taskbar as a
//    solid black blob — `createTray`'s platform pick (`main/tray.ts`)
//    uses this one on anything that isn't darwin.
for (const [filename, size] of [
  ['tray-icon-azure.png', 22],
  ['tray-icon-azure@2x.png', 44],
]) {
  rasterize(markSvg(AZURE), size, filename, desktopAssetsDir);
}
