---
'@loombox/node': minor
'@loombox/shared': minor
---

Add Jira `TrackerBackend` boards/sprints, live tracker slice 3 (SPEC §7.10, issue #217)

`JiraTrackerBackend` now implements `listBoards`/`listSprints`/`moveToSprint` against Jira's Agile REST base (`/rest/agile/1.0/...`), a genuinely different base path and pagination shape from the issue REST base (`/rest/api/3/...`) slices 1/2 already use. `capabilities.boards`/`capabilities.sprints` flip to `true`.

`TrackerBoard.id`/`TrackerSprint.id` are opaque, backend-issued ids: SPEC §7.10's literal `TrackerBackend` interface gives `listSprints(boardId)`/`moveToSprint(sprintId, externalIds)` no `TrackerBinding`, so this backend folds the resolving `connectionId` into the id itself (a base64url `{connectionId, id}` envelope) rather than changing that interface's method signatures. `@loombox/shared`'s `TrackerSprint` gains optional `boardId`/`startDate`/`endDate`/`goal` fields alongside its existing required `state: 'future' | 'active' | 'closed'` — sprint state is modelled per-sprint, never flattened into a combined board+sprint list, so a cockpit can tell a session tied to a story in the active sprint from one still in the backlog or already shipped.

`JiraTrackerBackend` also gains `createSprint`/`startSprint`/`closeSprint` directly (not part of `TrackerBackend` — SPEC's interface has no such method), posting/partially-updating `POST`/`POST /rest/agile/1.0/sprint[/{id}]` for issue #217's third acceptance line. OAuth 3LO routing (`api.atlassian.com/ex/jira/{cloudId}/...`) is honored for the Agile base the same way it already is for the issue base, since every call still composes its URL purely from `credential.baseUrl`.
