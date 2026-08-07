---
'@loombox/desktop': minor
---

Side-by-side production/preview desktop installs (issue #866, epic #863)

One `electron-builder.ts` config, parameterised by `LOOMBOX_DESKTOP_ENV` (`production`, the default, or `preview`), produces two distinct artifacts instead of a forked config that would drift.

- `src/main/environment.ts` is the single table every value that has to differ lives in: `appId` (`com.loombox.desktop` vs `com.loombox.desktop.preview`), `productName` (`loombox` vs `loombox Preview` — dock, menu bar, window title, tray tooltip and menu items), the `userData` directory name (`loombox` vs `loombox-preview`, set explicitly via `app.setPath('userData', …)` rather than left to Electron's own productName-derived default, which doesn't vary in dev), the deep-link scheme (`loombox` vs `loombox-preview`, registered via `electron-builder.ts`'s `protocols` and `app.setAsDefaultProtocolClient`), and the default PWA origin (`app.loombox.dev` vs `preview.loombox.dev`).
- `src/main/chrome-badge.ts` + `src/main/window.ts`: a preview-only ribbon stamped onto the loaded page from the main process on every real navigation, independent of the PWA's own content — the "obvious at a glance" marker beyond the title bar.
- `electron-builder.ts` also sets `executableName` explicitly (electron-builder's own Linux default comes from `package.json`'s `name` field, not `productName`) and a per-environment `directories.output` (`release/production/` vs `release/preview/`) so packaging both from one checkout never has the second run's staging directory clobber the first's.
- `apps/desktop/package.json` gains `dev:preview` and `package:{mac,linux,win}:preview` scripts, each just the existing script with `LOOMBOX_DESKTOP_ENV=preview` — every existing invocation is unchanged and still builds production.

`preview.loombox.dev` does not resolve yet (#865 builds the preview web deployment); pointing a preview build's default at it now is still correct.

Verified: `pnpm --filter @loombox/desktop exec vitest run` (12 files, 64 passed — `environment.test.ts` and `chrome-badge.test.ts` are new, `config.test.ts` gained preview-URL cases), `pnpm --filter @loombox/desktop typecheck` (0 errors, now also covering `electron-builder.ts`), `pnpm exec eslint` on every changed file (clean), full `pnpm format:check` (clean). A real `electron-builder --linux --dir` dry run ran for both `LOOMBOX_DESKTOP_ENV` values on this devbox: `electron-builder.ts` loads through electron-builder's own config loader (not just this package's test harness) and produced two independently populated trees, `release/production/linux-unpacked/loombox` and `release/preview/linux-unpacked/loombox-preview`.

Not verified here, and cannot be from this headless Linux devbox: both `.app`s actually installed and launched side by side on a real Mac, each with its own Dock entry; signing into one and confirming the other's `localStorage`/AMK stays untouched; a `loombox://…` link opening production and a `loombox-preview://…` link opening preview. Needs `pnpm run package:mac` / `package:mac:preview` and `scripts/mac-desktop.sh` on the real Mac.
