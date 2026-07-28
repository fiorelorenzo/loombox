# loombox v5 — design spec ("one style, one place per thing, honest numbers")

Status: agreed with Lorenzo (2026-07-28). Follows
`docs/superpowers/specs/2026-07-25-ia-v4-design.md` (#507), which fixed what the shell *is*.
v4 left the surface internally inconsistent: three different form languages, a page title
drawn twice, Settings reachable three ways, node cards whose numbers were wrong, and a
transcript where you cannot tell who is speaking.

Everything below was verified against the code by an audit whose findings were then
independently refuted twice; only what survived, plus what Lorenzo named himself, is here.

## 0. Decisions made (with Lorenzo)

1. **The page's `<h1>` survives, the topbar title goes.** The topbar carries the session
   breadcrumb, the actions and ⌘K. On a page it carries actions only.
2. **Settings lives in the account menu, and nowhere else.** The sidebar keeps Inbox and
   Nodes, the two destinations you watch while working. Settings is configuration.
3. **Node cards become dense rows** with the detail behind an expansion.
4. **The transcript keeps its timeline** but states the role, and the composer stops looking
   like a chat box.

## 1. Form language (the biggest single source of drift)

There is no `Input`, no `TextArea`, no `Checkbox`, no `RadioGroup` and no `Field` wrapper.
Every form hand-rolls label + control + help + error, and the same input CSS block is
copy-pasted across at least eight components. That is why the forms read as generic: they
were never designed, only repeated.

New primitives under `apps/web/src/lib/components/ui/`:

| primitive | replaces |
|---|---|
| `Field.svelte` | the hand-assembled label/help/error/required stack |
| `Input.svelte` | every bare `<input type="text">` and its duplicated CSS |
| `TextArea.svelte` | the composer-shaped textareas in dialogs |
| `Checkbox.svelte` | the toggle switch hand-built in three files |
| `RadioGroup.svelte` | `NewSessionDialog`'s hand-rolled Workspace choice |
| `FormActions.svelte` | the submit rows that each lay themselves out differently |

`Field` owns the ARIA contract so no caller has to remember it: it generates the id, wires
`for`, `aria-describedby` for help, `aria-invalid` + `aria-errormessage` for errors, and
`aria-required`. A control used outside a `Field` must still be usable, so each primitive
accepts those attributes directly too.

The look is the devtool register the rest of the app already uses, not a web form: label in
`--text-caption-size` uppercase with `--text-caption-tracking`, control on
`--color-surface-raised` with a 1px `--color-border`, `--radius-md`, monospace
(`--font-mono`) for anything that is a path, a host, a command or an identifier, and the
existing focus ring verbatim. No placeholder text used as a label, ever.

Note on Styles: an earlier draft of this spec required the Deck/Loom/Studio Style axis to keep
working. That axis no longer exists - `loom.css`, `studio.css` and `style.ts` were deleted in
#502, so `deck.css` is simply the palette. Reading every value through a custom property is
what actually mattered in that rule and still holds; the three-Style part of it is void.

## 2. Shell

- `MAIN_VIEW_TITLES` and its topbar `<span>` are removed. `PageLayout`'s `<h1>` gains real
  typographic sizing rather than the browser default it inherits today.
- The Settings row leaves the sidebar primary destinations AND the mobile tabbar. The account
  menu keeps it. Nothing else about the account menu changes.
- Every interactive element in the sidebar gets the states the rest of the app already has:
  `:focus-visible` on the destination rows, the project group headers and the account
  trigger; `:active` press on those and on the popover menu buttons, matching
  `Button.svelte`'s tension-press.

## 3. Node rows (`TargetStatusView`)

The numbers were wrong and are fixed separately in `@loombox/node`: CPU was a load average
mislabelled as utilisation, and RAM counted the reclaimable page cache as used. The wire now
carries `loadPercent` alongside the deprecated `cpuPercent`, plus `hostname`, `platform` and
`arch` on `target.health`.

One row per target, not a card:

```
▸ ● local    devbox · linux/x64        load 42%   mem 31%   disk 35%     28s
```

- **Identity answers "which machine".** The target label, then the real `hostname` and
  `platform/arch` from the sample. This is Lorenzo's actual complaint: a target called
  `Local` on `devbox-node-1` never said whether that was the devbox or the Mac.
- **`load`, not `CPU`.** The honest label for what is measured, per §16's grounding note.
- Numbers are `font-variant-numeric: tabular-nums` so a column of targets stays scannable.
- The three meters move behind the row's expansion, along with absolute sample time and the
  Reconnect / Update / Edit / Remove actions.
- The status dot carries the health; the "Overloaded" word appears only when it is true, and
  its threshold is stated in the expansion rather than left as folklore.

## 4. Agent surface

- **Every turn states its role.** A `--text-caption-size` uppercase role label in the gutter
  column (`You` / the provider's name / `Tool`), so scanning does not depend on noticing a
  dot's colour. The user's own turns additionally sit on `--color-surface-raised`.
- **One card language for tool calls.** `GenericToolRow`, the `tool-widgets/*`, `PlanCard`
  and `DiffViewer` share one container treatment, nested under the turn that produced them
  rather than floating as siblings. `PermissionCard` is the single deliberate exception and
  keeps its raised, bordered treatment, because interrupting is its job.
- **The composer is the last element of the timeline, not a chat box.** It loses the pill
  border and the accent-filled Send button, gains the same gutter column as every other
  entry, and keeps its hint inline in the toolbar rather than as a detached line beneath.
- `QueuedPromptBar` stops being a right-aligned bubble, which is the one surviving artefact
  of a chat metaphor the transcript abandoned.

## 5. Token hygiene

- `--color-fill-hover` does not exist. `DirectoryPicker.svelte:475` references it, so that
  hover silently does nothing today. Either define it or use `--color-fill-subtle`.
- Hardcoded font sizes and off-scale paddings are mapped onto `--text-*` and `--space-*`.
  Where a real gap in the scale is what caused the drift, the scale gains the step rather
  than the component keeping a literal.
- Accessibility minimums (44px touch targets) stay literal and documented as such; they are
  a platform constraint, not a scale value.

## 6. Out of scope

Relay-backed project sync; the board/list view of SPEC §7.2; Loom/Studio art direction beyond
keeping them working; any change to the crypto boundary or the wire beyond the additive
fields already landed.
