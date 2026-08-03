---
'@loombox/web': patch
'@loombox/desktop': patch
---

Invert the dock icon and PWA home-screen icons to a white tile with the azure mark

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
