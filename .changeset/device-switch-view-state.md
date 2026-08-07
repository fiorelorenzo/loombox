---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Device-switch state preservation (SPEC §7.3; issue #198): switching from one device to another mid-session now resumes at a sensible reading position instead of a cold scroll to the top, borrowing Happy's per-session invalidate/caching approach as clean-room inspiration.

- `@loombox/protocol`: new wire messages `session_view_state_get_request` / `session_view_state_set` / `session_view_state_result`, and a sealed `SessionViewStatePayloadV1` (composer `draft`, open canvas `panel`, `lastViewedItemId`) carried inside an `EncryptedEnvelope` exactly like a prompt — the relay never sees a byte of it in the clear.
- `@loombox/relay`: `SessionViewStateStore` (in-memory and Postgres, migration `0013_session_view_state`), ownership-checked `session_view_state_*` handlers with cross-device live push (mirrors `keymap_set_request`'s fan-out), and TTL pruning alongside `session_archive_response`/`prune.ts`.
- `@loombox/web`: `RelayClient.sessionViewStateFor`/`setSessionViewState`, sealed under the session's own `deriveSessionKey`, re-fetched on every reconnect. `TranscriptTimeline` gains `onViewportItemChange`, reporting the reading-position item at the top of the mounted window (`undefined` while pinned to the live tail). `+page.svelte`'s `selectSession` restores the saved draft/panel/reading-position (gated by a short settle window so a live push from another device can't stomp local edits already in flight), bridges the saved panel onto `CanvasTabsState`, resolves the saved reading position against this device's own resynced transcript as it arrives (via `$lib/session-view-state.ts`'s `invalidateStaleViewState` — a position evicted by the relay's bounded resync ring is dropped back to the live-tail default rather than restored to somewhere that no longer makes sense), and persists on a debounce once settled. Explicitly out of scope: the composer's `@`-mention pills (device-local picker state, re-resolved by re-typing `@`) and dock open/close chrome (already local-only).

Verified: reopening a session in a real headless-browser reload restores the saved draft, open canvas tab, and scroll position; a saved position from before another device advanced the session is invalidated rather than restored to a stale point; a wire-shape test proves the composer draft never reaches the relay unsealed.
