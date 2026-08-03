---
'@loombox/providers-core': minor
'@loombox/web': patch
---

Fix the per-session usage meter and add a near-context-limit warning (SPEC §7.9, issue #248)

The composer's context/cost meter (`ConfigBar.svelte`, previously wired up for the model/mode/reasoning-effort bar) is SPEC §7.9's live usage meter — this doesn't add a second one, it fixes and extends the one already there. Three real bugs, all in `@loombox/providers-core`, none visible from `ConfigBar.svelte`'s own diff:

- `AcpClient` was reading a raw `usage_update` wire event for field names (`tokensUsed`/`contextWindow`/`costUsd`) that don't exist on ACP's real shape. The protocol's actual `UsageUpdate` is `{used, size, cost}` with `cost: {amount, currency} | null` (agentclientprotocol.com/protocol/v1/schema) — so the meter never actually populated against a real ACP agent. Fixed in `client.ts`'s wire mapping; a non-USD `cost.currency` is left unconverted (`costUsd: undefined`) rather than mislabeled as dollars.
- `cost.amount` is documented as the session's running cumulative total, not a per-update delta — the reducer was summing it, double-counting every update after the first. `cumulativeCostUsd` now tracks the latest reported total (`Math.max` against the previous value, guarding only against an out-of-order delivery ever making it visibly shrink).
- A subagent tool call's `usage_update` reports its own, much smaller context window. The reducer now freezes the parent's `tokensUsed`/`contextWindow` across a subagent-attributed update instead of letting it overwrite them (previously masked by a UI-side guard, which just traded "the meter shows the wrong number" for "the meter shows nothing" while the subagent tool call was in flight) — the percentage no longer bounces either way. The subagent's cost is still folded into the cumulative figure, since ACP's own cumulative total already includes it.

The subagent/parent split has no protocol support — ACP's `usage_update` carries no tool-call linkage at all — so it stays a documented client-side heuristic (`UsageRecord.attributedToSubagent`'s doc comment in `transcript.ts` spells out what it keys on and the two known ways it can misfire).

New: a near-context-limit warning on the meter itself, at the newly-exported `CONTEXT_NEAR_LIMIT_THRESHOLD` (80%) — grounded against real-world auto-compaction thresholds observed on Claude Code (reported anywhere from ~80% to ~95% depending on source/version), so the warning fires before the earliest point any of them might silently compact. Carried to assistive tech via a `.sr-only` span (the meter's percentage track stays `aria-hidden`).

Cost stays whatever the agent process itself reports via ACP's `cost.amount` — there is no per-token price table anywhere in this repo, and none is added here; a provider that omits `cost` simply doesn't move the cumulative figure for that update rather than getting an invented number.

No aggregate spend-over-time view (issue #249) and no spend caps (issue #251) ship here — those build on `cumulativeCostUsd`, not the other way around. The broader attention-inbox surfacing of a near-limit session (issue #250) is separate too; this issue's own acceptance only asked for the warning on the meter itself.
