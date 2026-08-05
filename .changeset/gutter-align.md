---
'@loombox/web': patch
---

Fixed the tool-call gutter icon sitting off the command's baseline in every
tool row (issue #703 — reported in the real desktop app: "le icone dei
comandi eseguiti di quando esegue un tool non sono allineate con il testo del
comando"). `ToolCard`'s plain variant (used by `BashWidget`,
`EditWriteWidget`, and the resting/collapsed state of `GenericToolRow` and
`TodoWidget`) carried its own `padding-top` copied from `ToolCallGutter`'s,
on the theory that matching the value would keep the two aligned — instead it
sank the header text by that same amount a second time, since the gutter's
own padding was already the one nudge needed (an SVG icon at `1em` has no
font leading, so it needs pushing down to land where the text's ascent
metrics put its first line). Removed the redundant copy from `ToolCard`.

Rather than replacing the gutter's own hand-tuned pixel offset with a
different hand-tuned pixel offset (which only ever matches the one font/size
it was measured against, and this column serves several — monospace
commands, UI-sans titles, two different type sizes), the gutter now reserves
one line of height (`1lh`) and centers the icon in it, so it tracks whatever
`line-height` the header text next to it actually uses instead of a constant
someone eyeballed against one row.
