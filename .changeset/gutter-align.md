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
own padding already does the one nudge needed (an SVG icon at `1em` has no
font leading, so it needs pushing down to land where the text's ascent
metrics put its first line). Removed the redundant copy from `ToolCard` and
re-tuned the gutter's own padding against real rendered rows in both themes,
short and truncated-long commands alike.
