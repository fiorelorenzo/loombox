# Research digest — Zed vs loombox, 2026-08-05

Working notes behind the decision artifact. Everything here was read out of source
(zed-industries/zed main, or this repo) or measured on the running app, on 2026-08-05.
Nothing was copied from Zed; these are values and mechanisms, described.

## 1. Zed's colour ground (verified, `assets/themes/one/one.json`, One Dark)

| key | value | what it is |
| --- | --- | --- |
| `background` | `#3b414d` | the window ground behind everything |
| `title_bar.background` | `#3b414d` | same as ground |
| `status_bar.background` | `#3b414d` | same as ground |
| `panel.background` | `#2f343e` | project panel, agent panel |
| `surface.background` / `elevated_surface.background` | `#2f343e` | popovers, modals |
| `toolbar.background` | `#282c33` | tab-adjacent toolbar |
| `editor.background` | `#282c33` | the code itself |
| `tab.active_background` | `#282c33` | active tab matches the editor |
| `tab.inactive_background` | `#2f343e` | inactive tab matches the panel |
| `border` | `#464b57` | opaque, not an alpha hairline |
| `border.variant` | `#363c46` | quieter divider |
| `element.hover` | `#363c46` | hover is a fill step, not a border |
| `element.selected` | `#454a56` | selection is a fill step |
| `text` | `#dce0e5` | primary |
| `text.muted` | `#a9afbc` | secondary |
| `text.placeholder` | `#878a98` | tertiary |
| `text.accent` | `#74ade8` | links, accent |
| `scrollbar.thumb.background` | `#c8ccd44c` | translucent thumb |
| `editor.active_line.background` | `#2f343ebf` | current line |
| `search.match_background` | `#74ade866` | match |
| `search.active_match_background` | `#e8af7466` | active match |

Shape of it: **the chrome is LIGHTER than the content.** Ground `#3b414d` → panels
`#2f343e` → editor `#282c33`. The eye reads the code surface as the deepest well.
Chroma is real: `#3b414d` is a blue-grey (hue ≈ 220°, ~10% saturation), not neutral.

loombox today (`apps/web/src/lib/styles/deck.css`) is the mirror image: bg `#0a0c0f`,
surface `#0e1114`, surface-raised `#101418`, rail `#08090b` — near-black, near-zero
chroma, and the chrome (rail) is DARKER than the canvas. Borders are alpha hairlines
(9% / 16% / 28% white) rather than opaque steps.

## 2. Zed's density and type (crates/ui, crates/theme)

- `ui_font_size` default **16px**, but the ramp used by most chrome is
  `TextSize::Default` = 0.825rem ≈ **13.2px**; `Small` = 12px; `XSmall` = 10px.
- `buffer_font_size` default **15px**, monospace (Lilex), UI sans is IBM Plex Sans.
- Button heights: Large 32 / Medium 28 / **Default 22** / Compact 18 px.
- Icon sizes: Indicator 10 / XSmall 12 / Small 14 / **Medium 16** / XLarge 48 px.
- Spacing is a 4px grid with a density multiplier — `UiDensity` Compact 0.75× /
  Default 1.0× / Comfortable 1.25× — applied to a generated scale (0,1,2,3,4,6,8,12,
  16,20,24,32,40,48).
- Borders 1px, radii small (~2–4px), **no shadows on most surfaces**; layering is done
  with the colour steps above.
- Animation policy: hover fills ~100–150ms, disclosure ~100ms, modal fade 150ms, and
  nothing else. Panel and tab switches are instant.

loombox today (`tokens.css`, `typography.css`): base **15.2px** Inter, body line-height
23.2px, code 13.6px JetBrains Mono, nav rows **40px** (`--nav-row-height: 2.5rem`),
topbar 48px (`--topbar-height: 3rem`), sidebar 272px, radii 4–12px, three shadow tiers.
No density scale. Measured on the running app: body computed font-size 15.2px.

## 3. Zed's agent panel (crates/agent_ui, crates/acp_thread)

Feature inventory that matters to us, all present in Zed today:

- **Thread history sidebar**, auto-titled threads, resume, fork, and checkpoints
  (rewind to a message).
- **Token/usage ring** near the profile selector, warning ring at 0.85 of context.
- **Thinking blocks** with a three-state setting: `always_collapsed` /
  `always_expanded` / `automatic`, streaming visibly while collapsed.
- **Tool cards**: icon, title, status badge, disclosure, output truncated to ~3 lines
  collapsed. Bespoke widgets for edit/diff, terminal, fetch, search, web search, plan.
- **Edits bar** above the composer: file count, per-file rows, `Reject All` / `Keep All`,
  and a `Review Changes` multibuffer that stacks every edited file with per-hunk
  keep/reject. This is the thing in Lorenzo's screenshots (`Edits · 3 files · +95 −17`).
- **Permission prompts** inline in the thread, with flat option buttons, dropdown
  variants, and a pattern variant for sandbox escalation. Modes (`ask` / `accept edits`
  / `bypass`) decide which requests are auto-answered.
- **@-mention picker** over files, symbols, threads, skills, rules, diagnostics, plus
  drag-drop and paste-image, rendered as removable pills.
- **Slash commands**, including MCP prompts exposed as `/name`.
- **Follow mode**: a toggle that makes the editor jump to whatever file the agent
  touches, plus an "agent is editing this file" affordance.
- **Model / mode / profile selectors** in the composer, all agent-declared.
- **Notifications** when a backgrounded thread finishes or needs input.

loombox coverage today (verified in `packages/protocol`, `packages/node`,
`apps/web/src/lib`): streaming text/thought chunks with paced reveal, tool calls with
three bespoke widgets (edit/write diff, bash, todo) plus a classified generic row, plan
cards, FIFO permission queue with allow/reject once/always and an undo linger, config
options (model/thinking/mode) in one consolidated popover, terminals, file tree, test
runner, tracker, attention inbox. Missing: edits review bar, @-mentions, slash commands,
follow mode, checkpoints/fork, thread search, per-tool token attribution.

## 4. Zed's MCP and external agents

- MCP servers live in `project.context_servers`, **project-scoped**, two shapes:
  stdio (`command`, `args`, `env`, `timeout`, and a `remote: bool` that decides whether
  the server runs on the remote host) and http (`url`, `headers`, `timeout`, `oauth`).
- MCP UI: Settings → AI → MCP Servers. Rows carry a status dot, source badge, tool
  count, configure, uninstall, enable toggle. Tools appear in the agent's tool list.
- MCP coverage: tools ✅, prompts ✅ (as slash commands), resources ⚠ listed but not
  usable, sampling ❌, elicitation ❌, roots ⚠.
- **Agent profiles** (`agent.profiles`): Write / Ask / Minimal, each a map of tool→bool
  plus per-MCP-server tool toggles and an optional default model.
- **Tool permissions** (`agent.tool_permissions`), separate from profiles: a default of
  confirm/allow/deny, per-tool overrides, and `always_allow` / `always_deny` regex
  lists. MCP tools are addressed as `mcp:<server>:<tool>`.
- **External agents** (`agent_servers`): any ACP binary by `command` + `args` + `env`,
  plus `default_mode` and `default_config_options`. Claude, Codex and Gemini are just
  registry entries of the same shape.
- Remote MCP over SSH is **known-broken in Zed** (their issue #34402): `remote: true`
  assumes the same binary at the same path on both ends. This is the one place where
  loombox's node-side execution model is structurally better positioned.

loombox today: `apps/web/src/lib/mcp-server-store.ts` keeps per-project MCP configs in
`localStorage`, the Config panel offers six quick-add presets and a custom-server form,
`packages/node/src/mcp-config-store.ts` + the secret manager persist config and grants
on the node — and **nothing launches a server or exposes an MCP tool to an agent**
(#211, #627). Agents are a fixed registry (Claude Code, Codex, plus test providers);
there is no way to add an arbitrary ACP binary. Permission policy exists node-side as
per-project command/network globs (`permission-policy.ts`) with no UI.

## 5. Why Zed feels fast, and what a PWA can take

Zed: GPU scene graph (Metal/Vulkan/DX11), glyph atlas, no DOM/layout, no GC, everything
virtualized, all heavy work off the UI thread. Published keystroke-to-pixel ≈ 2ms,
cold start 0.4–0.6s.

Not reachable from a browser: GPU glyph atlas, GC-free frames, 0ms RTT to the agent.
Reachable, and not done in loombox today:

| technique | state in loombox | evidence |
| --- | --- | --- |
| virtualized transcript | not done — every item is in the DOM, keyed `{#each}` | `+page.svelte:3439` |
| `content-visibility: auto` / `contain` | not used | grep of `apps/web/src/lib/styles` |
| decrypt off the main thread | not done — `crypto.subtle` on the main thread, one message at a time | `relay-client.ts`, `packages/crypto/src/aead.ts` |
| batched decrypt of a burst | not done | `relay-client.ts` message handler |
| markdown parse memoized per stable prefix | done | `markdown.ts` `splitStreamingMarkdown` |
| syntax highlight lazy per language | done (#574, #600) | `markdown.ts` |
| paced text reveal | done — 32ms ticks, 2–35% of backlog per tick | `text-pacer.ts` |
| history refetch on reconnect | not done — resubscribes only | `relay-client.ts` |
| terminal write flow control | not done — unbounded `xterm.write` | `InteractiveTerminal.svelte` |

## 6. Keyboard

Zed: every capability is an action with a name; keymaps are JSON with context
predicates (`Editor && vim_mode == normal`, ancestor matching with `>`); the command
palette fuzzy-matches the whole action registry and shows each action's binding;
multi-key sequences (`cmd-k cmd-s`) with a 1s window. Muscle memory: `cmd-p` file
finder, `cmd-shift-p` palette, `cmd-b` / `cmd-j` / `cmd-alt-b` docks, `cmd-\` split,
`cmd-w` close, `cmd-f` / `cmd-shift-f` search.

loombox: one palette (`⌘K`) over sessions plus two hardcoded actions (measured live:
"Open attention inbox", "Open nodes and targets"), `j/k` + digits in the inbox, `Esc`
to defer a permission. No action registry, no binding display, no user keymap.

## 7. Verified live defects (headless run of v0.5.0 against the local dev loop)

1. Created two brand-new sessions on a local target with the "Oh My Pi" agent. The node
   logged `dropped prompt_inject … it has no live agent (disconnected since the last
   restart)` for both, and **the client showed nothing at all**: no error, no spinner, no
   "starting", just the user turn sitting there. The sidebar and the inbox both claimed
   "Awaiting you" / "Needs attention", which is the opposite of the truth. 96 cores, so
   the concurrency gate was not the cause; the honest summary is that a session that
   never got an agent is indistinguishable in the UI from one waiting for the user.
2. The terminal dock printed a line of `$$$$…` garbage before the first prompt on a
   **local** target, which is the not-reproduced half of #704.
3. The empty cockpit is ~70% empty space at 1728px: no status bar, no tabs, and the
   composer floats in the middle of a void.
