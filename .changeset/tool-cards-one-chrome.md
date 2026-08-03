---
'@loombox/web': patch
---

Tool-call cards: one level of chrome instead of two

A tool call used to render as two nested boxes: a bordered card with a
header line, wrapping a second inset surface (`--color-fill-subtle`) for
the payload. For a call whose entire payload was a single fact already
named in its title (`Read apps/web/src/lib/terminal.ts` whose `rawInput`
was that same path again), that was a lot of chrome for one line of text,
and a run of several tool calls in a row read as a stack of boxes rather
than a conversation with work in it.

`tool-widgets/ToolCard.svelte` now takes a required `surface` prop instead
of always drawing a border: `surface={true}` keeps the v5 bordered-card
treatment for content with no surface of its own (`TodoWidget`'s checklist,
`GenericToolRow`'s own multi-line output or multi-entry `rawInput`);
`surface={false}` draws nothing but layout, for a single-line row or for a
widget whose body already carries its own surface (`BashWidget`'s
`TerminalOutput`, `EditWriteWidget`'s `DiffViewer`) — never both at once.
`GenericToolRow` decides "one line or a block" from the payload's own
shape (does it contain a newline, does it carry more than one key/value
pair) and folds a single-line payload directly onto the header line,
dropping it entirely when it only repeats what the title already said.

Status also moves: a new shared `ToolCallStatus` component drops the
"Completed" caption once a card has settled (the dot alone still carries
it to screen readers via its own `aria-label`) and makes "Failed" the one
state allowed to shout — bold, `--color-danger`, on its own chip — so a
failure in a run of otherwise-quiet completed calls is what actually draws
the eye.

The bespoke widgets (bash, edit/write, todo) keep their own visual
language unchanged; only the redundant outer frame goes.
