---
'@loombox/web': patch
'@loombox/providers-core': patch
---

Stop a tool call with no `id` from wearing the "awaiting permission" outline

`+page.svelte` computed `awaitingPermission={permissionHead?.toolCall.id === item.id}`. With no permission in flight, `permissionHead` is `undefined` and the optional chain short-circuits to `undefined`; if the transcript item's own `id` is also `undefined`, the comparison is `undefined === undefined`, true, and the row painted the amber `outline: 2px solid var(--color-warning)` even though nothing was pending. `item.id` is reachable as `undefined` from real traffic: the transcript payload is opaque ciphertext to the protocol, and the client casts the decrypted JSON with `openJson<AcpSessionWireEvent>` rather than parsing it with Zod, so nothing rejects a `tool_call` that omits `id`. The comparison now short-circuits on `permissionHead !== undefined` first.

The same shape turned up twice more in a sweep of every optional-chain/possibly-undefined equality comparison across the web client and its shared protocol reducer. `RelayClient.discardStalePermissionForToolCall` compared `request.toolCall.id === event.id`; a malformed `tool_call_update` with no `id` could match a pending permission request whose own `toolCall.id` was equally malformed (the paired `permission_request` payload goes through the same unvalidated cast), cancelling it and publishing a false "resolved on another device" notice. `@loombox/providers-core`'s `reduceToolCall` looked up an existing transcript row by `item.id === update.id`; two unrelated malformed tool calls with no `id` would merge into a single row, the second silently overwriting the first's title/status. Both now refuse to match when the incoming `id` is `undefined`, so a malformed event always ends up in its own row/no-op rather than colliding with an earlier one.
