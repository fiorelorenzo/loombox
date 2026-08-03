---
'@loombox/protocol': minor
'@loombox/shared': minor
'@loombox/web': patch
---

Add the `TrackerMode` config and the pluggable `TrackerBackend` extension point (SPEC §7.10)

`@loombox/protocol` gets `v1/tracker.ts`: Zod-validated `githubTarget`/`jiraTarget` and the `trackerMode` discriminated union (`{kind:'native'}` or `{kind:'live', provider, connectionId, target}`), exported and registered in `schemasV1` alongside every other v1 schema. The exported `TrackerMode` type keeps SPEC's literal `target: GitHubTarget | JiraTarget` shape (not correlated to `provider` at the type level, exactly as specced), but the schema adds a `superRefine` cross-check so a GitHub-shaped target submitted under `provider: 'jira'` (or the reverse) is rejected at parse time, since that correlation is clearly the spec's intent even though its type block does not encode it.

`@loombox/shared` gets its first real export: `TrackerBackend` and `TrackerBackendCapabilities`, plus the `TrackerBinding`/`TrackerListFilter`/`TrackerListPage`/`TrackerItemLive`/`TrackerTransition`/`TrackerBoard`/`TrackerSprint` shapes those methods reference. `list`/`get`/`create`/`update`/`listBindings` are required; `addComment`/`listTransitions`/`transition`/`listBoards`/`listSprints`/`moveToSprint` are optional, matching SPEC §7.10's phased delivery (issues/comments first, transitions next, boards/sprints last). A type-level `satisfies TrackerBackend` check in `tracker-backend.test.ts` proves a stub implementing only the required methods still satisfies the interface with every optional method absent, and fails to compile if that ever stops being true.

`apps/web` gets `$lib/tracker-mode-store.ts`, a per-project persisted `TrackerMode` (localStorage today, same injectable-storage pattern as `mcp-server-store.ts`/`plugin-store.ts`). `get()` returns `TrackerMode | undefined`: an unset project, or one whose stored value no longer validates, both read as `undefined`, never silently coerced to `{kind:'native'}`. No consumer wires this store into the UI yet; that is issue #212's job.
