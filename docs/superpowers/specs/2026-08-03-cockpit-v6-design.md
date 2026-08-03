# loombox v6 — design spec ("the workbench, not the chat log")

Status: proposed (2026-08-03), from Lorenzo's own review of the shipped cockpit plus a
four-part audit (screenshots of the running app at three viewports, a transcript/composer
code audit, a shell/layout code audit, a design-system audit) and a reference pass over
Emdash 1.1.40 driven live over CDP.

v5 (`2026-07-28-coherence-v5-design.md`) made the surface internally consistent. v6 is about
the two things v5 did not touch: the **agent interaction surface**, which is the product, and
the **panel model**, which is how you work next to it. Lorenzo's verdict on the shipped
result is that the layout direction, the colors and the branding are right and a lot of the
detail is wrong.

Screenshots cited below as `desktop-NN` / `phone-NN` are committed under
`docs/design/audit-2026-08-03/` (prefixed `loombox-`); the full set of 28 was produced by a
throwaway Playwright spec against the real e2e fixtures and is not kept in the repo.

## 0. Decisions

Settled with Lorenzo on 2026-08-03. Where an option was chosen over a safer one, the option
not taken is named, so nobody relitigates it from scratch six weeks from now.

1. **The transcript renders Markdown, fully, in one pass.** Today it does not, at all. This is
   the largest defect found and it was not on anyone's list. Tables and syntax highlighting
   are in scope from the start rather than deferred: the subset-first option was on the table
   and was declined. That makes the streaming path the risk to engineer for, not to discover
   (§3.4).
2. **The composer becomes a real input:** a bordered field on `--color-surface-raised` with
   `--radius-md` and real padding, the same vocabulary the inbox reply box and the New Session
   dialog fields already use. Not focus-ring-only, not a large-radius chat pill. v5 §0.4
   decided it "stops looking like a chat box" and the implementation took that to mean no
   border, no background, no padding and no focus ring. v6 reverses the implementation, not
   the intent: it stays a docked field at the end of the timeline, and it is unmistakably a
   field you type into.
3. **Roles are attributed by glyph and surface, not by a word.** "YOU" / "CLAUDE" / "TOOL" in
   muted caption caps is the v5 answer to "you cannot tell who is speaking", and it is quiet
   enough to miss. The agent gets a provider glyph in the gutter and a surface of its own; the
   user keeps the accent bar it already has. Declined: a colour-only rail (fails for
   colour-blind readers), a circular avatar (drags the transcript toward chat), spacing alone.
4. **The terminal is a bottom dock:** horizontal, full canvas width, resizable, open at the
   same time as the transcript and the right sidebar, never covering either. Toggleable and
   closed by default, height persisted per user. Declined: always-present VS Code style, and
   auto-opening when a terminal happens to be alive, because the layout must not move on its
   own.
5. **Files / Config / (later) Git become a right sidebar** with sub-tabs in its own header,
   symmetric with the left sidebar: persistent, collapsible, resizable, pushes the canvas,
   never scrims it. Declined: vertically stacked always-visible sections (at 24rem each ends
   up too small to use), and a second separate right sidebar.
6. **Overlay scrims are for modals only.** A workbench panel never dims the app.

## 1. What is actually wrong today

Grounded in the running app (screenshots in the audit) and in the code.

### 1.1 The transcript

| # | Finding | Evidence |
|---|---|---|
| T1 | Markdown is printed literally. A fenced block shows its ``` fences; a `-` list shows dashes. There is no markdown dependency anywhere in `apps/web`. | `MessageItem.svelte:179` renders `<p class="text">{displayText}</p>`; `:291` is `white-space: pre-wrap` |
| T2 | Role attribution is a caption-size uppercase word in a 4.75rem gutter, `--color-text-muted`, further dimmed to `opacity: 0.5` on thoughts. Only the user turn gets accent color and a surface. | `MessageItem.svelte:229-238`, `:244`, `:247-265`; `ToolCallGutter.svelte:45-47` |
| T3 | Agent turns get no surface of their own, so a long agent answer is an unbounded run of prose against the page background. | `desktop-01`, `phone-01` |
| T4 | Tool cards are two nested boxes (card, then an inner surface for the payload) for content as small as one file path. | `desktop-02` |
| T5 | On the phone, agent prose renders low-contrast enough to read as disabled text. | `phone-01` |

### 1.2 The composer

| # | Finding | Evidence |
|---|---|---|
| C1 | No border, no background, no padding, no radius. | `+page.svelte:4509-4519` |
| C2 | **No focus indicator at all.** The native outline is removed and the `:focus-within` rule the comment claims exists was never written. At-rest and focused screenshots are byte-identical. | `+page.svelte:4528-4531`; `desktop-03` vs `desktop-04` (md5 match), `phone-03` vs `phone-04` |
| C3 | Send is `variant="secondary"` (outline, no fill) while "Sign in with GitHub" and "Create session" are `primary`. The most-used action in the app is the quietest button on the screen. | `+page.svelte:2948-2953`, `ui/Button.svelte:190-195` |
| C4 | The control row mixes three control languages side by side: bare text labels ("Claude Code", "Thought Level"), two `Select`s, one segmented Default/Plan, a 3px meter, a ghost icon button and a bordered Send. | `desktop-05` |
| C5 | The app already knows how to draw an input: the inbox reply box, the New Session dialog's title and prompt fields all have visible borders. The composer is the exception. | `desktop-12`, `desktop-15` |

### 1.3 The panel model

| # | Finding | Evidence |
|---|---|---|
| P1 | Terminal, Files and Config are three mutually exclusive tabs of one right-hand `position: fixed` panel, `width: min(26rem, 90vw)`. The terminal, which is inherently horizontal, gets a 340px-wide column. | `+page.svelte:223`, `:3028-3034`, `:4596-4608`; `desktop-09` |
| P2 | Opening any panel scrims the entire app, sidebar included, at exactly the same strength as a modal dialog, and clips the transcript behind it. | `Overlay.svelte:135-141`; measured `(199,206,217) → (123,129,138)` on both a panel and a dialog |
| P3 | The push-not-cover behaviour Lorenzo wants already exists as `drawerPinned`, but it is off by default, discoverable only from an icon inside the panel's own header, and gated to ≥1280px. | `+page.svelte:270`, `:4818-4824`; `desktop-11` proves it works at 1728px |
| P4 | **At exactly 1280px the pin button is visible and does nothing.** `viewport.ts:38` tests `max-width: 1280px` and `+page.svelte:4805` tests `min-width: 1280px`; both are true at 1280, so `drawerIsOverlay` stays true. Pixel diff of `laptop-03` vs `laptop-04` differs only inside the icon's own 84×66px pressed state. | as cited |
| P5 | There is no tab strip inside the panel. Switching Files → Config means going back to the topbar. | `cockpit-shell.spec.ts:190-210` |
| P6 | A bottom-docked horizontal presentation of this same panel already exists, gated to phones (`max-width: 767px`: `top: auto; left: 0; right: 0; height: 60vh`). | `+page.svelte:4771-4795`; `phone-06` |
| P7 | Files and Terminal have no timeout or error state: a dead node and a slow one look identical forever. | `FileTreePanel.svelte:83-87`, `InteractiveTerminal.svelte:72` |

### 1.4 The system layer

The token layer (`tokens.css`, `deck.css`, `typography.css`, `motion.css`) and the primitive
set are good. Adoption is not.

- 18 hand-rolled duplicates of existing primitives, notably four hand-rolled buttons
  (`PermissionCard.svelte:374`, `AddTargetWizard.svelte:772`, `OnboardingGate.svelte:282`,
  `PlanCard.svelte:163`) and two bare `<input>`s in the shell (`+page.svelte:2318`, `:2384`).
- Two primitives that should exist and do not: a **badge** (hand-rolled in four places) and a
  **row** (hand-rolled for session rows, destination rows, inbox rows, target rows).
- 40+ hardcoded dimensions bypassing the scale; icon sizes are passed as ad-hoc `em` strings
  at every call site; dialog widths disagree (`34rem` vs `30rem`, `70vh` vs `60vh`).
- Pages do not share a measure: the Nodes page renders one 40px row in a 1728px viewport with
  no other content (`desktop-13`).

## 2. Reference: what Emdash does

Driven live (Emdash 1.1.40 over CDP, screenshots in `/tmp/ux-audit/emdash/`). Emdash is the
shape Lorenzo is describing, so it is worth naming precisely what to take and what not to.

Take:
- **Three real zones that all coexist**: left sidebar (projects/tasks), center (conversation),
  right sidebar (Changed / Files / Conversations as **sub-tabs in one shell**), plus a
  **bottom horizontal terminal dock** with its own terminal list beside it. Nothing scrims
  anything. This is exactly items 4 and 5 of §0.
- **Settings as a page with a left sub-nav** (General / Account / Agents / Integrations /
  Connections / Repository / Storage / Interface / Browser). This validates issue #568.
- The right sidebar's Changed tab is a full git surface (file list with +N, stage, commit
  message, staged, PRs, branch). That is where loombox's future Git panel belongs.

Do not take:
- Emdash does not degrade at narrow widths: at 700px it still renders three columns and
  squeezes them. loombox is mobile-first and must keep its own responsive model.
- Emdash's agent surface is largely the agent's own TUI inside an xterm. loombox renders a
  structured ACP transcript, which is the better product; do not regress toward a terminal.

## 3. The target

### 3.1 Zones

```
┌ left sidebar ─┬──────────── canvas ─────────────┬ right sidebar ─┐
│ Inbox / Nodes │ topbar                          │ [Files][Config]│
│ Projects      ├─────────────────────────────────┤ [Git]          │
│  └ sessions   │ transcript                      │                │
│               │                                 │  sub-tab body  │
│               ├─────────────────────────────────┤                │
│               │ composer (a real field)         │                │
├───────────────┴─────────────────────────────────┴────────────────┤
│ terminal dock (horizontal, resizable, full width)                 │
└───────────────────────────────────────────────────────────────────┘
```

Both sidebars and the dock: independently open/closed, independently resizable, all
persisted, all pushing the layout. None of them scrims. The canvas is what shrinks.

### 3.2 The shared panel contract

The left sidebar's collapse + drag-resize + localStorage machinery is bespoke
(`+page.svelte:325-450`). Rather than duplicate it twice more, v6 extracts one
`DockPanel` behaviour: an edge (left / right / bottom), an open flag, a size in px with
min/max, a drag handle, and a persistence key. The three docks are then three call sites
with different edges. This is the one piece of shared work the other layout issues depend
on, so it lands first.

### 3.3 Responsive rules

| width | left sidebar | right sidebar | terminal dock |
|---|---|---|---|
| ≥1280 | docked, resizable | docked, resizable, open by default when a session is selected | docked, resizable |
| 1024–1279 | docked, collapsible to rail | docked, narrower default | docked |
| 768–1023 | overlay sheet | overlay sheet | bottom sheet |
| <768 | overlay sheet | bottom sheet | bottom sheet, one at a time |

Below 1024 exactly one of the three may be open at a time, and it is a sheet. Above it, all
three may be open together and none of them is a sheet. That is the whole rule.

### 3.4 Transcript

- Markdown rendering (fences with a code surface, lists, emphasis, inline code, links,
  tables, syntax highlighting) that composes with `TextPacer`'s character-count streaming
  reveal rather than re-parsing or re-highlighting per tick. A fence is highlighted once it
  closes and is plain monospace before that, which is both the cheap path and the one that
  does not flicker through half-tokenised states. The highlighter's grammar set is restricted
  and its bundle cost measured: this is a mobile-first client.
- Role attribution by surface and glyph, not by a caption word: the agent gets a provider
  glyph and its own quiet surface, the user keeps a distinct surface, tools keep their card.
  The fixed gutter column stays as the alignment device it already is.
- One level of card chrome for a tool call, not two.

### 3.5 Composer

A bordered, filled field on `--color-surface-raised` with real padding and radius, a
`:focus-within` ring using the existing focus-ring token, Send promoted to `primary`, and the
control row rationalised to one control language. It stays docked at the end of the timeline,
aligned to the same gutter. It does not become a floating chat bubble.

## 4. Out of scope

Editor (#205), working-tree diff viewer (#206), subagent trees (#200), the tier-3 tool-call
burst card (#202) and the plan sidebar (#201) are already filed and stay where they are. v6
only changes the surfaces they will land in.
