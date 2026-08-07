// electron-builder config (issue #403, Windows/Linux targets added by
// #566, environment parameterization by issue #866/epic #863). A `.ts`
// config rather than `.yml`: electron-builder loads it directly (its own
// bundled `jiti` — `app-builder-lib`'s `util/config/load.js` tries
// `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` in that order,
// no separate compile step needed, matching this repo's raw-TS-everywhere
// convention), and a function is the only way to compute the handful of
// fields that have to differ between a production and a preview build
// without hand-duplicating this whole file and letting the copies drift —
// see `./src/main/environment.ts`'s doc comment for the failure mode that
// duplication produces. `LOOMBOX_DESKTOP_ENV` (unset -> production) picks
// which side of `./src/main/environment.ts`'s table this build resolves;
// `package.json`'s `package:*:preview` scripts set it, `package:*` doesn't
// (so every existing production build invocation is unchanged).
//
// macOS signing/notarization need Lorenzo's Apple Developer certificate and
// only ever run on his Mac; Linux builds right here on this headless devbox
// (no display needed to *produce* an AppImage/deb, only to run one — see
// README.md); Windows needs CI or a Windows box (the CI matrix job is
// #567). See README.md's "Building for macOS, Linux, and Windows" for the
// full breakdown.
import type { Configuration } from 'electron-builder';

import { resolveDesktopEnvironmentConfig } from './src/main/environment';

const desktopEnv = resolveDesktopEnvironmentConfig();

const config: Configuration = {
  appId: desktopEnv.appId,
  productName: desktopEnv.productName,
  // Electron-builder's own default for the packaged executable's filename
  // is not `productName` — it's `package.json`'s (scoped) `name` field
  // sanitized (`@loombox/desktop` -> `@loomboxdesktop`), identical for both
  // environments since that field never changes. Set explicitly so the
  // process a `ps`/Activity Monitor/taskbar entry shows differs too — the
  // same slug as `userDataDirName` below, already the app's own
  // environment-scoped identity string.
  executableName: desktopEnv.userDataDirName,
  // electron-builder's own automatic pre-package `@electron/rebuild` step
  // ignores pnpm-workspace.yaml's `allowBuilds` and tries to rebuild every
  // native module it finds a `binding.gyp` for, including `cpu-features`
  // (an optional ssh2 accelerator this repo deliberately never builds — see
  // `pnpm-workspace.yaml`'s comment) — this devbox's node-gyp/gyp toolchain
  // can't build it (`buildcheck.gypi not found`) and doesn't need to.
  // `node-pty`'s real rebuild against Electron's ABI (the actual
  // functional need, see README.md's "native-module rebuild caveat") is
  // still a manual, not-yet-wired step done separately, not by this flag.
  npmRebuild: false,
  // Issue #657: the electron-updater feed. GitHub Releases, since #567's
  // CI already validates every platform builds and the release flow
  // (`.github/workflows/release.yml`) already creates a GitHub Release on
  // every version bump — this just gives it artifacts to attach (see
  // `scripts/release-desktop.sh` and `.github/workflows/release-
  // desktop.yml`). `channel` keeps production and preview from ever
  // offering each other's build: a preview install auto-updating to a
  // production artifact (or vice versa) is exactly the cross-
  // contamination issue #866 already guards `userData`/`appId`/the
  // deep-link scheme against, and electron-updater's own channel
  // mechanism (a separate `<channel>-<platform>.yml` manifest alongside
  // the default `latest*.yml`) is what keeps two builds on the same
  // GitHub Releases repo apart. Production stays on electron-updater's
  // own default channel name ('latest'), so an existing production
  // install's update check is unchanged by this issue.
  publish: {
    provider: 'github',
    owner: 'fiorelorenzo',
    repo: 'loombox',
    channel: desktopEnv.environment === 'preview' ? 'preview' : 'latest',
  },
  directories: {
    // Separate output trees per environment: electron-builder's own
    // intermediate staging directories under `output` (e.g. `mac/`,
    // `linux-unpacked/`) use fixed names regardless of `productName`, so
    // packaging both environments from the same checkout without this would
    // have the second build's staging clobber the first's mid-package, not
    // just collide on the final artifact's filename.
    output: `release/${desktopEnv.environment}`,
  },
  // This package ships raw TypeScript run through `tsx` at runtime (see
  // `src/main/bootstrap.cjs`'s doc comment — the same "no compiled dist"
  // convention every package in this monorepo follows), so the packaged app
  // needs its `src/` and `node_modules/` (which is where `tsx` and every
  // `@loombox/*` workspace package's own raw source live) — not a `dist/`.
  files: [
    '**/*',
    '!*.md',
    '!*.test.ts',
    '!tsconfig*.json',
    '!vitest.config.ts',
    '!electron-builder.ts',
    '!release/**',
  ],
  extraResources: [{ from: 'assets', to: 'assets' }],
  // Two installs claiming the same deep-link scheme is undefined behaviour
  // — the OS picks one, silently, and it need not be the one the link was
  // meant for (issue #866). Applies to every platform below (mac's
  // `CFBundleURLTypes`, Windows' registry, Linux's desktop-file
  // `MimeType`) since it's set at the root rather than per-platform.
  protocols: {
    name: `${desktopEnv.productName} deep link`,
    schemes: [desktopEnv.protocolScheme],
  },
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'assets/icon.png',
    target: [
      { target: 'dmg', arch: 'universal' },
      { target: 'zip', arch: 'universal' },
    ],
    // Signing/notarization need Lorenzo's Apple Developer certificate and are
    // NOT configured here — electron-builder auto-discovers a keychain
    // identity by default (`CSC_IDENTITY_AUTO_DISCOVERY`), and notarization
    // needs APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID (or an
    // API-key equivalent) set as env vars on the Mac before `pnpm run
    // package:mac` — see README.md.
    hardenedRuntime: true,
    gatekeeperAssess: false,
  },
  dmg: {
    sign: false,
  },
  win: {
    icon: 'assets/icon.ico',
    target: [{ target: 'nsis' }, { target: 'portable' }],
  },
  linux: {
    icon: 'assets/icons',
    category: 'Development',
    target: [{ target: 'AppImage' }, { target: 'deb' }],
  },
};

export default config;
