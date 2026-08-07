---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Added a reusable prompt/snippet library (SPEC §7.18; issue #261, epic #29): save phrasing from any session's composer and insert it verbatim into any other session's composer.

This is a genuinely new mechanism, not a fourth parallel one folded on top of what already existed. `SessionTemplateV1` (issue #259) has no field for arbitrary prompt text at all — it carries the session-_creation_ choices (target, provider, agent, worktree, a default title), never a body of text to insert mid-conversation. The `/`-command picker is the connected agent's own declared catalogue, never persisted or user-authored. `@`-mentions resolve to a live reference rendered as a pill, never literal text. A snippet is the plain, user-authored, persisted case none of the three cover.

- `@loombox/protocol`: new `snippet.ts` — `SnippetV1` (`id`/`name`/`text`), `snippet_list_get`/`snippet_list_set`/`snippet_list_result` wire trio. Follows `agent-profile.ts`'s catalog half exactly: routed by `sessionId` (the composer this catalog is read from and written from always has a live session open, unlike `session-template.ts`'s pre-session `NewSessionDialog` context), no envelope on `_get`, `_set` envelope-sealed.
- `@loombox/node`: new `snippet-store.ts` (`SnippetStore`) — one JSON file per account (`snippets.json`), mirroring `session-template-store.ts`'s shape and rationale exactly (`SnippetV1` IS the store's value type, `snippetV1.safeParse` IS its on-disk validation). `NodeDaemon` gains `handleSnippetListGet`/`handleSnippetListSet`, appended as one contiguous block at the end of the class per this wave's merge-trap convention.
- `@loombox/relay`: routes `snippet_list_get`/`_set`/`_result` exactly like the existing `agent_profile_list_*` trio (client->node forward, node->client fan-out; the relay never opens the envelope).
- `@loombox/web`: new `SnippetPicker.svelte` (browse/search/insert/save/delete) and a composer "Insert snippet" button next to Attach image. Selecting a snippet splices `text` verbatim at the live caret (replacing any selection) via a new `insertSnippetText`, the first composer insertion path that isn't anchored to a typed trigger position. `RelayClient` gains `listSnippets`/`saveSnippets`.

Verified: `SnippetStore` persists across a fresh instance pointed at the same state dir (a real restart, not a mock); a real relay/node/client wire round trip for `snippet_list_set`/`_get`; `SnippetPicker.test.ts` proves selecting an entry hands back the exact saved text; `page.test.ts` proves the composer textarea ends up with exactly the expected spliced text, including mid-draft cursor insertion.
