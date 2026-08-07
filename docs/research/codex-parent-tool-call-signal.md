# Codex parent-tool-call signal — build-time verification spike (issue #199)

**Verdict: no equivalent exists, and the transcript tree already degrades gracefully, not
silently wrong.** Codex's real ACP bridge (`@agentclientprotocol/codex-acp@1.1.10`, the same
pinned devDependency issue #182's spike added to `packages/providers/codex`) has no field
anywhere in its shipped source shaped like Claude Code's `_meta.claudeCode.parentToolUseId`, under
any name. A spawned subagent surfaces as exactly two thread-scoped item types on the *parent's*
own ACP session — never a per-child tool-call event with a link back to the spawning call — and,
one level deeper than that absence, the bridge's own event-subscription code only ever listens to
the single ACP session's own thread id, so even a hypothetical future child-thread tool call would
have nowhere to arrive. `@loombox/providers-codex`'s `codexProviderModule.enrich()` is already a
documented no-op for exactly this reason (issue #199/#200, landed in PR #802), and issue #200's own
transcript-nesting code (`computeToolCallNesting`) already treats "no `parentToolCallId`" as a
first-class, correctly-flat case — a Codex subagent renders as a flat, non-nested item, matching
issue #200's own explicit acceptance criterion ("a session/provider without a parent link renders
flat, unchanged from v1 behavior") rather than disappearing or rendering wrong. **No gap filed**:
this is Codex's own protocol limitation, not a loombox bug, and loombox's handling of it is already
correct.

## Method

This spike follows the precedent issue #182 established
(`docs/research/codex-acp-completeness.md`'s own Method section) and issue #272 reused for Gemini
(`docs/research/gemini-acp-completeness.md`): read the REAL, installed `@agentclientprotocol/
codex-acp` package directly out of `node_modules`, rather than trusting a doc comment or a
hand-copied snippet.

- `packages/providers/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js` —
  the same pinned `devDependency` (`1.1.10`, `packages/providers/codex/package.json`) issue #182
  already added for its own, broader completeness spike. No new dependency was added for this
  spike; it re-reads the identical installed file, this time scoped to one specific question: does
  the bridge carry, anywhere, a field shaped like a tool-call-to-tool-call parent link, and if a
  subagent's own tool calls could ever reach this client at all regardless. `dist/index.js` is an
  esbuild bundle that preserves the original `src/*.ts` path comments and every identifier/string
  verbatim (re-confirmed here, same as #182 found), so a `file:line` citation against it is a
  faithful pointer to the real source. All line numbers below are against this exact file at this
  exact version.
- Full-bundle regex sweeps (`grep`/`matchAll` over all 31,611 lines), not just the functions that
  looked relevant at a glance — used to positively rule out a differently-named or
  differently-shaped equivalent existing somewhere else in the file, rather than stopping at "the
  one place I expected it isn't there."
- No live run was possible, same caveat every prior Codex verification in this repo carries (no
  `codex` CLI or credentials on this devbox — confirmed again here, unchanged since #182/#186):
  this is source-verification of the bridge package, not an observed real wire trace.

`packages/providers/codex/src/codex-subagent-signal-capabilities.test.ts` (new file, kept separate
from #182's own `codex-acp-capabilities.test.ts` per this repo's "new work in new files" convention
for files with real collision risk) turns every citation below into an executable assertion against
the installed package's source text, plus a "real-shape conformance" section that feeds
`@loombox/providers-codex`'s real `codexProviderModule.enrich()` and `@loombox/providers-core`'s
real `computeToolCallNesting()` the exact wire shapes found here — proving today's behavior, not
just documenting it.

## Findings

### 1. No `parentToolCallId`-equivalent field anywhere in the bundle

Neither of the two spellings a client-side promotion would look for appears anywhere in the
31,611-line bundle:

```
$ grep -c 'parentToolCallId' dist/index.js   # 0
$ grep -c 'parentToolUseId' dist/index.js    # 0
```

A broader sweep for *any* camelCase `parent*Id` field name (not just those two spellings, in case a
future release invents its own name for the same concept) also comes back empty:

```
$ grep -noE '[pP]arent[A-Za-z]*Id' dist/index.js   # (no matches)
```

This is the direct answer to issue #199's question: Codex does not expose a
`parentToolUseId`-equivalent today, under any name, anywhere in its shipped source.

### 2. How a spawned subagent actually surfaces: two thread-scoped item types, never a per-child event

A spawned subagent surfaces as exactly two ACP item types, both handled inside `CodexEventHandler`'s
`createItemEvent`/`completeItemEvent` (`dist/index.js:23867-23971`, `src/CodexEventHandler.ts`):

- **`collabAgentToolCall`** — the ONE summarizing "spawn" tool call. Its `_meta`
  (`createCollabAgentToolCallMeta`, `dist/index.js:23099-23108`):

  ```js
  function createCollabAgentToolCallMeta(item) {
    return {
      codex: {
        collaboration: {
          tool: item.tool,
          senderThreadId: item.senderThreadId,
          receiverThreadIds: item.receiverThreadIds
        }
      }
    };
  }
  ```

  A sender/receiver **thread id** pair, not a tool-call id — there is nothing here shaped like "my
  parent tool call's id."

- **`subAgentActivity`** — the "Start subagent X" / "Interact with subagent X" / "Interrupt
  subagent X" activity marker (`formatSubAgentActivityTitle`, `dist/index.js:23144-23153`),
  mutated in place as the subagent's lifecycle progresses. Its `_meta`
  (`createSubAgentActivityUpdate`, `dist/index.js:23121-23129`):

  ```js
  _meta: {
    codex: {
      subagent: {
        threadId: item.agentThreadId,
        path: item.agentPath,
        activity: item.kind
      }
    }
  }
  ```

  Again a **thread id** (the child's own), never the spawning call's `toolCallId`. Both `item.id`
  values used as each event's own `toolCallId` (`createCollabAgentToolCallUpdate`'s `toolCallId:
  item.id` at `dist/index.js:23070`; `createSubAgentActivityUpdate`'s `toolCallId: item.id` at
  `dist/index.js:23114`) come from Codex's own item stream — each is that event's own id, not a
  value this JS bridge computes or correlates against the other. Whether Codex's Rust core happens
  to assign the identical id string to a `subAgentActivity` item as it did to the `collabAgentToolCall`
  item representing the same logical spawn is Rust-core-internal behavior this npm package's JS
  source does not show one way or the other — this spike does not claim it either way, only what is
  directly grounded: **no client-side code in this bridge ever reads one item's id to link it to
  another's**, so even if the ids did coincide, nothing downstream treats that coincidence as a
  parent-child relationship (there is no reader for it to matter to).

The item-type union both `createItemEvent`'s and `completeItemEvent`'s switches dispatch on is a
closed, 18-member set (`dist/index.js:23867-23910`, `23912-23971`): `agentMessage`,
`collabAgentToolCall`, `commandExecution`, `contextCompaction`, `dynamicToolCall`,
`enteredReviewMode`, `exitedReviewMode`, `fileChange`, `hookPrompt`, `imageGeneration`,
`imageView`, `mcpToolCall`, `plan`, `reasoning`, `sleep`, `subAgentActivity`, `userMessage`,
`webSearch`. None of the sixteen "ordinary" types (everything except the two subagent-related ones
above) carries any subagent- or thread-scoping metadata at all — a `fileChange`/`commandExecution`/
etc. item run by a subagent, if it ever reached this client (see finding 3), would be
indistinguishable from a top-level one on the wire; there is no field on ANY item type this bridge
could promote into a `parentToolCallId` even if it wanted to.

### 3. A subagent's own tool calls are architecturally unreachable, not merely unlinked

This is the finding this spike adds beyond what PR #802's own doc comment (`packages/providers/
codex/src/provider.ts`) already recorded — a mechanism, not just an absence.

`CodexAcpServer.prompt()` subscribes to session events exactly once per prompt/session
(`dist/index.js:30204-30212`, `src/CodexAcpServer.ts`):

```js
await this.codexAcpClient.subscribeToSessionEvents(
  params.sessionId,
  async (event) => {
    await elicitationHandler.handleNotification(event);
    return promptEventHandler.handleNotification(event);
  },
  approvalHandler,
  elicitationHandler
);
```

`subscribeToSessionEvents` (`dist/index.js:26765-26793`, `src/CodexAppServerClient.ts`) registers
exactly one notification handler, keyed by `params.sessionId` — the ACP session's own (parent)
thread id, never any of a spawned subagent's `receiverThreadIds`:

```js
async subscribeToSessionEvents(sessionId, eventHandler, approvalHandler, elicitationHandler) {
  this.codexClient.onServerNotification(sessionId, (event) => {
    this.enqueueSessionNotification(sessionId, () => eventHandler(event));
  });
  ...
}
```

There is exactly one call site for `subscribeToSessionEvents(` in the entire bundle (confirmed by
count: two occurrences total — the method's own definition plus this one caller) — no second
subscription for a spawned subagent's own thread exists anywhere.

One level deeper: `notify()`, the dispatcher every incoming app-server notification passes through
(`dist/index.js:31089-31101`, `src/CodexAppServerClient.ts`), routes strictly by thread id and
**silently drops** a notification whose thread has no registered handler:

```js
notify(notification) {
  const threadId = extractThreadId(notification);
  if (threadId !== null) {
    const handler = this.notificationHandlers.get(threadId);
    if (handler) {
      handler(notification);
    }
    return;
  }
  for (const notificationHandler of this.notificationHandlers.values()) {
    notificationHandler(notification);
  }
}
```

Put together: even setting aside finding 1 (no field to carry a link) entirely, a spawned
subagent's own thread's `item/started`/`item/completed` notifications — the events that would
carry its own `fileChange`/`commandExecution`/etc. tool calls — have no registered handler under
this bridge's single-session subscription model and are dropped before they would ever reach
`createItemEvent`/`completeItemEvent`. There is categorically nothing to attribute a parent link to
today, not merely a missing field on what does arrive.

### 4. Contrast: what Claude Code has, for completeness (not re-derived here)

Issue #200's own PR (#802) already live-verified Claude Code's real signal against the actual
`@agentclientprotocol/claude-agent-acp` v0.65.0 npx bridge: a subagent's own nested `tool_call`/
`tool_call_update` carries `_meta.claudeCode.parentToolUseId`, pointing at the launching Agent/Task
call's own `toolCallId` — present unconditionally, regardless of client capability opt-in
(`packages/providers/claude/src/provider.ts`'s `claudeParentToolCallId` doc comment). This spike
does not re-verify that finding; it is cited here only to make the asymmetry concrete: Claude
forwards the subagent's own tool calls as distinct, linkable events, Codex does not forward them at
all.

## Impact on loombox

`@loombox/providers-codex`'s `codexProviderModule.enrich()` (`packages/providers/codex/src/
provider.ts`) is already a pass-through no-op — correct, not merely convenient, per findings 1–3
above: there is no field to promote, and even a subagent's own ordinary tool calls never reach this
adapter to promote anything from. `packages/providers/core/src/transcript.ts`'s
`computeToolCallNesting` already treats an item with `parentToolCallId === undefined` as a
genuine top-level call — `depth: 0`, indistinguishable from a real root call, which is issue #200's
own explicit design for "a session/provider without a parent link" (its acceptance criterion:
"renders flat, unchanged from v1 behavior"). `SPEC.md` §7.24's subagent-tree bullet already
documents this exact finding (landed with PR #802, cross-checked line-for-line against this spike's
own citations above — no further SPEC change needed here).

## Verdict: does the subagent tree work for Codex today, degrade gracefully, or silently render wrong?

**Degrades gracefully.** A Codex subagent's summarizing `collabAgentToolCall` tool call and its
`subAgentActivity` activity markers render as ordinary, flat, top-level tool-call rows — exactly
like any other Codex tool call, exactly matching issue #200's documented flat-fallback contract for
a provider with no parent-link signal. Nothing renders incorrectly, nothing disappears, and no
loombox-side bug was found: this is a genuine Codex-side protocol limitation (no per-child
tool-call forwarding of any kind, not merely a missing field), correctly reflected by an already-
existing no-op adapter hook and an already-existing flat-rendering fallback path. **No gap filed**
— there is nothing to fix on loombox's side; a real fix (per-tool-call nesting for Codex) is only
possible if a future `codex-acp` release starts forwarding a subagent's own tool calls as distinct
ACP events with a link back to the spawning call, which is outside this repo's control.

## Executable checks

`packages/providers/codex/src/codex-subagent-signal-capabilities.test.ts` turns every citation
above into a source-text assertion against the pinned, installed `@agentclientprotocol/
codex-acp@1.1.10` package, plus a "real-shape conformance" section that feeds
`codexProviderModule.enrich()` the real `_meta.codex.collaboration`/`_meta.codex.subagent` wire
shapes found here and `computeToolCallNesting()` the resulting items, proving — not just
documenting — that both render at `depth: 0` today.

**Regression-proof, not just pass-today:** verified by hand once — temporarily flipping the "never
emits a parentToolCallId-equivalent field" assertion's polarity (`.not.toContain('parentToolCallId')`
→ `.toContain('parentToolCallId')`) turned the suite red:

```
 ❯ src/codex-subagent-signal-capabilities.test.ts:54:28
     52|     // The two spellings a client-side promotion would actually look for
     53|     // (loombox's own field name, and Claude's vendor `_meta` name).
     54|     expect(codexAcpSource).toContain('parentToolCallId');
       |                            ^
     55|     expect(codexAcpSource).not.toContain('parentToolUseId');
AssertionError: expected '#!/usr/bin/env node\nimport { createR…' to contain 'parentToolCallId'

 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
```

Reverting the one-line edit turned it green again (`pnpm --filter @loombox/providers-codex exec
vitest run`: `Test Files  8 passed (8)`, `Tests  55 passed (55)`, the full package suite including
this new file's own 9). This is exactly the regression this assertion exists to catch: a future
`codex-acp` release that starts shipping a real parent-tool-call-shaped field would mean this
spike's "no equivalent today" finding no longer holds, and issue #200's tree-rendering work would
gain a second real provider worth wiring up — that should fail CI loudly, not pass silently.
