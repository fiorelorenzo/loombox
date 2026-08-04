---
'@loombox/node': minor
'@loombox/relay': patch
'@loombox/web': minor
---

Move a project's tracker mode from browser `localStorage` to the node (SPEC §7.10, issue #631)

`TrackerMode` used to be persisted only in the browser's `localStorage`, so a project switched to `live` GitHub or Jira tracking saved that choice per BROWSER, not per project, and the node had no way to see it at all — `NodeDaemon.readTrackerSnapshotForBridge` read the local native tracker store unconditionally because it was the only thing the node had, so a switched project silently kept showing local records.

`@loombox/node` gets `TrackerModeStore` (`tracker-mode-store.ts`), the exact sibling of `AccountPinStore`: one JSON file under `stateDir`, keyed by a project's absolute `projectPath`, re-validated on every read through `@loombox/protocol`'s `safeParseTrackerMode` — an on-disk value that no longer validates reads back as absent, never repaired into a guessed `{kind:'native'}`. `NodeDaemon` gains `tracker_mode_get_request`/`tracker_mode_set_request` handlers replying with `tracker_mode_response`, mirroring the account-pin request/reply convention exactly, plus a synchronous `this.trackerModeStore.get(projectPath)` read for other daemon code (the bridge dispatch consumes this next).

`@loombox/relay` gets `tracker_mode_get/set_request`/`tracker_mode_response` added to its existing client↔node routing switch (reusing the account-pin request table) — the protocol schemas alone don't make a message reach anywhere without this.

`apps/web`'s `tracker-mode-store.ts` gets `createRelayTrackerModeStorage`, now what `TrackerPage.svelte` actually constructs: relay-backed, with a real three-state `Readable<TrackerModeState>` (`'loading'`/`'loaded'`/`'error'`) so a saved mode can never flash the "choose a mode" setup step while its own node round trip is still in flight — collapsing "I don't know yet" into "never chosen" would reintroduce the exact guess issue #209 exists to prevent, one layer up. `TrackerConfigPanel.svelte`'s existing synchronous `TrackerModeStorage` (`get`/`set`) contract is unchanged and untouched.

**Migration, one-shot, node always wins**: on first load, a mode already saved in `localStorage` from before this change is pushed to the node (`tracker_mode_set_request`) and the local key is cleared — but only if the node had nothing saved; a mode the node already has always wins outright, and a failed push leaves the local key alone so a later retry can still migrate it. A project with no mode saved anywhere still reaches the exact same "choose native or live" setup step as before, once loading settles — the choice now lives on the node and is visible from any device.

The bridge dispatch (`readTrackerSnapshotForBridge`/`applyTrackerWriteForBridge` actually consulting this mode, via `@loombox/node`'s `resolveTrackerBackend`) and the Tracker page's richer connectivity-error rendering are follow-up work on top of this transport.
