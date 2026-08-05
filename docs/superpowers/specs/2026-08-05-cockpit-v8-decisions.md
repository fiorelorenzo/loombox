# loombox v8 — the seven decisions Lorenzo took

Status: **settled** (2026-08-05). This is not a proposal. Lorenzo reviewed
`docs/design/ux-review-2026-08-05/index.html` (11 items: 8 decisions, 3 defects that
needed none) running v0.4.1 in the real desktop app against production, and picked one
option per decision, deferring one.

Numbering matches the artifact: each item opens with an unnumbered **Today** card, then
options are numbered from 1. So `B3-3` is the third numbered option, the fourth card.

Quotes below are the artifact's own trade sentences, so an implementer can see what was
bought without reopening the HTML.

---

## 0. What was deferred, and the one pick that knowingly does half

**A2 — the column that slides and narrows when a side panel opens — is deferred.**
Lorenzo: *"a2 per ora lasciamo così"*. The measurement stands and the finding stays on
record in the artifact: the content is centred in the canvas in both states, but the
canvas is not centred in the window when one 383px panel is open, and the column
narrows 863 → 769px in the same instant. Nobody should "fix" this incidentally while
doing A1. If a change makes the sliding worse, that is a regression; making it better
is out of scope until A2 is picked.

**C1-3 does half of what was asked, on purpose.** The artifact said so plainly in the
option itself, and the pick was made after reading it: the tab group never reaches the
topbar. Lorenzo asked for tabs in the topbar; he then chose the option that kills
Workbench and leaves the tabs in the panel. This pairs with D1-1, which needs the width:
a real centre zone and a permanent tab group in the right zone would fight. The tabs
staying put is what pays for the centre.

---

## 1. Space and measure (A)

### A1-1 — Widen the one measure to 100ch

> One universal number stays the simplest rule to reason about, and it still respects
> the readability ceiling the cap exists for — but it only buys back part of the
> emptiness at his width and gets relatively worse again on anything wider, and it does
> nothing for code, diffs or terminal rows, which stay exactly as narrow as prose for
> no reason.

`--measure` goes from `90ch` to `100ch`. One token, one value.

Two things an implementer must know, because they look like invitations to do more:

- `--measure-wide: 120ch` already exists (`tokens.css:55`) and is already used by
  `DiffViewer.svelte:14` and `PageLayout.svelte:54`. Inside the transcript it is inert,
  because `.items` (`+page.svelte:4930`) caps the whole list at `--measure` first.
  **Leave it inert.** Routing code, diffs, tool rows and the terminal to the wide
  measure is exactly option A1-2, and A1-2 was not picked.
- The trade Lorenzo accepted is explicitly that code and prose keep the same width.
  Do not "improve" on the pick.

---

## 2. Thoughts and turns (B)

### B1-1 — Plain text, lighter and smaller, no container

> Drops the card and the italic for a real size and colour step down from the answer;
> nothing but the type itself now marks where a thought starts or ends.

The thought card loses its fill and radius (`MessageItem.svelte:371-376`, `389-392`).
No container, no italic. A thought is distinguished from an answer by size and colour
only. The gutter column stays as the alignment device it already is; this is not a
licence to reintroduce a gutter accent bar, which v7's amendment 1 removed deliberately.

### B2-1 — One global switch, every thought follows it

> One boolean in `localStorage`, read once and applied everywhere, the same shape as
> `accent.ts`. Matches his own phrasing — "la scelta" is singular — and is the cheapest
> of the three to build, explain and ship.

Today `expanded` is per-component local state defaulting to `false`
(`MessageItem.svelte:247`) and nothing persists. It becomes one preference, stored the
way `accent.ts` stores its own, applied to every thought in every session.

The label moves above the thought, per the decision's own title. It must keep carrying
the role for assistive tech: a glyph needs an accessible name, so whatever replaces the
text label still announces what it is.

**This collides with #660 by design and the collision is the point.** #660's confirmed
first suspect is that a thought streams into a collapsed container, so the whole thing
appears at once when you finally open it. Whoever implements B2 owns that default: a
thought that is *currently producing text* must show that it is, whatever the resting
preference says. Do not implement the persistence and leave the streaming invisible.

### B3-3 — Faint accent-tinted wash, keyed to theme

> `color-mix(in srgb, var(--color-accent) 8%, transparent)` derives a whisper of the
> app's own "yours" colour from a token that's already identical in both themes, so one
> line of CSS lands at ΔL* ≈ 4.5 in dark and ≈ 2.4 in light with no per-theme tuning.
> Ties the signal to the accent blue used for links and Send, which could read as
> interactive when it isn't.

The user turn's fill becomes the accent-derived wash. This keeps v7's B1-2 amendment
intact: **fill only, no accent bar.**

The named risk is real and is the acceptance criterion: at 8% the wash must not read as
a clickable or linked surface. Verify against a turn sitting next to a real link and a
real Send button, in both themes, before calling it done. If it reads interactive at 8%,
the fix is the percentage, not a different mechanism.

---

## 3. Topbar and panels (C, D)

### C1-3 — Icon toggle only, the tabs stay in the panel

> Least crowding of the three, zero shifting, and Workbench still dies in favour of a
> plain icon in the right order. But it only does half of what he asked — the button
> group never reaches the topbar at all, so say so plainly if this is the pick. Tab
> persistence is unaffected, since nothing about where the tabs live has changed.

The `Workbench` labelled button (`+page.svelte:3056-3111`) becomes a plain icon toggle,
in the same order. The Files/Config/Runner radiogroup stays where it is, inside the
panel header (`:3466-3490`). Nothing about tab persistence changes, because nothing
about where tabs live changes.

`cockpit-shell.spec.ts:227` expects `workbench-toggle` with `aria-pressed`; the toggle
survives, so that assertion should still hold. The specs at `:632-650` and `:818-900`
that assert tabs live in the panel are now *permanently* correct rather than incidentally
correct, and should say so.

### D1-1 — A true centre zone

> Reads exactly like his sketch — breadcrumb left, switch centred, controls right — but
> only if it's built as a dedicated three-column layout. Bolt it onto today's
> space-between flex instead and it drifts the moment the left and right zones don't
> match width, which they never reliably do once C1's own button group is in the right
> zone.

The Agent / Tracker switch goes in the topbar, centred. The trade sentence is the
implementation instruction, not commentary: **a dedicated three-column grid**, so the
centre is the window's centre and does not drift with a long project path on the left.
Bolting a third child onto the existing `space-between` flex is the failure this option
already names.

C1-3 helps here: with no permanent tab group in the right zone there is more width to
give, and the centre has a better chance of surviving a narrow window. It still needs a
defined behaviour when the window is too narrow to hold three zones. Decide it, test it,
write it down.

---

## 4. Model and effort (E)

### E1-2 — One consolidated control

> Model, thinking and mode collapse into one button reading `Opus 5 · High` that opens
> a single popover holding all three. Trades a second click for the narrowest footprint
> of the three — thinking and mode are both hidden until the trigger opens, model
> included.

One trigger in `ConfigBar`, summarising the current model and effort, opening one
popover with model, thinking and mode together.

**This is presentation only, and it sits on top of #705.** #705 is the reason the bar is
empty: `client.ts:427` types `session/new`'s result as `{ sessionId: string }` and
discards the catalogue the agent actually sends. Measured against the real `omp acp`
binary: `initialize` sends no options at all, `session/new` sends model (26 choices),
thinking (`off`/`auto`/`low`/`medium`/`high`/`xhigh`/`max`) and mode. E1 must not
re-plumb that; it reads whatever `ConfigOptionStore` holds and renders it.

The catalogue is provider-declared, so "the right options for each provider" is not
something this control implements. It must not hardcode a model list, a thinking scale,
or an assumption that exactly three categories exist: the type comments
(`types.ts:141-145`) require an unrecognised future category to survive rather than be
dropped, and that requirement reaches the UI too.

---

## 5. The three defects (F)

These needed no decision and were filed and started immediately.

- **#702 (P0)** — Files and Terminal stop working permanently after the node restarts.
  Eleven handlers in `node-daemon.ts` open with `if (!bridge) return;`, a bridge is only
  ever built in `finishSessionCreation` (`:1905`), and the client's own 10s timeout then
  invents a reason that is the opposite of the truth. The node already records the
  honest state (`session-manager.ts:49-53`). Same class as #697, which fixed one handler
  and left eleven.
- **#703 (P2)** — the tool-call glyph sits below its command line. `.tool-gutter` carries
  `padding-top: var(--space-2xs)` inside a row that is already `align-items: flex-start`.
- **#704 (P2)** — the terminal prints `cd <worktree> && clear` before the first prompt.
  Confirmed for `ssh:` targets (`node-daemon.ts:4049`, where the comment calls it an
  accepted tradeoff). **Not reproduced on a local target**, which is what Lorenzo's
  screenshots show, so the cause there is still unknown. Blocked pending which target he
  saw it on; do not fix the SSH path and close it.
