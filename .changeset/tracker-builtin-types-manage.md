---
'@loombox/web': patch
---

Local tracker: built-in Task/Bug/Epic, a `bug:` title prefix, and a real "Manage types" surface (v7 decision F3-1, issue #673)

Task/Bug/Epic already shipped as built-in types on the node side
(`NativeTrackerStore.listTypes()` always includes them), but the client
put "New type" right next to "New record" in the Tracker page's own
header — equally prominent, so a fresh project's first Tracker visit
still looked like it needed data modeling before you could record
anything.

Typing `bug:`/`task:`/`epic:` (or any custom type's own id), case-
insensitively, at the start of the title in `TrackerRecordDialog` now
picks that type and strips the prefix from the stored title — matched
against every currently known type, longest id wins so a more specific
custom type never gets shadowed by a shorter built-in one. Only applies
in create mode; editing an existing record never re-derives its type
from the title.

"New type" moves behind a new "Manage types" action, which is also the
actual fix for the write-only complaint: the old dialog only ever
rendered a blank create form, with no surface anywhere that showed a
type back once you'd defined it. `TrackerManageTypesDialog` is a single
dialog (mirroring `AddTargetWizard`'s own single-panel, multi-step
convention — never two stacked overlays) that lists every known type and
swaps to the same define-type form for "New type"; the list renders
whatever `types` the caller's live snapshot holds, so a defined type
shows up there again on reopen and survives a reload — proven with a
component test that unmounts and remounts against a fake backend
external to the Svelte tree, not local component state. The node-side
persistence and the wire round trip were already covered
(`native-tracker-store.test.ts`'s "persists across a simulated restart",
`relay-client.test.ts`'s `defineTrackerType` suite) — the actual gap was
purely the missing UI surface.

Existing records and the built-in type ids/labels/roles are untouched,
so nothing remaps across this change.

Not addressed here: `NodeDaemon.readTrackerSnapshotForBridge` reads the
native store regardless of `TrackerMode` (issue #631), so a project
switched to GitHub/Jira still sees local tracker data with no error. #673
is scoped to the local tracker itself and ships with that gap
undisturbed — a picker for GitHub/Jira project is a separate concern
(v7 decision F1-1/F2-2).
