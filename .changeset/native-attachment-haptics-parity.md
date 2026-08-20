---
'@loombox/web': minor
---

Issue #284: native camera/photo-library picker and haptics parity for the Capacitor shell.

`AttachmentBar.svelte`'s single "Attach image" trigger (`pickFiles()`) now checks `Capacitor.isNativePlatform()` once and, inside the native shell, opens the device's own combined camera/photo-library chooser (`native-attachments.ts`'s `pickAttachmentImages`, wrapping `@capacitor/camera`'s `getPhoto`) instead of clicking the hidden `<input type="file">`. Everywhere else — every browser, mobile or desktop — the web branch is unchanged. Both branches feed the exact same `onFiles(files: File[])` callback `RelayClient.attachFile` already owns, so a natively captured image runs through the identical client-side magic-byte/size validation and encrypt+upload pipeline a web-picked file does, with no separate path and no native-specific HEIC handling: a HEIC byte stream a device hands back unconverted is rejected by the same `validateAttachmentBytes` sniff that rejects one dropped from a desktop browser.

`haptics.ts`'s `triggerHapticFeedback` — the one existing call site `PermissionCard.svelte`/`AttentionInbox.svelte` already use for confirm/deny taps — gained a third, optional `native` param (defaulting to a real `Capacitor.isNativePlatform()` check and the real `@capacitor/haptics` plugin) that fires `ImpactStyle.Light` inside the native shell instead of `navigator.vibrate`. No caller changes: the default reads `false` outside the native shell, so every existing call and every existing test keeps exercising the unchanged Vibration-API branch.

New dependencies: `@capacitor/core`, `@capacitor/camera`, `@capacitor/haptics` (apps/web). Not runnable on this box — no Android emulator, no iOS toolchain (docs/superpowers/specs/2026-08-08-capacitor-mobile-spike.md) — so both native branches are unit-tested against injected fakes for the plugin/platform-check, never exercised live; `relay-client.test.ts` gained a full encrypt/upload/peer-decrypt round-trip test proving a `File` built from a faked native `getPhoto`/`fetch` result goes through `RelayClient.attachFile` identically to a web-picked one, plus a matching HEIC-through-native rejection test.
