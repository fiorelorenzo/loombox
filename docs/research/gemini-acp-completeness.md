# Gemini CLI ACP completeness — build-time verification spike (issue #272)

**Verdict: GO, generic tier covers it today — with two concrete gaps recorded for #273 to
decide on.** Gemini CLI genuinely speaks ACP: `gemini --acp` (exactly the invocation
`packages/providers/core/src/agent-catalogue.ts`'s `gemini-cli` catalogue entry already uses)
starts a real JSON-RPC 2.0 agent over stdio, and its `initialize`/`session/new`/`session/prompt`/
`session/request_permission`/`tool_call` surface matches what `packages/providers/core` and
`@loombox/providers-generic` already assume closely enough that the zero-code generic fallback
tier — `createGenericProvider('gemini-cli', {command: 'gemini', args: ['--acp']})`, no bespoke
`enrich()` — works against it with no code changes. Nothing here blocks registering Gemini through
the generic tier today (SPEC.md §16's "verify its ACP flag at build time before promising the
module" gate). What this spike found instead: Gemini implements a strictly *smaller* slice of ACP
v1's optional session-lifecycle surface than Codex/`omp acp` do (no `session/resume`/`list`/
`close`/`delete` at all — confirmed live, not just in source), and carries one vendor extension
(`models`/`unstable_setSessionModel`) neither the official protocol nor `packages/providers/core`
know about. Both are filed as their own issues (table below) for #273, the actual adapter module,
to make a deliberate call on — a **bespoke Gemini module is not required to make basic sessions
work**, but closing either gap (session resume, or a model picker) would need one, since the
generic tier is deliberately protocol-only by design.

## Method

Issue #182's Codex spike (`docs/research/codex-acp-completeness.md`) established the precedent this
spike follows: pin the real ACP bridge as a devDependency and read its installed
`node_modules` source directly, rather than hand-copying snippets nobody can re-verify. That does
not transfer cleanly to Gemini — checked, not assumed:

```
$ npm view @google/gemini-cli dist.unpackedSize dist.fileCount
dist.unpackedSize = 97768438
dist.fileCount = 448
$ npm pack @google/gemini-cli@0.54.0 ...
google-gemini-cli-0.54.0.tgz  20691700 bytes, 448 files
```

`@google/gemini-cli` is a 20.7 MB compressed / 97.8 MB unpacked, 448-file npm package whose `bin`
(`bundle/gemini.js`) pulls in dozens of hash-named, esbuild-code-split chunks
(`bundle/chunk-2MRUXBJ5.js`, `bundle/chunk-34MYV7JD.js`, ...) — nothing like `@agentclientprotocol/
codex-acp`'s single 1.2 MB `dist/index.js`. Vendoring the whole CLI as a devDependency of
`packages/providers/gemini` for a text-grep would be disproportionate (15x the install weight
Codex's spike judged acceptable, spread across files whose hashes are not a stable citation target
run to run), so this spike used a different, arguably stronger method instead:

1. **A real, live, end-to-end run.** `npx -y @google/gemini-cli@0.54.0 --acp` was actually spawned
   and sent real JSON-RPC 2.0 requests over real stdio — no credentials or `GEMINI_API_KEY`
   configured on this box. Unlike Codex's spike (which had no real `codex` binary/login available
   and settled for source-reading: "this spike is source-verification, not a live end-to-end run"),
   Gemini's `initialize` handshake and its method dispatch table both respond *before* any
   auth-gated work happens, so this spike could observe real process behavior, not just what the
   source says it should do. Two runs: one plain `initialize`, and one `initialize` followed by a
   request to each of `session/resume`/`session/list`/`session/close`/`session/delete`/
   `session/load`/`session/new` plus a deliberately bogus `totally/bogus/method` (the JSON-RPC
   `-32601` baseline every genuinely-unimplemented method should also produce). Recorded verbatim
   into `packages/providers/gemini/test/fixtures/gemini-acp-live-probe.json` — the same recording
   convention `packages/providers/core/test/fixtures/omp-acp-session-new-response.json` already
   established for a real `omp acp` binary, applied here to a real `gemini-cli` binary instead.
2. **Real, unbundled TypeScript source, at a pinned commit.** GitHub's `v0.54.0` tag — the exact
   version `agent-catalogue.ts`'s `gemini-cli` entry is verified against, and the version this
   spike's live probe used — resolves to commit `a74b483d14a93159fa36e7ee9e32cf44bda594df`
   (`gh api repos/google-gemini/gemini-cli/git/refs/tags/v0.54.0`). Every citation below is against
   `packages/cli/src/acp/{acpRpcDispatcher,acpUtils,acpSessionManager,acpSession,
   acpFileSystemService}.ts` at that exact commit — real developer source, not an esbuild bundle,
   arguably a more direct citation than Codex's `dist/index.js` (no bundler comment-preservation
   caveat to carry).
3. **The official schema as the standard-vs-extension arbiter.** Every field this spike calls a
   Gemini-specific extension (`models`, `unstable_setSessionModel`) was cross-checked against
   `agentclientprotocol.com/protocol/v1/schema` (the same source Codex's spike used to confirm
   `AcpAgentCapabilities`'s real shape) to confirm it genuinely isn't part of ACP v1, not just
   absent from loombox's own types.

`packages/providers/gemini/src/gemini-acp-capabilities.test.ts` turns the recording into executable
assertions: it reads the frozen fixture (not a live spawn — CI stays offline and deterministic,
per this repo's own "tests must not depend on what happens to be installed on this box" rule) and
proves today's `deriveFeatureFlags`/`@loombox/providers-generic` behavior against it. Re-verifying
against a future `gemini-cli` release means re-running the live probe by hand and refreshing both
the fixture and the test's `VERIFIED_GEMINI_CLI_VERSION` pin — the same deliberate, human-gated
re-verification Codex's exact version pin enforces, just via a refreshed recording instead of a
bumped `package.json` range.

**No devDependency added.** `packages/providers/gemini/package.json` gained two ordinary workspace
dependencies (`@loombox/providers-core`, `@loombox/providers-generic`, both already regular
dependencies of every other provider package) to exercise their real functions against the
recording — nothing pulls the 97.8 MB CLI package itself into this repo's `node_modules`.

## Capability-by-capability findings

### 1. `initialize` — agent capabilities Gemini CLI actually advertises

Real, live response (protocol handshake only, no auth):

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "gemini-cli", "title": "Gemini CLI", "version": "0.54.0" },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true }
  }
}
```

Byte-identical to the object `initialize()` literally returns in source
(`acpRpcDispatcher.ts`'s `GeminiAgent.initialize`, commit `a74b483d`).

**Confirmed accurate:** `promptCapabilities.image: true`/`embeddedContext: true` are exactly what
`packages/providers/core/src/capabilities.ts`'s `deriveFeatureFlags` and
`packages/providers/core/src/image.ts`'s `buildInlineImageContentBlock` read
(`prompt?.image`/`prompt?.embeddedContext`) — and, going one level deeper than the capability flag,
Gemini's real inbound prompt parser (`acpSession.ts`'s `#resolvePrompt`, commit `a74b483d`, lines
963–970) accepts exactly the wire shape loombox's builder emits:

```js
case 'image':
case 'audio':
  return { inlineData: { mimeType: part.mimeType, data: part.data } };
```

— no `uri` required, same `{type, data, mimeType}` shape the Codex spike already confirmed for
Codex's inbound side. `mcpCapabilities.http`/`.sse` also match what `packages/providers/core/src/
mcp-config.ts` and `types.ts` gate `McpHttpServerConfig`/`McpSseServerConfig` on (grepped: nothing
in this codebase reads `mcpCapabilities.acp`, the one sub-field Gemini's response omits alongside
`sessionCapabilities`, so its absence is a non-issue).

**New capability, not previously exercised by any cataloged agent:** `promptCapabilities.audio:
true`. Neither Codex (`docs/research/codex-acp-completeness.md`'s recorded `agentCapabilities` has
no `audio` key at all) nor the real `omp acp` recording (`test/fixtures/
omp-acp-session-new-response.json`) ever set this true — Gemini is the first real, cataloged agent
that does. `deriveFeatureFlags`'s `supportsAudio` flag already exists and derives correctly
(`prompt?.audio ?? false`), but there is no `AcpAudioContentBlock` type and no attach-audio UI
anywhere in this codebase yet — not a gap against an assumption core makes, since SPEC.md's own
roadmap already places "BYO-key voice" in **v3** ("voice & reach"), after the Gemini module itself
(v2). Recorded here for completeness, not filed as a gap: nothing currently claims audio input
works, so nothing is currently wrong.

**Real Gemini gap (filed as #843):** `agentCapabilities.sessionCapabilities` is **entirely absent**
— not `{}`, not partially populated, just missing from the object, confirmed both in the live
response above and in source (the literal return statement in `initialize()` has no
`sessionCapabilities` key). This is despite `loadSession: true` being set. See finding #2 below for
what that means in practice.

### 2. Session lifecycle — `session/new` works; every other lifecycle method does not (filed as #843)

`session/new`'s request/response shape is unremarkable and correct: `AcpSessionManager.newSession`
(`acpSessionManager.ts`, commit `a74b483d`) takes `{cwd, mcpServers}` exactly as
`packages/providers/core/src/client.ts`'s `newSession()` sends, and returns `{sessionId, modes,
models}` — `sessionId` and `modes` are read correctly by `mapConfigOptions` (see finding #7 for
`models`, which isn't). Live-probed (`session/new` with `{cwd: '/tmp', mcpServers: []}`, no auth
configured): `-32000 "Gemini API key is missing or not configured."` — a real, implemented method
correctly rejecting on missing credentials, not `-32601`. **No gap here.**

Every other ACP v1 session-lifecycle method is a different story. Live-probed against the real
`npx -y @google/gemini-cli@0.54.0 --acp` process, immediately after `initialize`, no session
created yet:

| method sent | real response |
|---|---|
| `session/resume` | `-32601 "Method not found": session/resume` |
| `session/list` | `-32601 "Method not found": session/list` |
| `session/close` | `-32601 "Method not found": session/close` |
| `session/delete` | `-32601 "Method not found": session/delete` |
| `session/load` | `-32000 Authentication required` (implemented) |
| `totally/bogus/method` (baseline) | `-32601 "Method not found": totally/bogus/method` |

The four session-lifecycle methods return the **exact same JSON-RPC error code as the deliberately
bogus method name** — genuinely unimplemented, not merely erroring on missing auth or bad params
the way `session/new`/`session/load` do. Confirmed in source: `GeminiAgent`
(`acpRpcDispatcher.ts`) implements exactly `initialize`/`authenticate`/`newSession`/`loadSession`/
`cancel`/`prompt`/`setSessionMode`/`unstable_setSessionModel` — no `resumeSession`/`listSessions`/
`closeSession`/`deleteSession` method exists on the class at all, so there is nothing for the ACP
SDK's dispatcher to route those four method names to. This lines up exactly with finding #1's
`sessionCapabilities` being entirely absent: `resume`/`list`/`close`/`delete` genuinely aren't
capabilities Gemini forgot to advertise, they're capabilities it doesn't have. `loadSession: true`
gates the one lifecycle method it *does* keep — ACP v1's older, since-superseded `session/load`.

`packages/providers/core/src/client.ts`'s `resumeSession()` sends **only** `session/resume`
(confirmed by reading it: no `session/load` call anywhere in this codebase — issue #821 already
established `session/load` gates a different, older method than the one this client actually
calls). `deriveFeatureFlags` already derives `supportsResume: false`/`supportsAdditionalDirectories:
false`/`supportsSessionDelete: false` correctly for Gemini's real capabilities (no bug — issue
#821's fix reads the right, real fields). But concretely: **a Gemini session can never be resumed,
listed, closed, or explicitly deleted through loombox's client as it exists today.** Filed as #843
for #273 to decide: build a `session/load` fallback path, or accept it as a documented Gemini
limitation.

### 3. `tool_call` — kind and diff shapes

Real Gemini `Kind` values map straight onto ACP's `ToolKind` (`acpUtils.ts`'s `toAcpToolKind`,
commit `a74b483d`):

```js
export function toAcpToolKind(kind) {
  switch (kind) {
    case Kind.Read: case Kind.Edit: case Kind.Execute: case Kind.Search:
    case Kind.Delete: case Kind.Move: case Kind.Think: case Kind.Fetch:
    case Kind.SwitchMode: case Kind.Other:
      return kind;
    case Kind.Agent:
      return 'think';
    case Kind.Plan: case Kind.Communicate: default:
      return 'other';
  }
}
```

Eight of the nine values `packages/providers/core/src/types.ts`'s `AcpToolKind` already declares
(`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`) are covered.
**Corroborates issue #822 (Codex spike's finding, not re-filed as a new issue):** Gemini also
passes through `Kind.SwitchMode` as the literal ACP `switch_mode` value — a second real, currently
shipping agent that can send a `ToolKind` `AcpToolKind`'s type union doesn't have a member for
(comment left on #822 with this citation). `packages/providers/gemini/src/
gemini-acp-capabilities.test.ts` proves `@loombox/providers-generic`'s `classifyGenericToolKind`
already handles it fine at runtime (it's a plain `toolKind ?? 'other'` passthrough) — only the
static type is behind, same fix as #822 already describes.

Diff shape: Gemini's tool-call content carries a diff as one `{type: 'diff', path, oldText,
newText, _meta: {kind}}` entry inside a `content: ToolCallContent[]` array
(`acpUtils.ts`'s `toToolCallContent`, commit `a74b483d`) — exactly the shape issue #623 already
taught `packages/providers/core/src/client.ts`'s `extractDiff` to read (`content[]` entries of
`type: 'diff'`, lifted onto a flat `.diff` field). Gemini's extra `_meta.kind` (`'add'`/`'delete'`/
`'modify'`) is simply additional data `extractDiff` doesn't read and doesn't need to — **no gap
here**, this half of the surface is already solid, verified against a second real agent.

### 4. `session/request_permission` — the real Gemini button vocabulary

`toPermissionOptions` (`acpUtils.ts`, commit `a74b483d`) always appends a fixed
`basicPermissionOptions` pair:

```js
const basicPermissionOptions = [
  { optionId: ToolConfirmationOutcome.ProceedOnce, name: 'Allow', kind: 'allow_once' },
  { optionId: ToolConfirmationOutcome.Cancel, name: 'Reject', kind: 'reject_once' },
];
```

— then, per confirmation type (`edit`/`exec`/`mcp`/`info`), conditionally prepends one or two
`allow_always`-kind options ("Allow for this session", plus a persistent "Allow ... in all future
sessions" variant gated on a local Gemini setting, `enablePermanentToolApproval`; `mcp` can add two
distinct `allow_always` options at once — "Allow all server tools for this session" *and* "Allow
tool for this session"). **Gemini never sends a `reject_always`-kind option at all** — there is no
"always deny" affordance anywhere in its real option builder.

All four real `kind` values it does use (`allow_once`/`allow_always`/`reject_once`) are already
covered by `packages/providers/core/src/types.ts`'s `AcpPermissionOptionKind`. `@loombox/
providers-generic`'s `mapGenericPermissionOptions` — which reads *only* `kind`, never `optionId`/
`name` text, by design (SPEC.md §7.24: the generic tier has no bespoke-agent vocabulary to
recognize) — already handles any subset of the four kinds correctly, including one that omits
`deny_always` entirely (its own doc comment already documents this exact case). `packages/
providers/gemini/src/gemini-acp-capabilities.test.ts` proves it against Gemini's real
`edit`/`exec`-type button set (`allow_always`+`allow_once`+`reject_once` → `['allow_always',
'allow', 'deny']`). **No gap** — the generic tier's deliberately narrow, kind-only reading is
exactly what makes it robust here, where Codex's bespoke text-pattern classifier (issue #820) was
not.

### 5. Image/audio content blocks and embedded context — the inline hand-off

Already cited under finding #1: `#resolvePrompt`'s `case 'image': case 'audio':` branch
(`acpSession.ts`, commit `a74b483d`, lines 963–970) accepts the plain `{type, data, mimeType}` block
`packages/providers/core/src/image.ts`'s `buildInlineImageContentBlock` emits — unified with the
Codex/`omp acp` shape the earlier spike already confirmed. `#resolvePrompt` also handles
`case 'resource':` (pushed onto an `embeddedContext` array, then referenced by `@<uri>` text) and
`case 'resource_link':` (resolved via `file://` scheme or `@<uri>` text) — both real, both matching
what `promptCapabilities.embeddedContext: true` promises. **No gap.**

### 6. MCP capabilities

`mcpCapabilities: {http: true, sse: true}`, no `acp` sub-field. `packages/providers/core/src/
mcp-config.ts`/`types.ts` only ever gate `McpHttpServerConfig`/`McpSseServerConfig` on `.http`/
`.sse` (grepped: nothing reads `.acp`) — full parity, **no gap**.

### 7. Gemini-only extension: `models` / `unstable_setSessionModel` (filed as #844)

`session/new`'s real response is `{sessionId, modes: {...}, models: {availableModels,
currentModelId}}` — a `models` sub-object structurally identical in shape to the official `modes`
sub-object (`{available*, current*Id}`), built by `buildAvailableModels`
(`acpUtils.ts`, commit `a74b483d`) and changed via the separate `unstable_setSessionModel` method
(`acpRpcDispatcher.ts`). **Neither is part of ACP v1**: `agentclientprotocol.com/protocol/v1/schema`
lists `NewSessionResponse`'s only fields as `_meta`/`configOptions`/`modes`/`sessionId` (no
`models`) and has no `set_session_model` method in its method index at all — the `unstable_` prefix
on Gemini's own method name says the same thing from the other side. It rides on ACP's
"extra fields are fine" permissiveness as a pure vendor extension.

`packages/providers/core/src/client.ts`'s `RawConfigCatalog` (the type `mapConfigOptions` reads) is
`{configOptions?, modes?}` — no `models?` field, and nothing in this codebase reads `wire.models`
anywhere. `modes` gets folded into a synthesized `configOptions` entry (`category: 'mode'`)
specifically because it is the ACP-baseline axis; `models` has no equivalent because no previously
verified agent (Claude, Codex, `omp acp`) has anything like it. Concretely: **loombox's `ConfigBar`
has no way to show or change which Gemini model a session is using**, even though Gemini's own
response advertises the exact same `{available*, current*Id}` shape for both axes side by side.
This is *correct*, protocol-respecting behavior for `packages/providers/core` (a client SHOULD NOT
special-case an unstable vendor field) — not a bug — but it is a real product gap specific to
Gemini, filed as #844 for #273 to decide whether it's worth a bespoke `enrich()` hook.

## Verdict: does loombox need a Gemini-specific adapter, or does `generic` cover it?

**`generic` covers Gemini's baseline session/prompt/tool-call/permission/image loop today, with no
code changes needed.** Every capability `packages/providers/core`'s `AcpClient` and `@loombox/
providers-generic`'s permission/tool-kind/image helpers assume — `session/new`'s request/response
shape, inline image (and now audio) content blocks, embedded-context resources, the diff shape
inside `tool_call` content, the four-kind permission vocabulary — either matches Gemini's real wire
behavior exactly, or degrades the exact way the generic tier is designed to degrade (an omitted
`reject_always` simply produces no deny-always button; `switch_mode` already classifies fine at
runtime despite the type gap). `AGENT_CATALOGUE`'s existing `gemini-cli` entry (`command: 'gemini',
args: ['--acp']`, verified 2026-08-06 against this exact `0.54.0` release) is independently
corroborated by this spike's live run — the invocation is correct.

**A bespoke Gemini adapter module becomes worth building the moment loombox wants either of the two
things generic cannot, by design, provide:** session resume/list/close/delete (#843 — impossible
today regardless of adapter, since the real binary doesn't implement the methods; the only fix
available is a core-level `session/load` fallback, not a provider-level one) or a model-switcher UI
(#844 — possible only via a bespoke `enrich()`/UI hook reading Gemini's non-standard `models`
field, which the zero-code generic tier deliberately never will). Until then, registering
`gemini-cli` through the generic tier is a real, working, zero-adapter path — the go/no-go this
spike was asked to answer is: **go, register it generic-tier now; build #273 only once one of
those two gaps needs closing.**

## Gaps filed

| # | Title | Priority | Scope |
|---|---|---|---|
| [#843](https://github.com/fiorelorenzo/loombox/issues/843) | Gemini CLI implements no ACP v1 session-lifecycle methods except the deprecated `session/load` — `session/resume` never works for it | P1 | `packages/providers/core/src/client.ts` (no fallback path), future `#273` |
| [#844](https://github.com/fiorelorenzo/loombox/issues/844) | Gemini's `session/new` response carries a vendor `models` axis (paired with `unstable_setSessionModel`) that `mapConfigOptions` never reads — no model switcher for Gemini | P2 | `packages/providers/core/src/client.ts`, future `#273` |

Both are labeled `area:providers` and reference this spike; they still need parenting to epic #19
on the GitHub Project board (a board-write step outside this spike's scope, same as #182 left for
its own four gaps).

Issue #822 (Codex spike's `AcpToolKind` `switch_mode` gap) got a corroborating comment
([here](https://github.com/fiorelorenzo/loombox/issues/822#issuecomment-5211061602)) rather than a
duplicate filing — this spike independently found the same gap against a second real agent.

## Executable checks

`packages/providers/gemini/src/gemini-acp-capabilities.test.ts` turns every citation above into an
assertion against `packages/providers/gemini/test/fixtures/gemini-acp-live-probe.json` — the real,
recorded JSON-RPC traffic described in the Method section — plus a "real-shape conformance" section
feeding `@loombox/providers-core`'s `deriveFeatureFlags` and `@loombox/providers-generic`'s
`mapGenericPermissionOptions`/`classifyGenericToolKind` the real capability/button/tool-kind shapes
found here.

**Regression-proof, not just pass-today:** verified by hand once — temporarily flipping the
`sessionCapabilities` absence assertion (`initialize: agentCapabilities Gemini CLI actually
advertises > [real Gemini gap] advertises NO sessionCapabilities field at all...`) from
`.toBeUndefined()` to `.toBeDefined()` turns the suite red:

```
 FAIL  src/gemini-acp-capabilities.test.ts > real gemini-cli --acp source/wire (issue #272 build-time
  verification spike) > initialize: agentCapabilities Gemini CLI actually advertises > [real Gemini
  gap] advertises NO sessionCapabilities field at all, despite loadSession: true
AssertionError: expected undefined to be defined
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 8 passed (9)
```

Reverting the one-line edit turns it green again (`Test Files 2 passed (2)`, `Tests 9 passed (9)`).
Exactly this scenario — a future Gemini CLI release that starts advertising real
`sessionCapabilities` — is the regression this assertion exists to catch: it would mean #843's
"session/resume never works for Gemini" finding no longer holds, which should be loud, not silent.
