# OpenCode ACP completeness — build-time verification spike (issue #285)

**Verdict: GO, generic tier covers it today, with zero core changes required for OpenCode
specifically.** OpenCode (`opencode-ai` on npm, `anomalyco/opencode` on GitHub, MIT-licensed)
genuinely speaks ACP: `opencode acp` starts a real JSON-RPC 2.0 agent over stdio, and this spike
ran a full, live, end-to-end session against it — `initialize`, `session/new`, real `bash`/
`write`/`read`/`edit` tool calls with a real diff, a real `session/request_permission` round
trip, real `session/set_config_option` model/mode changes, and a real `session/resume`/
`session/list`/`session/close` round trip — the fullest live session either of the two precedent
spikes (#182 Codex, #272 Gemini) recorded. Every capability `packages/providers/core` and
`@loombox/providers-generic` assume matches OpenCode's real wire behavior exactly, so
`createGenericProvider('opencode', {command: 'opencode', args: ['acp']})`, no bespoke `enrich()`,
works against it with no code changes — the same "near-free" registration SPEC.md §5.5 promises
for a future ACP agent. The one real finding this spike produced is not OpenCode-specific at all:
it is a pre-existing bug in `packages/providers/core`'s own `resumeSession()` that this spike is
the first to actually exercise live (Codex's spike had no live binary; Gemini's real binary never
implements `session/resume` at all), filed as its own issue (#957, table below) rather than fixed
here, per the same non-goal the Codex and Gemini spikes both stated for their own findings.

## Candidate selection

Issue #285 asks which provider to spike, not just how. Three real, currently-shipping,
ACP-speaking CLI agents beyond the four already cataloged (Claude Code, Codex, Gemini CLI,
Qwen Code — `packages/providers/core/src/agent-catalogue.ts`) were considered:

- **OpenCode** (`anomalyco/opencode`) — native `opencode acp` (checked against its own docs,
  `opencode.ai/docs/acp`), MIT-licensed, actively released (11,849 published `opencode-ai` npm
  versions as of this spike — `npm view opencode-ai versions --json | length`), and explicitly
  named as the example candidate in two places already in this repo: SPEC.md §5.5's own text
  ("adding a future ACP agent (OpenCode-family, etc.) near-free") and issue #286's own body
  ("an OpenCode-family agent or equivalent confirmed by the verification spike"). It BYO-keys
  against 75+ model providers (its own docs' `meta-keywords`), which is the actual shape of
  "provider reach" the v3 milestone names — a loombox user who already has Claude/Codex/Gemini
  configured would plausibly add OpenCode specifically to reach a provider none of those three
  cover (DeepSeek, GLM, Qwen-via-a-different-host, etc.) through one more CLI, not to replace any
  of them. It also ships a genuinely free tier (OpenCode Zen) that answers `initialize`/
  `session/new`/`session/prompt` with **no API key or login configured at all** — the only one of
  the three candidates below this spike could actually drive live, end to end, on this box.
- **Cursor CLI** (`cursor.com/docs/cli/acp`, `agent acp`) — also real and ACP-speaking (checked,
  not assumed: Cursor's own docs page and its March 2026 JetBrains-integration announcement both
  confirm a real `agent acp` bridge). Ruled out on two grounds, not just one: (1) it requires a
  paid Cursor account ("The Cursor ACP is free for all users on **paid** plans" — Cursor's own
  blog post) — the opposite of loombox's self-hosted/BYO-key posture (SPEC.md §3/§11), and not
  testable on this box without a subscription; (2) Cursor's own community forum has an open
  feature request as of March 2026 ("ACP: support `session/list` method... Session capabilities is
  not included in the response to initialize method") — i.e., Cursor's own users report its ACP
  session-lifecycle surface is still incomplete, a materially weaker starting point than OpenCode,
  which this spike found to have the fullest session-lifecycle support of any agent verified so
  far (see Finding 2).
- **GitHub Copilot CLI** (`copilot --acp --stdio`, `docs.github.com/en/copilot/reference/acp-server`)
  — real ACP support, but gated on a paid GitHub Copilot subscription, same objection as Cursor,
  and not a CLI a self-hosted-first loombox user would reach for ahead of the four already-free
  agents this repo already supports.

OpenCode is the only candidate that is simultaneously open-source, free-tier-testable with zero
credentials on this exact devbox, explicitly named by this repo's own prior art, and aimed at the
actual "provider reach" gap v3 exists to close. This spike proceeded with OpenCode.

## Method

Unlike Codex's spike (a pinned `node_modules` devDependency read) or Gemini's spike (no useful
devDependency, so a live recording plus GitHub source at a pinned commit), `opencode-ai`'s own npm
package is neither: `npm pack opencode-ai@1.18.16` is a 3.0 kB tarball / 7.9 kB unpacked, exactly
4 files (`LICENSE`, `bin/opencode.exe`, `package.json`, `postinstall.mjs`) — checked, not assumed.
`postinstall.mjs` downloads a compiled, platform-specific binary at install time; there is no
bundled JS/TS source to vendor as a devDependency at all, unlike Codex's single-file
`dist/index.js`. This spike combined both precedents' methods instead:

1. **A real, live, end-to-end run — the fullest of the three spikes.** `opencode-ai@1.18.16` was
   installed for real (`npm install opencode-ai@1.18.16`, which runs the real `postinstall.mjs`
   and downloads the real platform binary), and `opencode acp` was actually spawned and driven
   through real JSON-RPC 2.0 over stdio, no `OPENCODE_API_KEY`/login configured. OpenCode's own
   free "OpenCode Zen" model tier answers `session/prompt` with no auth at all — unlike Codex/
   Claude (no live binary/credentials available) and going further than Gemini's spike (which
   could reach `initialize` and a method-probe battery, but hit an auth wall before `session/new`
   could actually succeed). Six separate recording runs, each spawning a fresh `opencode acp`
   process, cover: `initialize` + a method-probe battery (`session/resume`/`list`/`close`/
   `delete`/`load` against a not-yet-created session, plus a deliberately bogus method as the
   JSON-RPC `-32601` baseline); a bare `session/new`; a real `bash`+`write` then `read`+`edit`
   tool-call sequence (the second turn producing a real unified diff); a
   `session/request_permission` round trip (forced via OpenCode's own documented
   `{"permission": {"*": "ask"}}` project config, `opencode.ai/docs/permissions` — its
   **default** config is permissive `"allow"`, which is why the tool-call recording above never
   triggered one); a `session/set_config_option` round trip for both the `model` and `mode`
   categories; and a full `session/resume`/`session/list`/`session/close` round trip against a
   session that genuinely existed. Recorded verbatim into
   `packages/providers/opencode/test/fixtures/opencode-acp-live-probe.json` — the same recording
   convention `gemini-acp-live-probe.json` and `packages/providers/core/test/fixtures/
   omp-acp-session-new-response.json` already established.
2. **Real, unbundled TypeScript source, at a pinned commit.** GitHub's `v1.18.16` tag — the exact
   version this spike's live probe used — resolves to commit
   `a3647eb025c7615159d417dcc49fc39fdaeba65b` (`gh api
   repos/anomalyco/opencode/git/refs/tags/v1.18.16`). Every citation below is against
   `packages/opencode/src/acp/{service,agent,content,permission,tool,config-option}.ts` at that
   exact commit — real developer source (no esbuild bundle to carry a comment-preservation
   caveat), fetched directly via `gh api repos/anomalyco/opencode/contents/... ?ref=v1.18.16`.

`packages/providers/opencode/src/opencode-acp-capabilities.test.ts` turns the recording into
executable assertions: it reads the frozen fixture (not a live spawn — CI stays offline and
deterministic, per this repo's own "tests must not depend on what happens to be installed on this
box" rule) and proves today's `deriveFeatureFlags`/`@loombox/providers-generic`/`reduceTranscript`
behavior against it. Re-verifying against a future `opencode-ai` release means re-running the live
recording by hand and refreshing both the fixture and the test's `VERIFIED_OPENCODE_AI_VERSION`
pin — the same deliberate, human-gated re-verification both precedent spikes established.

**No devDependency added.** `packages/providers/opencode/package.json` gained two ordinary
workspace dependencies (`@loombox/providers-core`, `@loombox/providers-generic`, both already
regular dependencies of every other provider package) to exercise their real functions against
the recording — nothing pulls the downloaded OpenCode binary itself into this repo's
`node_modules` or CI.

## Capability-by-capability findings

### 1. `initialize` — agent capabilities OpenCode actually advertises

Real, live response (protocol handshake only, no auth):

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
  },
  "authMethods": [{ "id": "opencode-login", "name": "Login with opencode", "description": "..." }],
  "agentInfo": { "name": "OpenCode", "version": "1.18.16" }
}
```

Byte-identical to the object `initialize()` literally returns in source (`service.ts:112-136`,
commit `a3647eb0`).

**Confirmed accurate:** `promptCapabilities.image: true`/`embeddedContext: true` are exactly what
`packages/providers/core/src/capabilities.ts`'s `deriveFeatureFlags` and `image.ts`'s
`buildInlineImageContentBlock` read. `mcpCapabilities.http`/`.sse` also match what
`packages/providers/core/src/mcp-config.ts`/`types.ts` gate `McpHttpServerConfig`/
`McpSseServerConfig` on — no `mcpCapabilities.acp` sub-field, same as Gemini, still a non-issue
(nothing in this codebase reads it).

**`sessionCapabilities` is real and populated — unlike Gemini, more like Codex/`omp acp`.**
`close`/`fork`/`list`/`resume` are all genuinely present (each an empty object, per ACP's own
"mere presence means supported" convention, `types.ts`'s own `AcpSessionCapabilities` doc
comment). `delete` and `additionalDirectories` are genuinely absent — confirmed both in the live
response above and in source: `Agent`'s real method list (`agent.ts:32-86`, commit `a3647eb0`)
implements exactly `initialize`/`authenticate`/`newSession`/`loadSession`/`listSessions`/
`resumeSession`/`closeSession`/`unstable_forkSession`/`setSessionConfigOption`/`setSessionMode`/
`unstable_setSessionModel`/`prompt`/`cancel` — no `deleteSession` method exists on the class at
all, so there is nothing for the ACP SDK's dispatcher to route `session/delete` to.

**New, real, unread capability field — not a bug, already anticipated.** `sessionCapabilities.fork`
is a genuine field on OpenCode's real response (`service.ts:126`, backed by a real
`unstable_forkSession` method and a real `session/fork` SDK call, `service.ts:356-398`). Nothing
in `packages/providers/core` reads it — but `types.ts`'s `AcpSessionCapabilities` doc comment
already says so explicitly: *"`fork` exists on the real object too but nothing in this codebase
reads it yet, so it's left off rather than typed and ignored."* OpenCode is simply the first live,
cataloged agent this repo has actually observed sending it. Not filed as a gap: nothing currently
claims session forking works, so nothing is currently wrong (SPEC.md has no session-fork/-branch
affordance on its roadmap).

### 2. Session lifecycle — the fullest live round trip of any spike so far; `session/delete` genuinely unimplemented

Live-probed against a not-yet-created session (immediately after `initialize`, mirroring Gemini's
spike's own baseline):

| method sent | real response |
|---|---|
| `session/resume` | `-32603` "Internal error: OpenCode service failure" (real method, real session-not-found failure — not "Method not found") |
| `session/list` | `{"sessions": []}` |
| `session/close` | `{}` (idempotent no-op for an unknown id — confirmed in source, `service.ts:341-349`: `closeSession` calls `session.remove(...)`, returns `{}` either way) |
| `session/delete` | `-32601 "Method not found": session/delete` |
| `session/load` | `-32603` "Internal error: OpenCode service failure" (real method, same not-found-session failure) |
| `totally/bogus/method` (baseline) | `-32601 "Method not found": totally/bogus/method` |

Only `session/delete` returns the same code as the deliberately bogus method — genuinely
unimplemented, exactly matching finding 1's `sessionCapabilities` omission.

**Then, unlike either precedent spike, this one actually completed the round trip against a real
session.** A session was opened (`session/new`), given one real turn (`session/prompt`), then
genuinely resumed (`session/resume` with the real `sessionId`+`cwd`), listed (`session/list`,
returning the real session with a real `title`/`updatedAt` OpenCode itself generated from the
turn), and closed (`session/close`) — all three succeeding for real, not just answering with a
schema-shaped error. Neither Codex's spike (no live binary at all) nor Gemini's spike
(`session/resume`/`list`/`close` are all genuinely unimplemented on the real Gemini binary, issue
#843) could exercise this path against a real agent; this is the first time
`AcpClient.resumeSession`'s actual `session/resume` branch (not its `session/load` fallback) has
been run against a real, live, full-lifecycle ACP agent.

**Real gap found, but not OpenCode-specific (filed as #957):** doing so surfaced that
`resumeSession()`'s `session/resume` request (`client.ts`, currently ~lines 983-989) never sends
`mcpServers`, despite the method's own doc comment claiming it is ("`session/load`'s `mcpServers`
is required where `session/resume`'s is optional — sent either way, defaulting to `[]`") and
despite it being a real, optional ACP v1 schema field (Codex's own spike already cited
`zResumeSessionRequest`'s real shape: `sessionId+cwd+additionalDirectories?+mcpServers?`).
OpenCode's real `resumeSession` handler (`service.ts:292-328`) reads `params.mcpServers ?? []` and
uses it to re-register the resumed session's MCP servers (`registerMcpServers`, `service.ts:318`)
— since loombox never sends that field, a resumed OpenCode session's project-configured MCP
servers silently never get re-registered through this path. This is a pre-existing core bug this
spike is simply the first to observe live, not a gap in OpenCode's own ACP support — filed as
#957 rather than fixed here, per this issue's own non-goal (mirrors Codex's spike explicitly
stating "filed as its own issue... rather than fixed here").

`deriveFeatureFlags` already derives `supportsResume: true` correctly for OpenCode (via the real
`sessionCapabilities.resume`, not the `session/load` fallback path Gemini needs) —
`supportsAdditionalDirectories`/`supportsSessionDelete: false` are both honest too. **No capability
reporting bug** — this is a live behavior gap (#957) below the capability-reporting layer, not a
misreported flag.

### 3. `tool_call` — kind mapping and diff shape

OpenCode's real `toToolKind` (`tool.ts:38-71`, commit `a3647eb0`) keys off the tool's own **name**
(lowercased), not a vendor `Kind` enum the way Gemini/Codex's mappers do:

```js
export function toToolKind(toolName) {
  switch (toolName.toLocaleLowerCase()) {
    case "bash": case "shell": return "execute"
    case "webfetch": return "fetch"
    case "edit": case "apply_patch": case "patch": case "write": return "edit"
    case "grep": case "glob": case "context": case "context7_resolve_library_id":
    case "context7_get_library_docs": return "search"
    case "read": return "read"
    case "task": return "think"
    default: return "other"
  }
}
```

Only 6 of ACP v1's 10 real `ToolKind` values are ever emitted (`execute`/`fetch`/`edit`/`search`/
`read`/`think`, plus `other`) — narrower than Gemini/Codex, but every one already a member of
`AcpToolKind`'s declared union (`types.ts`). **Unlike both precedent spikes, this one found no new
`AcpToolKind` gap** — OpenCode never sends `delete`/`move`/`switch_mode` at all (name-keyed, not
enum-passthrough, so there is no vendor enum value to leak through unmapped).

Live-recorded, real sequence for a two-turn `bash`→`write` then `read`→`edit` session: each tool
call's `tool_call` (creates) carries `{toolCallId, title, kind, status: 'pending', locations,
rawInput}`; each `tool_call_update` carries the same shape plus, on completion, `content`. **One
real, previously-unexercised case:** the terminal `tool_call_update` (`status: 'completed'`)
consistently omits `kind` entirely (confirmed live, all four completions in the recording). This
exercises `packages/providers/core/src/transcript.ts`'s `reduceToolCall`'s own patch-merge rule
(`toolKind: update.toolKind ?? existing.toolKind`) against a real agent that genuinely relies on
it for the first time — **already correct, confirmed live, not a gap.**

Diff shape, from the `edit` tool call's completion: `content: [{type: 'content', ...}, {type:
'diff', path, oldText, newText}]` — byte-identical to what `diffContent` (`tool.ts:325-338`,
commit `a3647eb0`) literally builds, and exactly the shape `client.ts`'s `extractDiff` already
reads (issue #623's shape, re-confirmed against a third real agent). Real recorded values:
`oldText: 'done'`, `newText: 'done\nedited'`. **No gap.**

### 4. `session/request_permission` — the real, fixed OpenCode button vocabulary

`permissionOptions` (`permission.ts:20-24`, commit `a3647eb0`) is a **literal, unconditional
three-entry array** — not built conditionally per confirmation type the way Gemini's/Codex's real
option builders are:

```js
const permissionOptions = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]
```

Live-confirmed byte-identical (forced via a project `{"permission": {"*": "ask"}}` config —
OpenCode's own **default** config is permissive `allow`, which is why none of this spike's other
tool-call recordings ever triggered a real permission request). All three `kind` values are
already covered by `AcpPermissionOptionKind`; **OpenCode never sends `reject_always` at all, by
construction** — the simplest, narrowest real option set of any agent verified so far, and a
strict subset of what `@loombox/providers-generic`'s `mapGenericPermissionOptions` (kind-only,
never `optionId`/`name` text, by design) already handles correctly. **No gap.**

### 5. Config options (model/mode/effort) — the best case of any spike so far

OpenCode's real `session/new` response carries `configOptions` in the **standard ACP shape
natively** — `{id, name, category, type: 'select', currentValue, options: [{value, name}]}` —
*not* a vendor `models`/`modes` sub-object the way Gemini's real response does (finding 7 of
`docs/research/gemini-acp-completeness.md`). Confirmed live: the real `model` entry is
`{id:'model', category:'model', type:'select', currentValue:'opencode/big-pickle', options: [8
free "OpenCode Zen" models]}`; the real `mode` entry is `{id:'mode', category:'mode',
type:'select', currentValue:'build', options:['build','plan']}` — both parsed correctly, unmodified,
by `client.ts`'s existing `mapConfigOptions` (its baseline `wire.configOptions` branch, not either
`wire.modes`/`wire.models` fallback synthesis).

**Live-verified: both `model` and `mode` genuinely switch through the single, standard
`session/set_config_option` method** — no vendor `unstable_setSessionModel` fallback needed at all,
unlike Gemini (issue #844, where `session/set_config_option` for `model` doesn't exist on the real
`GeminiAgent` class). OpenCode's real `setSessionConfigOption` (`service.ts:400-455`, commit
`a3647eb0`) explicitly branches on `params.configId === 'model'`/`'effort'`/`'mode'`, all three
inside the one standard method. Sent exactly the request `AcpClient.setConfigOption` builds
(`{sessionId, configId: 'mode', value: <newValue>, type: 'select'}`), the real response's
`configOptions[].currentValue` genuinely changed (`build` → `plan`; `opencode/big-pickle` →
`opencode/deepseek-v4-flash-free`) — a real, live, working model AND mode switcher through
loombox's existing generic-tier code, with zero core changes and no vendor branch. As a bonus, the
model change surfaced a third real config-option category, `{id:'effort', category:'thought_level',
type:'select', options:['low','high','max']}` — `client.ts`'s own doc comment for
`setConfigOption` already anticipates exactly this `id`≠`category` case by name ("its `thinking`
option has `id: "thinking"` but `category: "thought_level"`"), and it round-trips correctly here
too, unexercised live until now. **No gap anywhere in this surface.**

### 6. Image/`resource_link` content — wire-compatible, model-capability-limited

OpenCode's real `contentBlockToParts` (`content.ts:30-117`, commit `a3647eb0`) accepts an inbound
`image` content block with `block.data` set (no `uri` required) and builds a `data:${mimeType};
base64,${data}` file part — the exact `{type:'image', data, mimeType}` shape
`buildInlineImageContentBlock` already emits, with no `uri`, unified with the Claude/Codex/Gemini
shape all three prior verifications already confirmed. `resource_link` with a `file://` URI
resolves via a real local file read (`uriToFilePart`, `content.ts:159-188`).

**Live-sent, not just source-read — but the semantic claim is only partially verifiable on this
box.** A real 1×1 PNG was sent as an inline `AcpImageContentBlock` in a real `session/prompt`; the
turn completed cleanly with `stopReason: 'end_turn'` and no protocol-level error at any layer —
confirming the wire shape itself is accepted without incident. What could **not** be verified live:
whether the connected model actually *sees* the image — this box's zero-credential "OpenCode
Zen/Big Pickle" free default model replied "This model doesn't support image input," a model
capability limit, not a protocol failure (a different free Zen model may support vision; not
checked, out of scope for an ACP-conformance spike). **Marked unverified, with reason:** "the
agent parses and forwards the wire-shaped image block without error" is confirmed live; "the
connected model can see the image" is not, for lack of a vision-capable free credential on this
box. `resource_link` similarly completed its turn cleanly (`stopReason: 'end_turn'`) with no
error. **No gap** — the parts this spike could verify all matched; the one part it couldn't is
named precisely rather than guessed at.

### 7. `available_commands_update` and `usage_update` — both byte-exact

Real recorded `available_commands_update`: `availableCommands: [{name, description}, ...]` —
exactly `mapAvailableCommands`'s `RawAvailableCommand` shape (`client.ts`), no `input` field sent
(handled as `undefined`, per that function's own optional-field contract). Real recorded
`usage_update`: `{used: 8863, size: 200000, cost: {amount: 0, currency: 'USD'}}` — exactly the
`{used, size, cost}` shape `RawSessionUpdate`'s own doc comment documents and `mapToTranscriptUpdate`
already maps to `tokensUsed`/`contextWindow`/`costUsd`. Neither of these two update kinds was
exercised by name in either precedent spike's own findings section. **No gap in either.**

## Verdict: does loombox need an OpenCode-specific adapter, or does `generic` cover it?

**`generic` covers OpenCode's baseline session/prompt/tool-call/permission/config-option/resume
loop today, with no code changes needed anywhere in this codebase.** Every capability
`packages/providers/core`'s `AcpClient` and `@loombox/providers-generic`'s permission/tool-kind/
image helpers assume matches OpenCode's real wire behavior exactly, live-confirmed end to end —
including two surfaces (full session-lifecycle round trip, model/mode config-option switching)
that neither the Codex nor the Gemini spike could fully exercise live. The one real finding this
spike produced (#957, `mcpServers` missing from the `session/resume` request) is a pre-existing
`packages/providers/core` bug independent of which agent is connected — OpenCode simply has both
the real capability *and* the real credential-free live session this spike needed to observe it
for the first time. Nothing about OpenCode's own ACP support blocks registering it through the
generic tier today.

**A bespoke OpenCode adapter module is not warranted.** Every surface a bespoke module would exist
to patch is already either standard-shaped or narrower than the generic tier's own baseline:
tool-call titles are plain, generic strings (`"bash"`/`"write"`/`"edit"`/`"read"`) with no
bespoke-widget name-matching to write; the permission vocabulary is the simplest, narrowest fixed
set of any agent verified so far (`allow_once`/`allow_always`/`reject_once`, always exactly these
three); config options arrive in the real ACP-standard shape with no vendor sub-object to fold in;
no vendor `_meta` subagent-nesting signal was observed anywhere in the tool-call stream (unlike
Claude's `_meta.claudeCode.parentToolUseId`, SPEC.md §5.5). This mirrors Gemini's own precedent
exactly: "nothing" is a documented, acceptable outcome for the adapter-module decision (SPEC.md
§5.5's own framing), and Gemini's real adapter-module slot (issue #273) was closed on that same
basis.

## Gaps filed

| # | Title | Priority | Scope |
|---|---|---|---|
| [#957](https://github.com/fiorelorenzo/loombox/issues/957) | `AcpClient.resumeSession`'s `session/resume` request never sends `mcpServers`, despite its own doc comment and ACP's optional field — a resumed session silently loses its MCP servers | P2 | `packages/providers/core/src/client.ts` |

Labeled `type:fix`/`priority:P2`/`area:providers`, milestone v3, references this spike; still
needs parenting to epic #19 on the GitHub Project board (a board-write step outside this spike's
scope, same as the Codex and Gemini spikes both left for their own filed issues).

## Recommendation for #286 (register OpenCode behind the generic tier)

**Go.** Register `opencode` through `AGENT_CATALOGUE`'s custom-agent quick-add
(`packages/providers/core/src/agent-catalogue.ts`), the same path Gemini/Qwen Code already use —
`{name: 'OpenCode', command: 'opencode', args: ['acp']}`, `verification.against:
'opencode-ai@1.18.16'`, `sourceUrl: 'https://opencode.ai/docs/acp'`. This spike found no capability
gap that would make #286 anything other than a registration-only change (a new catalogue entry
plus setup-notes documentation, per #286's own acceptance criteria) — no per-tool bespoke widgets,
no `enrich` hook, matching #286's own stated acceptance bullet exactly. Fixing #957 first (or
alongside #286) is worth doing before or with that registration, since it is a real, live-confirmed
behavior gap that would affect OpenCode (and any other full-lifecycle ACP agent) from day one of
being registered, not a blocker to the registration itself.

## Recommendation for #287 (bespoke enrich/widget module)

**Not warranted — record "nothing" as the decision, per SPEC.md §5.5's own explicit allowance for
that outcome.** This spike found no vendor `_meta` signal, no tool-name convention the generic
tier's `ToolKind` fallback can't already render, no permission vocabulary the generic tier can't
already map, and no config-option shape needing special folding — every surface a bespoke module
would exist to patch is either standard or a strict subset of what `generic` already handles. #287
should close on the same basis Gemini's own adapter-module slot (issue #273) did, with this
document as its citation trail.

## Executable checks

`packages/providers/opencode/src/opencode-acp-capabilities.test.ts` turns every citation above
into an assertion against `packages/providers/opencode/test/fixtures/opencode-acp-live-probe.json`
— the real, recorded JSON-RPC traffic described in the Method section — plus a "real-shape
conformance" section feeding `@loombox/providers-core`'s `deriveFeatureFlags`/`reduceTranscript`
(via `toolCallUpdatesFor`'s real terminal-update-omits-`kind` case) and `@loombox/
providers-generic`'s `mapGenericPermissionOptions`/`classifyGenericToolKind` the real capability/
button/tool-kind/diff shapes found here. 14 tests, all passing (`pnpm --filter
@loombox/providers-opencode test`).

**Regression-proof, not just pass-today:** verified by hand once — temporarily flipping the
`sessionCapabilities.delete`/`additionalDirectories` absence assertion (`initialize:
agentCapabilities OpenCode actually advertises > advertises NO sessionCapabilities.delete...`)
from `.toBeUndefined()` to `.toBeDefined()` turns the suite red:

```
FAIL  src/opencode-acp-capabilities.test.ts > real opencode-ai --acp source/wire (issue #285
 build-time verification spike) > initialize: agentCapabilities OpenCode actually advertises >
 advertises NO sessionCapabilities.delete and NO sessionCapabilities.additionalDirectories --
 genuinely unimplemented, not merely unadvertised (see method-probe below)
AssertionError: expected undefined to be defined
Test Files  1 failed | 1 passed (2)
     Tests  1 failed | 13 passed (14)
```

Reverting the one-line edit turns it green again (`Test Files 2 passed (2)`, `Tests 14 passed
(14)`). Exactly this scenario — a future OpenCode release that starts advertising
`sessionCapabilities.delete` — is the regression this assertion exists to catch: it would mean
`session/delete` has become real, which should be loud, not silent.
