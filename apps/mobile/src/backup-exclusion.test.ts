import { describe, expect, it } from 'vitest';
import {
  androidBackupRulesApi31Xml,
  androidBackupRulesXml,
  patchAndroidManifest,
  patchAppDelegate,
} from '../scripts/backup-exclusion.mjs';

// Fixtures below are verbatim captures of what `cap add android`/`cap add
// ios` (Capacitor 8.5.0, this package's pinned version) actually generated
// when run for real against this package's capacitor.config.ts, during work
// on issue #950 — not hand-approximated. Regenerating them in-repo (`npx cap
// add android`/`npx cap add ios` after `pnpm build`) needs a JDK on
// PATH/network access this suite can't assume, which is exactly why the gate
// here is these fixtures plus the pure patch functions, not a live `cap add`
// run — see the PR description for the real run's output.

const GENERATED_ANDROID_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

const GENERATED_APP_DELEGATE = `import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
`;

describe('android backup exclusion (issue #950)', () => {
  it('does not already exclude app_webview before patching (fixture sanity)', () => {
    expect(GENERATED_ANDROID_MANIFEST).not.toContain('fullBackupContent');
    expect(GENERATED_ANDROID_MANIFEST).not.toContain('dataExtractionRules');
  });

  it('adds both the API <=30 and API 31+ backup-rule attributes to <application>', () => {
    const patched = patchAndroidManifest(GENERATED_ANDROID_MANIFEST);
    expect(patched).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(patched).toContain('android:dataExtractionRules="@xml/backup_rules_api31"');
    // Nothing else in the generated manifest gets lost.
    expect(patched).toContain('android:allowBackup="true"');
    expect(patched).toContain('<uses-permission android:name="android.permission.INTERNET" />');
  });

  it('is idempotent — re-running cap sync must not duplicate the attributes', () => {
    const once = patchAndroidManifest(GENERATED_ANDROID_MANIFEST);
    const twice = patchAndroidManifest(once);
    expect(twice).toBe(once);
    expect(once.match(/fullBackupContent/g)).toHaveLength(1);
    expect(once.match(/dataExtractionRules/g)).toHaveLength(1);
  });

  it('throws instead of silently no-op-ing if a future Capacitor template drops <application>', () => {
    expect(() => patchAndroidManifest('<manifest></manifest>')).toThrow(/<application>/);
  });

  it('excludes app_webview at the app-private root (domain="root"), not inside getFilesDir()', () => {
    // WebView's storage directory (`app_webview/`) is a sibling of
    // `files/`/`databases/` at the app's private-storage root, not inside
    // getFilesDir() — so the rule domain must be "root", not "file".
    for (const xml of [androidBackupRulesXml(), androidBackupRulesApi31Xml()]) {
      expect(xml).toMatch(/<exclude domain="root" path="app_webview\/?" ?\/>/);
    }
  });

  it('excludes app_webview from both cloud-backup and device-transfer on API 31+', () => {
    const xml = androidBackupRulesApi31Xml();
    expect(xml).toMatch(
      /<cloud-backup>[\s\S]*<exclude domain="root" path="app_webview\/" \/>[\s\S]*<\/cloud-backup>/,
    );
    expect(xml).toMatch(
      /<device-transfer>[\s\S]*<exclude domain="root" path="app_webview\/" \/>[\s\S]*<\/device-transfer>/,
    );
  });
});

describe('ios backup exclusion (issue #950)', () => {
  it('does not already exclude WebKit storage before patching (fixture sanity)', () => {
    expect(GENERATED_APP_DELEGATE).not.toContain('excludeWebViewStorageFromBackup');
    expect(GENERATED_APP_DELEGATE).not.toContain('isExcludedFromBackup');
  });

  it('injects the exclusion call into didFinishLaunchingWithOptions and applicationDidBecomeActive', () => {
    const patched = patchAppDelegate(GENERATED_APP_DELEGATE);

    const launchBody = patched
      .split('didFinishLaunchingWithOptions')[1]!
      .split('func applicationWillResignActive')[0]!;
    expect(launchBody).toContain('excludeWebViewStorageFromBackup()');

    const activeBody = patched
      .split('func applicationDidBecomeActive')[1]!
      .split('func applicationWillTerminate')[0]!;
    expect(activeBody).toContain('excludeWebViewStorageFromBackup()');
  });

  it('defines the helper against Library/WebKit using NSURLIsExcludedFromBackupKey (isExcludedFromBackup)', () => {
    const patched = patchAppDelegate(GENERATED_APP_DELEGATE);
    expect(patched).toContain('private func excludeWebViewStorageFromBackup()');
    expect(patched).toContain('.libraryDirectory');
    expect(patched).toContain('appendingPathComponent("WebKit"');
    expect(patched).toContain('resourceValues.isExcludedFromBackup = true');
  });

  it('still ends with exactly one class-closing brace (no unbalanced braces introduced)', () => {
    const patched = patchAppDelegate(GENERATED_APP_DELEGATE);
    const openBraces = (patched.match(/\{/g) ?? []).length;
    const closeBraces = (patched.match(/\}/g) ?? []).length;
    expect(closeBraces).toBe(openBraces);
    expect(patched.trimEnd().endsWith('}')).toBe(true);
  });

  it('is idempotent — re-running cap sync must not duplicate the call or the helper', () => {
    const once = patchAppDelegate(GENERATED_APP_DELEGATE);
    const twice = patchAppDelegate(once);
    expect(twice).toBe(once);
    expect(once.match(/excludeWebViewStorageFromBackup\(\)/g)).toHaveLength(3); // 2 call sites + 1 declaration
    expect(once.match(/private func excludeWebViewStorageFromBackup/g)).toHaveLength(1);
  });

  it('throws instead of silently no-op-ing if a future Capacitor template changes the lifecycle methods', () => {
    expect(() => patchAppDelegate('class AppDelegate {}')).toThrow(/didFinishLaunchingWithOptions/);
  });
});
