# Codex ACP completeness — build-time verification spike (issue #182)

**Verdict: GO.** Codex's real ACP bridge (`@agentclientprotocol/codex-acp@1.1.10`) implements every
method/capability `packages/providers/core` and `packages/providers/codex` need — `initialize`,
`session/new`, `tool_call`/`tool_call_update`, `session/request_permission`, and inline base64
image content blocks all work as core expects. Nothing here blocks shipping the Codex adapter in
v1 (SPEC.md §10/§12's gate). What this spike found instead is four concrete places where
**loombox's own Codex-facing code makes an assumption about the wire shape that the real adapter
does not match** — none of them protocol gaps in Codex, all of them loombox bugs this spike caught
before a real user would. Each is filed as its own issue (table at the bottom) rather than fixed
here, per this issue's own non-goal.

## Method

Previous verification of `codex-acp` in this repo (see `packages/providers/codex/src/provider.ts`,
`image.ts`'s doc comments, and `apps/web/CHANGELOG.md`'s Codex entries) was done by fetching
individual files from the `agentclientprotocol/codex-acp` GitHub repo via `gh api
repos/.../contents/...` — useful, but partial, and not repeatable by a future contributor without
re-fetching by hand.

This spike instead adds `@agentclientprotocol/codex-acp` as a **pinned devDependency** of
`packages/providers/codex` (version `1.1.10`, the `latest` npm dist-tag as of 2026-08-06) and reads
the installed package directly from `node_modules`:

- `packages/providers/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js` — the
  published package's only shipped file (`package.json`'s `files`/`main`: `dist/index.js`), an
  esbuild bundle of the real `codex-acp` TypeScript source plus its own bundled copy of
  `@agentclientprotocol/sdk` (the ACP protocol's reference zod schema). It is **not minified** —
  esbuild's dev-mode bundling preserves the original `src/*.ts` path comments
  (`// src/CodexAcpClient.ts`, `// src/CodexToolCallMapper.ts`, etc.) and every identifier/string
  verbatim, so a `file:line` citation against it is a faithful, reproducible pointer to the real
  source, not a paraphrase. All line numbers below are against this exact file at this exact
  version.
- `packages/providers/codex/node_modules/@agentclientprotocol/codex-acp/README.md` — the
  package's own feature list.
- `agentclientprotocol.com/protocol/v1/schema` — the official ACP v1 doc, used to corroborate the
  bundled schema is the real protocol, not a Codex-specific dialect.

Crucially, this devDependency is a **test-time-only** addition. `packages/providers/codex/src/
provider.ts`'s `CODEX_ACP_ARGS` still spawns Codex via a floating `npx -y @agentclientprotocol/
codex-acp` at runtime, unchanged — the real `codex` CLI/credentials still aren't available on this
devbox, so this spike is source-verification, not a live end-to-end run (same caveat every prior
Codex verification in this repo has carried).

`packages/providers/codex/src/codex-acp-capabilities.test.ts` turns the citations below into
executable assertions against the installed package's source text, so a future `codex-acp` version
bump that drops or renames one of these capabilities fails CI instead of surprising a user. See
that file's own header comment for how it's structured and why the version is pinned exactly
rather than left as a caret range.

**Install weight, checked (not assumed):** `@agentclientprotocol/codex-acp@1.1.10` pulls in exactly
one new transitive dependency, `@agentclientprotocol/sdk` (its own bundled zod schema copy), for a
combined `1.2 MB + 5.4 MB = 6.6 MB` under `packages/providers/codex/node_modules/.pnpm` — dev-only,
scoped to this one package, invisible to every runtime bundle (`provider.ts` still shells out to
Codex via `npx`, never imports this package). `pnpm install --frozen-lockfile` and a full
`pnpm -r typecheck` (all 17 workspace projects) both stayed green with it in place. 6.6 MB of
devDependency-only weight for a citation trail that's mechanically checkable against the real
shipped source (versus hand-copied snippets nobody can `grep -c` against a version bump) is the
right trade for a package this repo already spawns as its Codex runtime — vendoring snippets
instead would trade that mechanical check for a doc a human has to remember to re-verify by hand,
which is the exact failure mode described in the Method section above (the GitHub-`gh api`
snapshot approach this spike replaced).

## Capability-by-capability findings

### 1. `initialize` — agent capabilities Codex actually advertises

Codex's real `initialize()` response (`CodexAcpServer.ts`, `dist/index.js:28759-28808`):

```js
agentCapabilities: {
  auth: { logout: {} },
  providers: {},
  loadSession: true,
  promptCapabilities: { embeddedContext: true, image: true },
  sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, additionalDirectories: {} },
  mcpCapabilities: { acp: false, http: true, sse: false }
}
```

**Confirmed accurate:** `promptCapabilities.image: true` and `embeddedContext: true` — exactly what
`packages/providers/codex/src/image.ts`'s `buildCodexImageContentBlock` and
`packages/providers/core/src/capabilities.ts`'s `deriveFeatureFlags` read
(`prompt?.image`/`prompt?.embeddedContext`). `AcpPromptCapabilities`'s shape
(`packages/providers/core/src/types.ts`) matches the real `zPromptCapabilities` schema
(`dist/index.js:18704-18709`) field-for-field.

**Gap found (filed as #821):** `packages/providers/core/src/types.ts`'s `AcpAgentCapabilities`
(lines 74-82) declares five top-level fields — `mcpServerPicker`, `additionalDirectories`,
`sessionDelete`, `requestPermission`, `plans` — that do not exist anywhere on the real ACP v1
`AgentCapabilities` object. Cross-checked against the bundled `@agentclientprotocol/sdk`'s own zod
schema (`zAgentCapabilities`, `dist/index.js:18831-18857`) and the official docs' stated default
value (agentclientprotocol.com/protocol/v1/schema: `agentCapabilities` defaults to
`{"loadSession":false,"promptCapabilities":{...},"mcpCapabilities":{...},"sessionCapabilities":{},
"auth":{}}` — no flat `mcpServerPicker`/`additionalDirectories`/`sessionDelete`/`requestPermission`/
`plans` field in either place). `mcpServerPicker`, `requestPermission`, and `plans` don't exist in
the real schema at all, in any nesting (grepped the entire 31,611-line bundle: zero hits as
capability fields — `requestPermission` appears only as the unrelated `session/request_permission`
JSON-RPC method name (`dist/index.js:21092,21587,24320,24335,24350,24983,30436`) and once as a
substring of the unrelated `"requestPermissions"` action-type case label (`dist/index.js:23318`,
part of a `switch` over MCP-tool action kinds, nothing to do with agent capabilities).
`additionalDirectories` and `sessionDelete` *do* exist, but nested under
`sessionCapabilities.additionalDirectories` / `sessionCapabilities.delete`
(`zSessionCapabilities`, `dist/index.js:18734-18742`) — a level `deriveFeatureFlags`
(`packages/providers/core/src/capabilities.ts:45-62`) never looks at. Concretely: Codex's real
response sets `sessionCapabilities.delete: {}` and `.additionalDirectories: {}` (both genuinely
supported), but `supportsSessionDelete`/`supportsAdditionalDirectories` read the wrong path and
report `false` forever — for Codex and for any other real ACP v1 agent, since the invented field
names aren't protocol at all.

A same-root-cause detail folded into the same issue: `supportsResume`
(`capabilities.ts:55`) reads `agentCapabilities.loadSession` — the flag that gates the *older*
`session/load` method (`AGENT_METHODS.session_load = "session/load"`, `dist/index.js:3702`) — but
`packages/providers/core/src/client.ts`'s actual resume implementation (`resumeSession()`, lines
686-696) calls `session/resume`, gated by the separate `sessionCapabilities.resume` capability
(`AGENT_METHODS.session_resume = "session/resume"`, `dist/index.js:3711`; distinct request schemas
at `dist/index.js:19550-19579` — `zLoadSessionRequest` takes `mcpServers`+`cwd`+
`additionalDirectories`+`sessionId`, `zResumeSessionRequest` takes `sessionId`+`cwd`+
`additionalDirectories?`+`mcpServers?`). Both happen to be `true` for Codex today
(`loadSession: true` and `sessionCapabilities.resume: {}` are both set), so this is latent, not
actively broken — but it's reading the wrong flag for the method it actually calls.

### 2. `session/new` — session creation round trip

`CodexAcpServer.newSession()` (`dist/index.js:29162-29176`) returns
`{ sessionId, models, modes, ...configOptions }`. `packages/providers/core/src/client.ts`'s
`newSession()` (lines 654-674) sends `{ cwd, mcpServers }` and reads only `result.sessionId` plus
the config-option catalog (via `mapConfigOptions`) — both present and correctly shaped on the real
response. **No gap found here** — this half of the surface is solid.

### 3. `tool_call` / `tool_call_update` — the real title/kind shapes

Codex's `CodexToolCallMapper.ts` (`dist/index.js:22780-23499`) emits real `kind` values `edit`,
`execute`, `read`, `search`, `think` (guardian review), and `other` — all present in
`packages/providers/core/src/types.ts`'s `AcpToolKind`. **Minor gap found (filed as #822):**
the real ACP v1 `ToolKind` enum (`zToolKind`, `dist/index.js:18344-18355`) has a tenth value,
`switch_mode`, that `AcpToolKind` (types.ts:282-283, nine values) doesn't carry. Codex's own mapper
never emits it today (not observed anywhere in `CodexToolCallMapper.ts`), so no runtime impact
against Codex specifically — filed because a generic ACP agent, or a future Codex release, could
send it and `AcpToolKind` would silently fail to type it.

**Real, concrete gap found (filed as #819):** `packages/providers/codex/src/tool-widgets.ts`
matches a tool call's bespoke-widget eligibility by checking whether its `title` starts with
`patch`, `diff`, or `bash` (case-insensitive). No real Codex tool-call title ever does:

- A file-change tool call is titled literally `"Editing files"` with `kind: "edit"`
  (`createFileChangeUpdate`, `dist/index.js:22799-22807`) — never "Patch(...)" or "Diff(...)".
- A shell-command tool call's title is the command text itself, run through `stripShellPrefix()`
  first (`dist/index.js:22745-22751`):

  ```js
  function stripShellPrefix(command) {
    const withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, "");
    ...
  }
  ```

  which strips a leading `bash`/`zsh`/`sh` (`-lc`) prefix *before* the string ever becomes a title
  — a command tool call's title is guaranteed to never start with "bash". Sub-actions get their own
  distinct titles too: `"Read file '...'"`, `"Search for '...'"`, `"List files in '...'"`
  (`dist/index.js:23179-23205`), none of which start with the three matched prefixes either.

The three-name prefix list traces back to SPEC.md §7.24's "Codex's patch/diff/bash" bullet, and the
Codex-shaped conformance fixture this package tests against
(`packages/providers/core/test/fixtures/codex-like-acp-agent.mjs`) already flags in its own header
comment that its tool titles ("Patch"/"Bash") are "NOT a claim about codex-acp's exact wire text
... to be confirmed against the real binary in a future ... build-time verification spike" — this
is that spike, and the fixture's assumed titles do not match. Consequence: `codexBespokeToolName()`
/`hasCodexBespokeWidget()` never fire against a real Codex session; every Codex tool call falls
through to the generic `ToolKind` row. `codex-acp-capabilities.test.ts`'s "real-shape conformance"
section proves this today by calling `hasCodexBespokeWidget()` directly with the real title strings
above and asserting the current (gap) result.

### 4. `session/request_permission` — the real `options[]`/`kind` vocabulary

The real ACP v1 `PermissionOptionKind` enum (`zPermissionOptionKind`, `dist/index.js:18481-18486`)
has exactly the four values `packages/providers/core/src/types.ts`'s `AcpPermissionOptionKind`
already declares: `allow_once` / `allow_always` / `reject_once` / `reject_always`. **This part is
accurate.**

`packages/providers/codex/src/permissions.ts`'s `mapCodexPermissionOptions` classifies each option
into one of three verbs (`yes` / `yes_for_session` / `stop_and_explain`), first by matching text
patterns against the option's own `name`/`optionId`, falling back to the raw ACP `kind` when no
pattern matches. **Gap found (filed as #820):** the real `CodexApprovalHandler.ts`
(`dist/index.js:24280-24726`) never sends the "Yes"/"Yes, for this session"/"Stop, and explain what
to do differently" text SPEC.md §7.24 and the fixture assume. `ApprovalOptionId`
(`dist/index.js:24281-24290`) and the option builders (`buildCommandOptions`/
`buildFileChangeOptions`/`buildPermissionsRequest`, `dist/index.js:24469-24610`) label real buttons:

| real label | `optionId` | `kind` |
|---|---|---|
| `"Allow Once"` | `allow_once` | `allow_once` |
| `"Allow for Session"` (or `"Allow Host for Session"` / `"Allow Root for Session"`) | `allow_always` | `allow_always` |
| `` "Allow Commands Starting With `git ...`" `` (only when Codex proposes an execpolicy amendment) | `accept_execpolicy_amendment` | `allow_always` |
| `"Allow <host> in the Future"` / `"Block <host> in the Future"` (only for a proposed network-policy amendment) | `apply_network_policy_amendment:<n>` | `allow_always` / `reject_always` |
| `"Reject"` | `reject_once` | `reject_once` |
| `"Allow for Session"` / `"Allow Once"` / `"Reject"` (the separate, broader `handlePermissionsRequest` flow, toolCall `kind: "other"`) | `allow_permissions_session` / `allow_permissions_turn` / `reject_permissions` | `allow_always` / `allow_once` / `reject_once` |

None of these strings contain "stop", "explain", "abort", or "cancel" — the classifier's first
pattern rule (`/stop|explain|abort|cancel/i`) never matches a real Codex option. Classification
still comes out correct today, but only via the `kind`-based fallback (`reject_once`/
`reject_always` → `stop_and_explain`), which every real request actually exercises — not the text
rule the code's own doc comment describes as the primary path. Also worth recording for the
go/no-go call: **the options list is not fixed at three entries** — a command approval can carry 2
to 5+ options once execpolicy/network-policy amendments are proposed
(`dist/index.js:24502-24569`).

### 5. Image content blocks — the inline base64 hand-off

**Re-confirmed, not refuted** (this spike corroborates SPEC.md §7.25/§16's existing claim rather
than re-deriving it, as issue #182's own notes ask): `buildPromptItems()`
(`dist/index.js:26987-27023`) converts an inbound ACP `image` content block with no `uri` into a
`data:` URL via:

```js
function imageDataUrl(block) {
  return `data:${block.mimeType};base64,${block.data}`;
}
```

(`dist/index.js:27024-27026`) — byte-for-byte the same shape
`packages/providers/codex/src/image.ts`'s `buildCodexImageContentBlock` already emits (`{type:
'image', data: base64, mimeType}`, no `uri`), unified with Claude's adapter exactly as previously
documented. `image.test.ts` already covers this function's own behavior in detail; this spike adds
no new gap here.

## Gaps filed

| # | Title | Priority | Scope |
|---|---|---|---|
| [#819](https://github.com/fiorelorenzo/loombox/issues/819) | Codex bespoke tool-widget matching (patch/diff/bash) never matches a real Codex tool-call title | P1 | `packages/providers/codex/src/tool-widgets.ts` |
| [#820](https://github.com/fiorelorenzo/loombox/issues/820) | Codex's real permission-option labels are Allow/Reject, not the "Yes"/"Stop, and explain" text SPEC.md §7.24 assumes | P2 | `packages/providers/codex/src/permissions.ts`, SPEC.md §7.24 |
| [#821](https://github.com/fiorelorenzo/loombox/issues/821) | providers/core's AcpAgentCapabilities reads capability fields that don't exist in real ACP v1 (mcpServerPicker, requestPermission, plans; additionalDirectories/sessionDelete/resume mis-nested) | P1 | `packages/providers/core/src/{types,capabilities,client}.ts` |
| [#822](https://github.com/fiorelorenzo/loombox/issues/822) | AcpToolKind is missing the real ACP switch_mode tool-call kind | P3 | `packages/providers/core/src/types.ts` |

All four are labeled `area:providers` and reference this spike; they still need parenting to epic
#19 on the GitHub Project board (not yet done — a board-write step outside this spike's scope).

## Executable checks

`packages/providers/codex/src/codex-acp-capabilities.test.ts` turns every citation above into a
source-text assertion against the pinned, installed `@agentclientprotocol/codex-acp@1.1.10`
package, plus a "real-shape conformance" section that feeds loombox's own adapter functions
(`mapCodexPermissionOptions`, `hasCodexBespokeWidget`/`codexBespokeToolName`,
`buildCodexImageContentBlock`, `deriveFeatureFlags`) the real label/title/capability shapes found
here — proving today, not just documenting, which of loombox's Codex-facing assumptions hold.

**Regression-proof, not just pass-today:** verified by hand once — temporarily flipping the
`loadSession: true` assertion's expected string to `loadSession: false` turns the suite red (`1
failed | 13 passed`, `AssertionError: expected '… loadSession: true, promptCapabilities: …' to
contain '… loadSession: false, promptCapabilities: …'` at the exact assertion line); reverting the
one-character edit turns it green again (`14 passed`). Full before/after output is in this PR's
description, not committed here since it isn't a permanent fixture.
