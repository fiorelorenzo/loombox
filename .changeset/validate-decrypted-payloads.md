---
'@loombox/providers-core': minor
'@loombox/web': patch
---

Validate decrypted session_update/permission_request payloads with Zod instead of casting them (issue #593)

`apps/web`'s `relay-client.ts` opened every decrypted `session_update`/`permission_request` envelope with a bare `openJson<T>()` generic cast — nothing ever checked the JSON actually matched `AcpSessionWireEvent`/`PermissionRequestPayload`. `AcpToolCallUpdate.id` was declared `string` but could be `undefined` at runtime, the root cause behind #548 (patched there one reducer-level comparison at a time).

`@loombox/providers-core` gets a new `acp-wire-schema.ts`: Zod schemas for `AcpTranscriptUpdate`'s five ACP-native kinds (message/thought chunks, `tool_call`/`tool_call_update`, `plan_update`, `usage_update`) plus the `permission_request` payload — the half of `AcpSessionWireEvent` this package owns. The other half, loombox's five invented session-lifecycle kinds, is validated by `@loombox/protocol`'s existing `sessionLifecycleEventV1` schema instead of a new duplicate, since that package already documents itself as their "one validated source of truth" and providers-core keeps zero workspace dependencies by design.

`relay-client.ts` now parses (not casts) both payloads; a malformed one is dropped and logged before it ever reaches the transcript reducer or the permission queue. #548's reducer-level `id === undefined` guard stays in place as defense in depth, though it is no longer reachable through this path.
