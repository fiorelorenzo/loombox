---
'@loombox/push-core': minor
'@loombox/web': minor
'@loombox/mobile': minor
---

Native push registration and payload handling for the Capacitor shell (issue #282)

`apps/mobile` now has a real native push path built on `@capacitor/push-notifications`
and `@capacitor/local-notifications`: `registerNativePush` acquires an APNs/FCM device
token (falling back cleanly to `'unavailable'` on a non-native platform, e.g. a web
preview or a dev build, rather than crashing), and `startNativePushListening` decides
whether an incoming push should show anything and displays it as a local notification,
routing a tap back into the app the same way the web path's `notificationclick` handler
does.

This is not a second implementation of push: the payload parsing, per-project
mute/quiet-hours suppression, generic notification copy, and approve/deny action
resolution all moved out of `apps/web`'s `push-payload.ts`/`push-suppression.ts`/
`push-action-routing.ts` into a new `@loombox/push-core` package, which both `apps/web`
(re-exported, unchanged public surface) and `apps/mobile` now depend on. `apps/web`
itself is otherwise unaffected — every existing import path and test still passes.

The one genuinely new invariant this wave protects is the same one Web Push already
enforced: the relay never sends decrypted session content over push, only a
`{ kind, sessionId }` routing hint, and `notificationContentFor` derives the shown
title/body from fixed strings plus that already-cleartext id, never from anything a
compromised or malformed payload might additionally carry. That function — and the
adversarial-payload tests pinning it down — is what both the web and the native push
provider (a browser vendor's push service, or FCM/APNs) actually see; nothing about
this change gives a push provider access to anything it didn't already have.

Native push messages are data-only (no FCM/APNs "notification" block) so suppression
can run before anything is ever displayed, exactly mirroring why the web path's Service
Worker controls display itself instead of letting the browser auto-render push content.

Out of scope for this change, and explicitly not claimed as working: relay-side storage
of native device tokens and actually sending via FCM/APNs (needs real Firebase/Apple
credentials this environment has none of), and background/killed-app delivery on either
platform (needs native Kotlin/Swift code — a custom Android `FirebaseMessagingService`
and an iOS Notification Service Extension — that this box has no emulator/toolchain to
build or verify). Both fail closed today rather than doing something wrong.
