---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Native tracker: kanban/list UI with custom type support (SPEC §7.10)

Adds the client surface for loombox's own local tracker (`packages/shared`'s `NativeTrackerStore`, #210): a full-width Tracker page reachable from the left sidebar once a session is selected, with a kanban board and a priority-sorted/assignee-filtered list view, both driven entirely by `@loombox/protocol`'s new role-driven helpers (`resolveRoleValue`/`groupByWorkflowStatus`/`sortByPriority`/`filterByAssignee`) so a built-in Task/Bug/Epic and a project-defined custom type render identically — nothing in this feature branches on a record's `primaryType`.

`@loombox/protocol` gets `tracker-records.ts`: the wire schema (`TrackerRecordV1`/`TrackerTypeDefinitionV1`) plus four new encrypted, session-scoped wire messages — `tracker_snapshot_request`/`_response` (read) and `tracker_write_request`/`_response` (create/update/defineType) — mirroring `fs.ts`'s existing pattern exactly. `@loombox/node` wires these into `NodeDaemon` against the same `NativeTrackerStore` a future MCP host will bind an agent's `tracker_*` tools to, so a human edit and an agent write land in the same on-disk file. `@loombox/relay` routes both pairs to/from the owning node exactly like `fs_list_request`/`_response`.

The UI ships: empty state with a "New record" CTA, a retryable `ErrorNotice` (matching the Files panel's #582 "didn't answer in time" wording) for both a wire error and a client-owned bounded-wait timeout, and a loading state that always terminates. The kanban board answers issue #212's mobile requirement directly: at <=767px it renders one column at a time with Prev/Next controls instead of a horizontal scroll of narrow columns. Moving a card between columns has two paths — native HTML5 drag-and-drop for a desktop mouse, and a fully keyboard/touch-operable "Move to" `Select` on every card — both calling the same `RelayClient.updateTrackerRecord`, never local component state. A "New type" dialog lets a project define a custom type's `roles` mapping (which `fields` key holds title/status/priority/assignee), after which every generic surface renders it correctly with no code change.
