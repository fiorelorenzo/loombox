---
'@loombox/web': patch
---

One control language across the composer's control row (issue #578)

`ConfigBar`'s consolidated trigger (#711) and the status bar's own meter (#736) already
closed most of #578's original complaint by the time I re-measured against the shipped
app; what was left was a real, measurable inconsistency between the row's remaining
pieces, not the four-language toolbar the issue's own screenshot showed.

The rule, stated once rather than as a list of nudges: every control in the row that
isn't the Send/Stop action sits at the same `--radius-md` corner and the same
`--space-2xl` resting height (2rem — the exact footprint `IconButton`'s own `md` rung
already defines as this app's standard icon-action hit target, reused through the token
that already equals it rather than a sixth number), and the row groups by what a control
acts on rather than spacing every element identically: attach/insert-snippet (message-
scoped, always live) sit in one tight cluster, the agent/model/effort trigger
(session-scoped, one disclosure since #711) sits in a second tight cluster, and the gap
between the two clusters is wider than the gap within either one. Send stays the row's
one deliberately distinct primary action (#577's own acceptance line), so it keeps
`Button`'s own primitive height rather than being forced onto this rule with a call-site
override (`primitive-override-scope.test.ts`, issue #665, guards against exactly that).

- `ConfigBar.svelte`: `.agent`/`.config-trigger` both gain `min-height: var(--space-2xl)`
  — a floor, not a forced height, so neither ever clips; measured before/after in a real
  headless Chrome render, the two chips now sit flush with `IconButton`'s own 29px
  render instead of 1-2px shy of it.
- `+page.svelte`: `.composer-controls` wraps attach/insert-snippet in
  `.composer-message-actions` and the narrow-viewport "···"/`ConfigBar` in
  `.composer-session-controls`, tight `--space-xs` gap inside each, `--space-md` between
  them (was one uniform `--space-xs` across every element) — the row now reads as two
  groups plus Send, not five equally-spaced buttons.

Touched regions only: `ConfigBar.svelte`'s trigger/agent-chip CSS, and `+page.svelte`'s
`.composer-controls`/`.composer-message-actions`/`.composer-session-controls`/
`.composer-actions` markup and CSS. Nothing in the session-row/destination-row/
`PlanCard`/native-select surfaces #605 owns.

Verified in a real headless Chrome render (not just jsdom) at 390px and 1440px, both
themes, resting and with the popover/narrow "···" open — screenshots in the PR body.
