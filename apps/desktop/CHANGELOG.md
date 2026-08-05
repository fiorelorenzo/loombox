# @loombox/desktop

## 0.2.4

### Patch Changes

- Updated dependencies [35f3924]
  - @loombox/node@0.5.1

## 0.2.3

### Patch Changes

- Updated dependencies [51ef3ac]
- Updated dependencies [a1038bf]
- Updated dependencies [cce97a8]
  - @loombox/node@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [7606627]
- Updated dependencies [ebcf227]
  - @loombox/node@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [535a2ee]
- Updated dependencies [e89b263]
- Updated dependencies [a006a1e]
- Updated dependencies [a3c21b7]
- Updated dependencies [2592c10]
- Updated dependencies [99e3583]
- Updated dependencies [7fc92d2]
- Updated dependencies [344b4c7]
- Updated dependencies [934301d]
- Updated dependencies [e05423a]
- Updated dependencies [635e20d]
  - @loombox/node@0.3.0

## 0.2.0

### Minor Changes

- 3a839c4: Add Windows and Linux electron-builder targets, with icons generated from the same mark

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

### Patch Changes

- 00ca502: Invert the dock icon and PWA home-screen icons to a white tile with the azure mark

  `squircleTileSvg` (`apps/web/scripts/gen-brand-assets.mjs`) drew an azure tile
  with the mark punched out in near-black `ACCENT_CONTRAST`. That read wrong in
  the Dock: the mark disappeared into the fill instead of standing on it.

  The tile is now white and the mark is stroked in the existing `AZURE` token
  (`#3b9df7`), same geometry, padding and corner radius, just the two fills
  swapped. `TILE_BG` moved from the old dark `#0b0d10` to `#ffffff` and is now
  shared by `apple-touch-icon-180.png` and `maskable-512.png` too, so the app
  icon is the same object on macOS, iOS and Android instead of a per-target
  accident. The maskable-icon spec only requires an opaque background, not a
  particular color, and its safe zone is about content placement, not
  contrast, so nothing in the spec pushed back on white.

  The menu-bar tray icons (`tray-iconTemplate.png`, `tray-iconTemplate@2x.png`)
  are untouched: they stay alpha-only template images tinted by macOS, and a
  colored tile there would render as an opaque blob.

- Updated dependencies [c907512]
- Updated dependencies [ac64679]
- Updated dependencies [aad37f8]
- Updated dependencies [804933f]
- Updated dependencies [fa0dbd1]
- Updated dependencies [a449b22]
  - @loombox/node@0.2.0

## 0.1.0

### Minor Changes

- 9eff82e: Make the desktop shell's dev-server override actually work, and unbreak `vite dev`. `resolvePwaUrl` now accepts a `--pwa-url=<url>` argv flag (which `open --args` delivers) instead of relying only on `LOOMBOX_DESKTOP_PWA_URL`, which a LaunchServices-started app on macOS 26 never inherits from `launchctl setenv` — so `scripts/mac-desktop.sh`'s documented `PWA_URL=` override silently loaded production. Separately, `@xterm/xterm` is now SSR-bundled: as an external CommonJS dep its named `Terminal` import made `vite dev` 500 on every page.

### Patch Changes

- Updated dependencies [c0d6291]
- Updated dependencies [4f7dcd4]
- Updated dependencies [c86aa72]
- Updated dependencies [10df3db]
- Updated dependencies [8f305d0]
- Updated dependencies [3705e0b]
- Updated dependencies [fcb76fc]
  - @loombox/node@0.1.0
