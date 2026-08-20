// Issue #950 — pure string-patch functions for excluding the WebView's
// persistent storage (localStorage/IndexedDB, which holds the AMK — see
// apps/web/src/lib/amk-store.ts) from each platform's OS-level app-data
// backup. No file I/O here on purpose: `scripts/patch-native-backup-exclusion.mjs`
// is the CLI wrapper Capacitor's hooks invoke against the real generated
// tree, and `src/backup-exclusion.test.ts` exercises these same functions
// against fixtures captured from a real `cap add android`/`cap add ios` run,
// so the assertions hold even on a box that can't build either native project.
//
// Both platforms' own docs:
// - Android: https://developer.android.com/identity/data/autobackup
//   WebView's storage sits in `app_webview/`, a sibling of `files/` at the
//   app's private-storage root (domain="root" in the rules schema below),
//   not inside `getFilesDir()` (domain="file"). Apps targeting API 31+
//   (this app targets 36, confirmed by `aapt dump badging` in the #281
//   spike) use `android:dataExtractionRules`; `android:fullBackupContent`
//   remains the mechanism for API ≤30. Both are wired so every supported
//   device is covered, not just current ones.
// - iOS: https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey
//   Everything under `Library` (besides `Caches`/`tmp`) is included in
//   iCloud/iTunes backups by default; WKWebView's storage lives under
//   `Library/WebKit` (Apple Developer Forums thread 741976 shows the
//   concrete `Library/WebKit/WebsiteData/IndexedDB/v0` path for a live
//   error), so that whole directory is what needs the exclusion attribute.

const ANDROID_MANIFEST_MARKER = 'android:fullBackupContent="@xml/backup_rules"';

/**
 * Adds `android:fullBackupContent` (API ≤30) and `android:dataExtractionRules`
 * (API 31+) to the generated `<application>` element. Idempotent: re-running
 * against an already-patched manifest is a no-op, since `cap sync`/`cap
 * update` re-run the owning hook every time, not just on first `cap add`.
 */
export function patchAndroidManifest(manifestXml) {
  if (manifestXml.includes(ANDROID_MANIFEST_MARKER)) {
    return manifestXml;
  }
  if (!/<application\b/.test(manifestXml)) {
    throw new Error(
      "patchAndroidManifest: no <application> element found — cap add android's " +
        'generated AndroidManifest.xml shape has changed, update this patch (issue #950)',
    );
  }
  return manifestXml.replace(
    /<application\b/,
    `<application\n        android:fullBackupContent="@xml/backup_rules"\n        android:dataExtractionRules="@xml/backup_rules_api31"`,
  );
}

/** API ≤30 backup rules (`android:fullBackupContent`). */
export function androidBackupRulesXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  Issue #950: WebView localStorage/IndexedDB (including the AMK — see
  apps/web/src/lib/amk-store.ts) lives under app_webview/, a sibling of
  files/ and databases/ at the app's private-storage root, not inside
  getFilesDir(). Auto Backup includes it by default when android:allowBackup
  is true (developer.android.com/identity/data/autobackup#Files); excluded
  explicitly here rather than via allowBackup=false, so any future
  non-WebView app-private data still gets convenience-restore.

  This file is the API ≤30 rule format. See backup_rules_api31.xml for the
  android:dataExtractionRules equivalent Android 12+ uses instead for apps
  targeting API 31+ (this app targets API 36) — both must stay in sync;
  scripts/patch-native-backup-exclusion.mjs regenerates both together.
-->
<full-backup-content>
    <exclude domain="root" path="app_webview/" />
</full-backup-content>
`;
}

/** API 31+ backup rules (`android:dataExtractionRules`). */
export function androidBackupRulesApi31Xml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  Issue #950 — see backup_rules.xml for the full rationale. Excluded from
  both cloud-backup and device-transfer: a new device silently inheriting
  the AMK during a device-to-device migration is the same "left the
  original device" failure as a cloud copy, so it gets the same exclusion.
-->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" path="app_webview/" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" path="app_webview/" />
    </device-transfer>
</data-extraction-rules>
`;
}

const IOS_HELPER_MARKER = 'excludeWebViewStorageFromBackup()';

const IOS_HELPER_FUNCTION = `
    /// Issue #950: WKWebView's persistent storage (localStorage, IndexedDB,
    /// cookies — including the AMK, see apps/web/src/lib/amk-store.ts)
    /// lives under Library/WebKit. Apple backs up everything under Library
    /// (besides Caches/tmp) to iCloud/iTunes by default; this opts that
    /// directory out via NSURLIsExcludedFromBackupKey.
    /// https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey
    ///
    /// Called from both didFinishLaunchingWithOptions and
    /// applicationDidBecomeActive: the Library/WebKit directory does not
    /// exist yet on a cold first launch before the WKWebView initializes
    /// (setResourceValues requires the path to already exist), and Apple's
    /// own docs warn the exclusion flag "exists only to provide guidance"
    /// and "certain file operations can reset resource values" — so this
    /// re-applies on every foreground transition rather than assuming one
    /// successful call is permanent.
    private func excludeWebViewStorageFromBackup() {
        let fileManager = FileManager.default
        guard let libraryURL = fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first else {
            return
        }
        var webKitURL = libraryURL.appendingPathComponent("WebKit", isDirectory: true)
        guard fileManager.fileExists(atPath: webKitURL.path) else {
            return
        }
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try? webKitURL.setResourceValues(resourceValues)
    }
`;

/**
 * Injects a call to `excludeWebViewStorageFromBackup()` at the top of
 * `didFinishLaunchingWithOptions` and `applicationDidBecomeActive`, plus the
 * helper function itself, into the generated AppDelegate.swift. Idempotent
 * for the same reason as patchAndroidManifest above.
 */
export function patchAppDelegate(appDelegateSwift) {
  if (appDelegateSwift.includes(IOS_HELPER_MARKER)) {
    return appDelegateSwift;
  }
  if (!appDelegateSwift.includes('didFinishLaunchingWithOptions')) {
    throw new Error(
      "patchAppDelegate: didFinishLaunchingWithOptions not found — cap add ios's " +
        'generated AppDelegate.swift shape has changed, update this patch (issue #950)',
    );
  }
  if (!appDelegateSwift.includes('applicationDidBecomeActive')) {
    throw new Error(
      "patchAppDelegate: applicationDidBecomeActive not found — cap add ios's " +
        'generated AppDelegate.swift shape has changed, update this patch (issue #950)',
    );
  }
  if (!/\}\s*$/.test(appDelegateSwift)) {
    throw new Error(
      'patchAppDelegate: file does not end with the class closing brace as expected — ' +
        "cap add ios's generated AppDelegate.swift shape has changed, update this patch (issue #950)",
    );
  }

  let patched = appDelegateSwift;
  if (!patched.includes('import Foundation')) {
    patched = patched.replace('import UIKit', 'import UIKit\nimport Foundation');
  }
  patched = patched.replace(
    /(func application\(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\?\) -> Bool \{\n)/,
    `$1        excludeWebViewStorageFromBackup()\n`,
  );
  patched = patched.replace(
    /(func applicationDidBecomeActive\(_ application: UIApplication\) \{\n)/,
    `$1        excludeWebViewStorageFromBackup()\n`,
  );
  patched = patched.replace(/\}\s*$/, `${IOS_HELPER_FUNCTION}}\n`);
  return patched;
}
