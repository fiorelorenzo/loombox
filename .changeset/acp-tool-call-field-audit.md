---
'@loombox/providers-core': patch
---

Fix AcpClient's tool_call/tool_call_update/plan wire mapping against the real ACP schema (issue #623)

`AcpClient` read `update.toolKind` for a tool call's category. ACP's real field is `kind` (agentclientprotocol.com/protocol/v1/tool-calls). Against a real agent this was always undefined, so every tool call fell back to the generic row instead of its bash/edit/read widget. This is the same class of bug #248/PR #622 found in `usage_update`, so this fix is a full field-by-field audit of the mapping rather than a one-line patch, with the result of that audit below.

Found and fixed, in `packages/providers/core/src/client.ts`:

- `kind` (was read as `toolKind`): the reported bug. Every tool call's category was silently lost.
- `toolCallId` (was read as `id`): ACP's `ToolCall`/`ToolCallUpdate` field is `toolCallId`, not `id`. Since `mapToTranscriptUpdate` returns `undefined` when this is missing, every real tool call was silently dropped from the transcript entirely, not just misclassified.
- diff extraction: ACP has no top-level `diff` field on `ToolCall`/`ToolCallUpdate`. A diff is one `{type: 'diff', path, oldText, newText}` entry inside the `content` array (agentclientprotocol.com/protocol/v1/tool-calls#diffs). `client.ts` now scans `content` for that entry instead of reading a wire field that does not exist. This mattered for the acceptance bar too: the edit/write widget only activates when `diff` is present, so the diff-extraction fix and the `kind` fix both had to land for an edit tool call to actually reach its bespoke widget.
- the plan notification's own discriminant was wrong: ACP sends `sessionUpdate: 'plan'`, and the mapping's switch checked `'plan_update'` (this client's own internal name for the same update, used nowhere on the wire). Every real agent's plan report was silently dropped. No fixture or hand-written test ever sent a real plan notification, so nothing had caught this until now.

Checked and already correct: `sessionUpdate`/`messageId`/`content` for message chunks, `status`/`title`/`rawInput`/`locations`/`content` for tool calls, `entries`/`content`/`priority`/`status` for plan entries, and `used`/`size`/`cost` for `usage_update` (fixed by #248).

Checked and intentionally left alone: `parentToolCallId` is not an ACP wire field at all, it is a value SPEC.md §5.5/§7.24 documents a provider's `enrich()` hook promoting from vendor `_meta` (v2 work, issue #184), so it is correctly always undefined off the wire today. `config_option_update`'s `options` field name and per-option shape also diverge from ACP's real `configOptions`/`SessionConfigOption`, but that is a separate, larger subsystem (a different data model, not a field rename) outside this issue's tool-call/plan scope, flagged for a follow-up rather than folded into this fix.

The fixtures in `packages/providers/core/test/fixtures/` encoded the same invented `id`/`toolKind`/top-level-`diff` shapes as the bug, so the existing tests agreed with the bug rather than with ACP. Fixed alongside the mapping, plus new tests in `client.test.ts` that build ACP-shaped payloads (not fixture-shaped ones) and drive them through `mapToTranscriptUpdate` and `reduceTranscript` to prove a real `kind` and a real content-embedded diff reach the fields `apps/web`'s `resolveToolWidgetKind` routes on.
