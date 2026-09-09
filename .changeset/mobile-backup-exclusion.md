---
'@loombox/mobile': minor
---

Closes issue #950, filed by #281's Capacitor spike. The AMK (and, it turns out, the Better Auth session token — see `auth-store.ts`) live in the WebView's `localStorage`, and both platforms back that up to the cloud by default: Android's Auto Backup includes the app's private data directory, iOS's iCloud/iTunes backups include everything under `Library`. That is a direct hole in SPEC §8's "the AMK is device-held" premise the moment the real v3 mobile phase wires `loadOrCreateAmk` into the wrapped app.

Fixed at the directory level, not per-key, so it covers everything the WebView persists (AMK, auth session, the IndexedDB offline outbox), not just the one secret this issue named:

- Android: `android:fullBackupContent` (API ≤30) and `android:dataExtractionRules` (API 31+, this app targets 36) both exclude `app_webview/` — the WebView's storage directory, a sibling of `files/`/`databases/` at the app's private-storage root — from cloud backup and device-transfer alike (developer.android.com/identity/data/autobackup).
- iOS: `AppDelegate.swift` marks `Library/WebKit` (where WKWebView's storage lives) excluded from backup via `NSURLIsExcludedFromBackupKey`, reapplied on every foreground transition since the directory does not exist before first WKWebView init and Apple's own docs warn the flag can be reset by later file operations (developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey).

Both edits are applied by a new `scripts/patch-native-backup-exclusion.mjs`, wired as Capacitor's documented `capacitor:update:after` CLI hook, so the exclusion survives every `cap add`/`cap update`/`cap sync` even though `android/`/`ios/` stay gitignored generated output. `src/backup-exclusion.test.ts` asserts the patch against fixtures captured from a real `cap add android`/`cap add ios` run.
