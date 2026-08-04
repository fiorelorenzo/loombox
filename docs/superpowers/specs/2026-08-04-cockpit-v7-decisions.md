# loombox v7 — the nineteen decisions Lorenzo took

Status: **settled** (2026-08-04). This is not a proposal. Lorenzo reviewed
`docs/design/ux-review-2026-08-04/index.html` (19 decisions, 63 options, merged as
#664) and picked one option per decision, with three amendments. This file is the
record of what he picked and the contract every implementing issue builds against.

Numbering matches the artifact: each decision opens with an unnumbered **Today**
card, then options are numbered from 1. So `A1-3` is the third numbered option, the
fourth card on the page.

Where a pick is quoted below, the quote is the artifact's own trade sentence, so an
implementer can see what was being bought without reopening the HTML.

---

## 0. The amendments

Three picks did not survive contact unmodified. These override the artifact:

1. **B1-2 loses the accent bar.** "Fill for the user only" as drawn kept the raised
   surface *and* a gutter accent bar. Lorenzo: *only* the different background. The
   bar goes.
2. **B3 stays exactly as it ships today.** The only decision with no change.
3. **E1-3 loses the digit badges.** The multiple-choice answer buttons do not print
   `1` / `2` / `3`.

### The one conflict, and how it resolves

E1-3's amendment (no digits on buttons) and **E3-1** (digit keys answer the focused
row) are in tension: the shortcut survives, its on-button advertisement does not.

Resolution, and it is what E3-1 already specified: **the key bindings stay, the
badges go, and the hint bar is the only place digits are advertised.** E3-1's own
trade sentence already accepted this — "discoverability rides entirely on the hint
bar". No behaviour is lost; one redundant label is.

---

## 1. Composer (A)

### A1-3 — Drop both separators, and lift the field

> No rules at all; the field sits on `--color-surface-raised` with a soft shadow so
> it reads as floating above the page.

Both of today's separators go: the `.canvas-footer` `border-top` hairline and the
composer's own top border. The field keeps its own border, gains
`--color-surface-raised` and a soft shadow.

This is the one pick that is deliberately *unlike* the rest of the app, which is
flat everywhere. That is the intent, not an oversight: the composer is the only
always-docked control surface, and it is allowed to be the only lifted one. Do not
"harmonise" it back flat, and do not spread the shadow to other surfaces.

### A2-1 — Bigger glyph, plain placeholder

> 20px target on a hover fill, and the placeholder just says what the box is for.
> The `@` hint moves to the hidden hint line that already exists for screen readers.

The attach control goes from 16px to a 20px glyph on a hover fill. The placeholder
stops teaching `@` and just names the box. The `@` instruction is not deleted, it
moves into the existing `aria-describedby` hint line, which already exists and is
already wired.

### A3-2 — Stop replaces Send, status on the gutter

> The button is just Stop; the working state is a live line in the transcript
> itself, on the gutter the turn already owns. Progress belongs to the turn, not to
> a button.

One button in one slot. While a turn runs, the button is Stop and Send is gone
(not disabled-and-present: gone). The "working" signal is a live line in the
transcript on the turn's own gutter, not a spinner welded to a control.

This kills two complaints at once: the two competing primary buttons, and the
missing loader.

---

## 2. Messages (B)

### B1-2, amended — Fill for the user only, and no accent bar

> Keeps the raised surface for your own words only; the agent's fill is dropped so a
> long answer runs into the page background again.

Final state:

| turn | surface | gutter bar |
|---|---|---|
| user | `--color-surface-raised` fill | **none** |
| agent | no fill, runs on the page background | none |

Exactly one signal per role, and for the agent that signal is *absence*. This is a
real binary and it is enough; do not reintroduce a second mark to "help".

### B2-4 — Nothing in the gutter, role told by surface alone

> Removes the mark entirely, sighted or not — the `.sr-only` label still reaches a
> screen reader regardless. Narrowest column possible.

The role glyph goes. The `.sr-only` role label **stays** — this is the whole reason
the option is accessible, and deleting it turns a design choice into an a11y
regression.

Two constraints that are easy to miss:

- The gutter column **still exists**, as the alignment device v6 §3.4 committed to.
  It gets narrower; it does not disappear. Everything aligned to it today (the
  composer included) must still line up afterwards.
- B2-4 was drawn paired with B1-4's flush tint. It is being shipped against
  amended B1-2 instead, which also keeps a per-role surface cue (user tinted, agent
  not), so the pairing constraint is satisfied. Verify this on screen rather than
  trusting the paragraph: a user turn and an agent turn must be tellable apart at a
  glance, in **both** themes.

Thought turns are out of scope here — they keep their own collapsed-disclosure
treatment.

### B3 — no change

Today's hover-revealed icon at the end of every row is what ships. Do not touch it.

---

## 3. Tool calls (C)

### C1-1 — One line, expandable

> The command and its outcome share the gutter's own text line, so `pwd` and a
> 13-line pass cost the same row until you ask for more.

A completed tool call rests as **one line**: command plus outcome, no box, no
border. The output is behind a disclosure, not deleted.

Measured, from the artifact's own harnesses: a one-line bash call costs **106px**
today, a passing 13-line vitest tail **393px**.

### C2-1 — Force-expand in place, only for the calls that need it

> The real change is that this stops being every call's default and becomes a rule
> scoped to failed, so whichever resting state C1 picks, a failure overrides it.

A failure renders full text, uncapped, disclosure **locked open** so it cannot be
collapsed by accident. The rule is scoped to failure; it is an override of C1-1,
not a competing default.

No cap is deliberate. Do not add a scroller or a line limit here — those were C2-2
and C2-3 and they were not picked.

### C3-2 — Compact list, one line per call

> Every call in the run renders as C1-1's single line, so six calls become a
> six-line scannable log that fits in a fraction of 1194px.

Consecutive calls collapse into one compact list. This option was explicitly
described as only working if C1-1 was also picked — it was, so the dependency is
satisfied and the two share one implementation.

A failure inside a run still obeys C2-1 and expands in place. A run that contains
one must not be able to look like a run that does not.

Six ordinary calls cost **1194px** today.

---

## 4. Terminal and header (D)

### D1-2 — One thin bar, carrying cwd/shell/status instead of the word

> Trades the word "Terminal" for information you'd otherwise open a file tree to
> find.

The terminal's own card and duplicated titlebar go. One thin bar remains, and it
stops saying "Terminal" (the dock toggle already does) and starts carrying **cwd,
shell, connection status, new tab**.

### D2-2 — No border, a different surface

> The dock sits on `--color-rail`, one shade off the canvas's `--color-bg`; the seam
> is a colour step, not a line.

The hairline between canvas and dock goes. The dock moves to `--color-rail`.

The catch the option named: with no line, **the drag handle is the only proof this
is a resizable edge**. It has to stay discoverable on hover. Do not let this land
as "removed the border" with the handle left invisible.

### D3-3 — Out of the header, into the session's own row menu

> The header keeps only the two toggles that actually open a panel; export moves to
> the session's own row menu next to rename and archive.

The bare copy glyph leaves the header entirely. The header is left with Workbench
and Terminal, two labelled toggles that both open a panel — one consistent row.

Export lands in the session row's `⋯` menu beside rename and archive, where the two
sibling session actions already live. The verb is fixed on the way: it is an
export, so it is not a copy glyph.

Accepted cost, stated so nobody re-litigates it: export is now a hop back to the
sidebar from inside the transcript.

---

## 5. Inbox (E)

### E1-3, amended — A card per session, message in full, answer attached, no digit badges

> Nothing is hidden and nothing needs opening — the last message renders in full and
> the real answer sits right under it.

Each row becomes a card carrying the agent's actual last message in full, with the
real answer control attached under it.

This is the UI half of **#662**. The data half is filed there and is a real
prerequisite: `AttentionInboxItem` has no field for the agent's message today, so
the card has nothing to render until #662 lands the plumbing. The transcript store
is already subscribed for these sessions (`relay-client.ts:3461`), so the data
exists client-side; it is the inbox item model that has no field for it.

Amendment: permission option buttons carry **no leading digit badge**. The digit
key bindings still work (see §0).

### E2-1 — Same inline widgets, row fades instead of vanishing

> Only what happens after changes, dimming to show the outcome for a couple of
> seconds before it actually clears — a mis-tap gets a window to be undone instead
> of none.

Answering no longer removes the row on the next store tick. It dims, shows the
outcome, and clears after a couple of seconds — with an undo available in that
window.

### E3-1 — Keyboard-first: j/k to move, digits to choose

> `j`/`k` moves a list-wide focus row, the same digit keys the permission card
> already listens for now answer whichever row is focused, and Enter drops into its
> reply box.

`j`/`k` move a list-wide focus row. Digits answer the **focused** row (today they
only work while a card already holds focus). Enter drops into the reply box.

The hint bar is now the only advertisement of the digit shortcut, so it is
load-bearing, not decoration.

---

## 6. Tracking (F)

### F1-1 — The Tracker destination asks, right there

> The empty state itself becomes the setup step. Fixes the exact place the confusion
> happens.

The Tracker page's empty state stops being blank and becomes the setup step:
connect GitHub, connect Jira, or use the local tracker, chosen right there.

### F2-2 — The picker itself moves to the page header

> One surface for "what is this" and "change what this is". Removes Config as a hop
> entirely for this one setting, at the cost of Config's Tracker section
> disappearing outright.

The tracker-mode picker moves out of Config and into the Tracker page header.
**Config's Tracker section is deleted**, not mirrored — that was F2-1 and it was not
picked. Leaving both would reintroduce exactly the two-places-for-one-fact problem
this decision exists to remove.

### F3-1 — Sensible built-ins, editing hidden until asked for

> Task/Bug/Epic cover most projects out of the box; typing `bug:` picks the type for
> you. The machinery only shows up if you go looking for "Manage types".

Task / Bug / Epic ship built in. A `bug:` prefix in the title picks the type. The
type-definition machinery moves behind an explicit "Manage types" and stops being
the first thing a new project meets.

Today's type-definition form is also write-only — it forgets what you told it. That
is part of this decision's scope, not a separate bug: a type you define has to come
back when you reopen the manager.

### F4-2 — Group into workflow categories

> Collapses whatever a workflow's granularity is into the three-stage shape every
> board already reads at a glance. Same column count regardless of a tracker's own
> workflow size.

The board groups into three workflow categories instead of rendering one column per
raw status.

**This supersedes #651 as filed.** #651 said "derive the real order from the
tracker"; F4-2 says derive the *category* and group by it, which needs the same
tracker-side data and also solves the six-columns-do-not-fit problem #651 left open.
#651 becomes the issue for F4-2 rather than staying a separate sort-order fix.

The mapping is tracker-derived, never hand-written:

- **Jira** already exposes exactly this as `statusCategory`
  (`new` / `indeterminate` / `done`).
- **GitHub** exposes `open` / `closed` plus `state_reason`.
- **Local** maps its own statuses.

An empty category still renders its column — today a status with no records cannot
render at all, which is the second half of the same defect.

---

## 7. The defect Lorenzo's screenshot caught, and why it is not cosmetic

His screenshot of the Inbox at 1280px shows the row's title block **centred**, and
the row carrying **no card background or border** at all. Both are the same bug, and
it is not in `AttentionInbox`'s CSS — that CSS is correct and never applies.

**Mechanism.** Svelte scopes a component's own selectors by appending a hash class,
so `Button.svelte`'s `.ui-button` compiles to `.ui-button.svelte-1ythfu8`,
specificity (0,2,0). A consumer overriding it writes `:global(.open)`, which
compiles to a bare `.open`, specificity (0,1,0). **The primitive always wins, and
the consumer's rule is discarded with no warning, no error, and no lint.**

Verified by compiling both components and reading the emitted CSS, not by
inspection:

```
Button.svelte        .ui-button.svelte-1ythfu8 { align-items: center; … }   (0,2,0)
AttentionInbox.svelte .open                    { align-items: flex-start; } (0,1,0)
```

`flex-direction: column` lands (nothing competes with it) while
`align-items: flex-start` is dropped, so the title and subtitle stack *and* centre.
That is precisely the screenshot.

**A repo-wide scan found seven real instances** (call sites where the class handed
to a primitive collides with a property that primitive declares on its own root):

| site | class → primitive | silently dropped |
|---|---|---|
| `AttentionInbox.svelte:169` | `.item` → `Row` | `background`, `border`, `transition` |
| `AttentionInbox.svelte:177` | `.open` → `Button` | `align-items`, `gap` |
| `OnboardingGate.svelte:167` | `.choice-card-trigger` → `Button` | `justify-content`, `border-radius` |
| `OnboardingGate.svelte:183` | `.choice-card-trigger` → `Button` | `justify-content`, `border-radius` |
| `AddTargetWizard.svelte:571` | `.link-button` → `Button` | `color` |
| `AttachmentBar.svelte:154` | `.remove` → `IconButton` | `flex-shrink` |
| `PermissionCard.svelte:202` | `.overflow-toggle` → `Button` | `transition` |

The two `AttentionInbox` rows are the screenshot. `OnboardingGate` means the
onboarding choice cards are centred too, on the first screen a new device ever sees.

**The fix is a prop, not a louder selector.** Winning a specificity fight with
`:global(.x.x.x)` would work and would be the wrong answer: a call site needing to
override a primitive's layout is a missing prop. This codebase already set that
precedent when `ToolCard` grew a `surface` prop instead of four widgets hand-rolling
their own background (#576).

So: `Button` gets an `align` prop, `Row` gets a `surface` prop, the seven sites move
to props, and **the scan becomes a test** so the class of bug cannot come back. The
detector is ~40 lines against `svelte/compiler` and needs no browser.

This is filed as its own P1 and lands **before** the E-series work, because the
inbox card that E1-3 builds is exactly a `Row` that needs a real surface.
