---
'@loombox/desktop': minor
'@loombox/web': patch
---

Add Windows and Linux electron-builder targets, with icons generated from the same mark

`apps/desktop/electron-builder.yml` gets a `win` block (NSIS installer plus a portable
build, `assets/icon.ico`) and a `linux` block (AppImage plus deb, `category:
Development`, `assets/icons`), alongside the existing `mac` block. `package:win` and
`package:linux` join `package:mac` in `apps/desktop/package.json`.

Every new icon is generated, not drawn: `gen-brand-assets.mjs` now also emits
`assets/icon.ico` (rasterized PNG sizes packed into one `.ico` via `png-to-ico`, since
`@resvg/resvg-js` only renders PNG), the Linux icon set `assets/icons/<N>x<N>.png`
electron-builder's linux target reads, and a colored (azure) tray glyph pair
(`assets/tray-icon-azure{,@2x}.png`) alongside the existing macOS template pair. The
template PNGs themselves are untouched.

`createTray`'s call site (`src/main/index.ts`) now picks the platform-appropriate tray
icon via a new pure `pickTrayIconPath` (`src/main/tray-icon.ts`): the macOS `Template`
image on darwin, which the OS tints itself, and the colored render everywhere else,
since Windows and a dark Linux panel apply no tinting at all.

CI coverage for all three platforms is a follow-up (#567).
