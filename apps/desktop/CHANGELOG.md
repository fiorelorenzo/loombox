# @loombox/desktop

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
