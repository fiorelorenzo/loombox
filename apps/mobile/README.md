# @loombox/mobile

The native mobile wrapper (issue #283, epic #34's "native mobile" build order): the same
SvelteKit PWA `apps/web` ships, wrapped with [Capacitor](https://capacitorjs.com) for iOS
and Android, no Expo, no React Native, no code fork (AGENTS.md's layout section, SPEC
§10/§10.1).

This package started as issue #281's spike scaffold — see
`docs/superpowers/specs/2026-08-08-capacitor-mobile-spike.md` for the full build/runtime
evidence trail (real `cap add android`/`cap add ios` runs, a live iOS simulator boot with
a screenshot-verified `crypto.subtle`/secure-context/WebSocket round trip). This PR (#283)
adds the build/sign/release pipeline on top of that scaffold: CI, signing wiring, version
plumbing, and a documented (not stubbed) store submission path.

## What apps/mobile actually wraps today

`webDir` (`www/`) is still `src/diagnostics.ts`'s runtime probe page, bundled by
`scripts/build-www.mjs`, **not the real PWA**. The spike doc's "The webDir problem"
section found the real blocker: `apps/web` ships `@sveltejs/adapter-node` (it needs a live
Node process behind it on prodbox), which writes no static `index.html` for Capacitor's
`webDir` to bundle. Swapping in a static-SPA build target for the real PWA is real
per-package build-config surgery the spike deliberately left out of its own scope, and this
PR doesn't do it either — it's orthogonal to the build/sign/release pipeline this issue
asks for, and doing it here would be a second undiscussed decision riding along on this
one. The pipeline below builds and signs _whatever_ `www/` currently is; swapping the
diagnostics stand-in for the real PWA build is a separate, future change that this
pipeline does not need to know about.

## Building locally

```bash
pnpm install                                    # from the repo root
pnpm --filter @loombox/mobile run build          # bundles www/diagnostics.js
pnpm --filter @loombox/mobile run cap:add:android  # generates android/ (gitignored)
pnpm --filter @loombox/mobile run cap:add:ios      # generates ios/ (gitignored, macOS/Xcode only)
```

`android/` and `ios/` are both fully gitignored (`.gitignore`'s own comment) — nothing in
either tree is hand-edited, so regenerating them with `cap add` loses nothing, and every
Capacitor-hardcoded field (versionCode, versionName, MARKETING_VERSION,
CURRENT_PROJECT_VERSION) gets patched back in on every run by the scripts below rather than
committed once.

Android needs **JDK 21** (Capacitor 8.5.0's Android Gradle Plugin requirement, issue #951,
fixed separately) — `apps/mobile/.mise.toml` pins it for anyone running `mise`-activated
shells from inside this directory; CI pins it directly via `actions/setup-java` below,
independent of that file. Building `android/` from a fresh checkout:

```bash
cd apps/mobile/android && ./gradlew assembleDebug   # unsigned debug APK, no secrets needed
```

Building `ios/` needs a Mac with Xcode — this devbox is Linux and cannot run it; see
"What CI actually builds" below for the exact commands, verified for real on the team's Mac
during the #281 spike.

## What CI actually builds (`.github/workflows/ci.yml`'s `mobile` job)

**Both platforms, up through an unsigned artifact, on every push to `main` and every PR
that touches `apps/mobile/`:**

- **Android** (`ubuntu-latest`): `cap add android` + `./gradlew assembleDebug`. Produces a
  real, installable, unsigned debug APK — Android's own default debug-keystore signing,
  not a store-ready artifact. No secret required or read.
- **iOS** (`macos-latest`): `cap add ios` + `xcodebuild … -sdk iphonesimulator
CODE_SIGNING_ALLOWED=NO build`, the exact command the #281 spike ran for real (see the
  spike doc). A simulator build needs no signing identity at all — this is "as far as
  credentials allow" on the free/CI-available path; a real device or App Store archive
  needs Lorenzo's Apple Developer certificate (below).

Neither leg attempts to sign or submit anything. That's `release-mobile.yml`'s job, and
only once the secrets below exist.

## Signing and store submission (`.github/workflows/release-mobile.yml`)

Triggered the same way `release-desktop.yml` is: on the `@loombox/mobile@<version>`
GitHub Release tag Changesets already creates for this package's version bump (below), or
`workflow_dispatch` as a manual fallback. **Never a bare `v*` tag** — that's
`scripts/deploy-prod.sh`'s unrelated prod-deploy sequence; issue #924 found a real
tag-collision bug from exactly this mistake in the desktop updater, so this workflow reuses
Changesets' own tag shape on purpose, the same way `apps/desktop/electron-builder.ts`'s
`publish.tagNamePrefix` does.

Every credential-driven step is gated by `apps/mobile/scripts/check-secrets.mjs`
(`lib/secret-gates.mjs` is the single source of truth for which secrets each gate needs),
which fails with the exact list of missing GitHub secret names before touching
Gradle/xcodebuild/an upload API — never a cryptic tool-specific failure two steps in, and
never a silent unsigned artifact passed off as a real release.

**As of this PR, none of the secrets below are configured**, so every run of
`release-mobile.yml` builds successfully and then stops, loudly, at the first signing
step. That is the honest, current state — not a placeholder for a "real" pipeline to
replace later; this is the same shape `release-desktop.yml`/`scripts/release-desktop.sh`
already ship in this repo for the desktop shell's own Apple-certificate-gated steps.

### Android: build → sign → submit

1. `patch-android-project.mjs` sets `versionCode`/`versionName` from this release's own
   `apps/mobile/package.json` version (below).
2. `check-secrets.mjs android-signing` gates on `ANDROID_KEYSTORE_BASE64` /
   `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`.
3. `sign-android.mjs` decodes the keystore and wires a `signingConfigs.release` block into
   the generated `build.gradle` (passwords are read by Gradle itself from the environment
   at build time, never written into the file). **Verified for real on this devbox**: a
   throwaway self-signed keystore, the full missing-secret and present-secret code paths,
   and a real `./gradlew bundleRelease` producing a signed `.aab` — see this PR's
   description for the transcript.
4. `./gradlew bundleRelease assembleRelease` produces the signed `.aab` (Play Console) and
   `.apk` (direct install/sideload), uploaded to the GitHub Release.
5. `check-secrets.mjs play-submission` gates on `PLAY_SERVICE_ACCOUNT_JSON_BASE64`, then
   [`r0adkll/upload-google-play`](https://github.com/r0adkll/upload-google-play) submits
   the `.aab` to the **internal testing track** — the standard first destination, well
   short of a public release, which stays Lorenzo's own manual step from the Play Console.
   **Unverified**: no Play Console account or service account exists yet.

### iOS: build → sign → submit

1. `patch-ios-project.mjs` sets `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` the same way,
   from the same source. **Unverified on this box** (no Xcode/macOS here) — written against
   Capacitor's documented default project layout and Apple's own versioning docs; the
   `release-mobile.yml` ios job is where this can actually be exercised for the first time,
   on GitHub's `macos-latest`.
2. `check-secrets.mjs ios-signing` gates on `APPLE_TEAM_ID` / `IOS_DIST_CERTIFICATE_BASE64`
   / `IOS_DIST_CERTIFICATE_PASSWORD` / `IOS_PROVISIONING_PROFILE_BASE64`.
3. The workflow imports the certificate and provisioning profile into a dedicated temporary
   keychain (Apple's own documented non-interactive codesigning recipe) and runs
   `xcodebuild archive` + `-exportArchive` (method `app-store-connect`) to produce a signed
   `.ipa`, uploaded to the GitHub Release.
4. `check-secrets.mjs app-store-submission` gates on `APP_STORE_CONNECT_KEY_ID` /
   `APP_STORE_CONNECT_ISSUER_ID` / `APP_STORE_CONNECT_API_KEY_BASE64` /
   `APP_STORE_CONNECT_APPLE_ID` / `APP_STORE_CONNECT_ASC_PUBLIC_ID`, then
   `xcrun altool --upload-package` submits to App Store Connect. `--upload-package` (not
   the deprecated `--upload-app`) was confirmed against Apple's own current `altool`
   documentation before writing this step, not assumed.

**Everything in this section past step 1 of each platform is unverified on real
infrastructure** — this devbox has no Xcode, no Google Play account, and no Apple Developer
account, and none of the secrets exist yet to exercise the signed path even where the
tooling (Gradle) is available here. The Android _signing mechanism itself_ (steps 2–3, the
part this box can actually run) is verified for real, per above; submission (step 5) and
the entire iOS chain are written from each tool's own current documentation, matching this
repo's existing standard of grounding a mechanism in something real before shipping it, but
have never produced a real accepted upload.

## Versioning (Changesets)

`@loombox/mobile` versions and tags exactly like every other package in this monorepo —
`.changeset/config.json`'s `ignore` array is empty (CONTRIBUTING.md's "Releases" section
explains why it stays that way), so there is nothing extra to wire for issue #283's
"Changesets covers apps/mobile version bumps" acceptance item. A changeset that touches
`apps/mobile` bumps `apps/mobile/package.json`'s version, writes its `CHANGELOG.md`, and
tags/releases it as `@loombox/mobile@<version>` the same way `@loombox/web`/`@loombox/desktop`/
etc. already do.

What's new here is translating that semver into what each store's native versioning field
needs: `scripts/lib/native-version.mjs`'s `deriveNativeVersion` packs
`major*1_000_000 + minor*1_000 + patch` into a single positive integer (Android's
`versionCode`, iOS's `CURRENT_PROJECT_VERSION`) that preserves semver's own ordering as
long as minor/patch stay under 1000 — checked explicitly against this repo's real tag
history (`git tag -l '@loombox/web@*'`, the most active package, sits at minor 9), the same
"verify the scheme against real data" discipline issue #924 used to catch a real
tag-collision bug in the desktop updater. `apps/mobile/package.json` sits at `0.0.0` until
its first changeset lands, which is why `deriveNativeVersion('0.0.0')` deliberately throws
rather than emitting a versionCode of 0 no store would accept.

## What Lorenzo has to obtain

None of this exists today, for the first real store submission. This is the complete list `release-mobile.yml` is gated on:

**Android / Google Play:**

- A **Google Play Console developer account** ($25 one-time registration fee) and an app
  record created there for `dev.loombox.app`.
- A **release signing keystore** (`keytool -genkeypair -keyalg RSA -keysize 2048 -validity
10000 …`, kept somewhere durable and backed up — losing it means never being able to
  update the app under the same identity again) → base64-encode it into the
  `ANDROID_KEYSTORE_BASE64` GitHub secret, plus `ANDROID_KEYSTORE_PASSWORD` /
  `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`.
- A **Google Play Developer API service account** (Play Console → Setup → API access →
  create a service account in Google Cloud, grant it release-manager access to the app) →
  its JSON key, base64-encoded, as `PLAY_SERVICE_ACCOUNT_JSON_BASE64`.

**iOS / App Store:**

- An **Apple Developer Program membership** ($99/year).
- A **Distribution certificate** (created in Apple Developer → Certificates) exported as a
  `.p12` → base64-encoded as `IOS_DIST_CERTIFICATE_BASE64`, plus its export password as
  `IOS_DIST_CERTIFICATE_PASSWORD`.
- An **App Store provisioning profile** for `dev.loombox.app` (Apple Developer →
  Profiles) → base64-encoded as `IOS_PROVISIONING_PROFILE_BASE64`.
- The **Apple Team ID** (Apple Developer → Membership) as `APPLE_TEAM_ID`.
- An **App Store Connect API key** (App Store Connect → Users and Access → Keys, "App
  Manager" role or higher) → its `.p8`, base64-encoded, as `APP_STORE_CONNECT_API_KEY_BASE64`,
  plus its Key ID (`APP_STORE_CONNECT_KEY_ID`) and Issuer ID
  (`APP_STORE_CONNECT_ISSUER_ID`).
- Once an app record for `dev.loombox.app` exists in App Store Connect: its numeric **Apple
  ID** (`APP_STORE_CONNECT_APPLE_ID`) and **ASC public ID**
  (`APP_STORE_CONNECT_ASC_PUBLIC_ID`), both visible on the app's own App Store Connect page
  — these can only be looked up after the app record itself exists, which is why they are
  separate secrets from the API key above rather than derivable from anything in this repo.

Every one of the fourteen secrets above is read only from `secrets.*` in
`release-mobile.yml`; none of them, or anything that could stand in for them, exists in
this repository.
