---
'@loombox/providers-core': patch
'@loombox/web': patch
---

Tool-call rows now carry a per-kind icon, elapsed time and, where honest, an attributed cost figure (Zed-parity C3-3, issue #744). The v7 C1-1 one-line shape is unchanged; this is only what shares that line.

`@loombox/providers-core`'s `TranscriptToolCallItem` gains four new fields, computed purely by the reducer:

- `startedAtMs` — set only from a real, non-terminal `tool_call` (never from a `tool_call_update`, so a call whose start this client never watched — e.g. one attached mid-session, or a resumed session's history replaying an already-finished call as one settled snapshot — never gets an invented start time).
- `elapsedMs` — frozen once, the instant a later `tool_call_update` first carries a terminal status; `undefined` whenever `startedAtMs` is.
- `costAtStartUsd` — internal bookkeeping, not for display.
- `attributedCostUsd` — a client-side heuristic over `usage_update`'s session-level running cost total (it carries no `toolCallId` at all): the delta between session start and terminal update, shown only when this call was the sole active top-level tool call throughout its own lifetime and the total actually grew. Any other case — overlap with a sibling call, a nested/subagent call, no cost reporting at all — leaves it `undefined`, never a fabricated `$0.00`.

`reduceTranscript`/`reduceSessionEvent` both take an optional `now` (default `Date.now()`) for deterministic tests, the same clock-injection convention `permission-queue-state.ts` already used.

`@loombox/web`'s `apps/web/src/lib/components/icons/icon-paths.ts` adds six glyphs — `tool-read`, `tool-delete`, `tool-move`, `tool-search`, `tool-think`, `tool-fetch` — so every ACP `ToolKind` (`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`) renders a distinct icon instead of `search`/`read`/`fetch`/`delete`/`move` all sharing the generic wrench; an unrecognized future kind still falls back to it via `$lib/tool-widgets.ts`'s new `toolKindIcon`. A new shared `ToolCallMeta` component (mirroring the existing `ToolCallGutter`/`ToolCallStatus` pattern) renders the elapsed-time/cost badges next to `ToolCallStatus` in `GenericToolRow` and every `tool-widgets/*` bespoke widget.
