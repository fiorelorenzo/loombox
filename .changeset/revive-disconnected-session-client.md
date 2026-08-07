---
'@loombox/providers-core': minor
'@loombox/web': minor
---

Client half of reviving a disconnected session's agent on demand (issue #706/#912)

`prompt_inject_result` and the `'starting'` reason `NodeDaemon.reviveSessionInternal` pushes (both added by #706's backend PR) were stable on the wire but unconsumed client-side. This closes that gap:

- `@loombox/providers-core`: `TranscriptItem` gains a `revival` variant (`TranscriptRevivalItem`) — a visible "this agent doesn't remember what's above" boundary marker, inserted by `reduceSessionEvent` the instant a `'starting'` `session_status` carries a `reason` (the one case that's ever true for, per `reviveSessionInternal`'s own doc comment). Idempotent by the event's own `updatedAt`, mirroring `TranscriptGapItem`'s range-keyed dedup.
- `@loombox/web`:
  - The composer is usable for a `'disconnected'` session again: `selectedSessionAgentless` (`+page.svelte`) drops `'disconnected'` from its disabled-composer set — sending now genuinely works, since the node revives the agent on demand. The placeholder text still hints at what happens (the agent restarts and won't remember earlier turns), it just no longer disables the field.
  - `RelayClient` tracks each session's most recent self-sent `promptId` and, on a `prompt_inject_result` with `outcome: 'error'`, publishes a `PromptInjectErrorNotice` (`promptInjectErrorFor`) and immediately settles the turn-active idle gate (`settleTurnNow`) so a retry the user sends right after doesn't sit queued behind a turn that never started. Rendered as a real `ErrorNotice` in the composer's own footer strip, not a console line.
  - `TranscriptTimeline.svelte` renders the new `revival` item via `TranscriptRevival.svelte`, an info-tinted inline row carrying the node's own disclosure text verbatim — positioned exactly where the new agent process starts, so its first reply is never mistaken for a continuation of the conversation before the restart.

Verified: `pnpm --filter @loombox/providers-core test` + `typecheck`, `pnpm --filter @loombox/web typecheck`, targeted `vitest` (`transcript.test.ts`, `relay-client.test.ts`, `transcript-tail.test.ts`, `transcript/turn-review.test.ts`, `transcript/search.test.ts`, `TranscriptTimeline.test.ts`, `routes/page.test.ts`), a new `tests-e2e/session-revive.spec.ts` (390px, real relay + fake node) covering both the happy path (composer usable, revival boundary visible, ordering correct, conversation continues) and the failure path (`prompt_inject_result` error surfaces as a real `ui-error-notice`), `pnpm exec eslint`/`prettier --check` on every changed file.
