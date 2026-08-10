// Type declarations for backup-exclusion.mjs, kept plain JS (no build step)
// so it runs unmodified as a Capacitor CLI hook at `cap add`/`cap sync` time.
// See that file for behaviour and citations.

export function patchAndroidManifest(manifestXml: string): string;
export function androidBackupRulesXml(): string;
export function androidBackupRulesApi31Xml(): string;
export function patchAppDelegate(appDelegateSwift: string): string;
