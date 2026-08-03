---
'@loombox/web': patch
---

Add the Badge and Row UI primitives, give Button arbitrary data-_/aria-_ passthrough, and migrate the safe call sites off their hand-rolled duplicates

`Badge` replaces four slightly-different hand-rolled badges (MCP server config's secret badge, the target picker's kind/unreachable badges, and the target status view's kind/agent-health badges — the last of which now composes the real `StatusDot` instead of redrawing it). `Row` is the new shared leading/content/trailing list-row shape, adopted first by the attention inbox. `Button` now accepts arbitrary `data-*`/`aria-*` attributes without letting a caller override the props it already owns, which is what let the permission card's overflow toggle move onto it. Also migrated: the add-target wizard's back link, the onboarding choice cards (now `Card` + `Button`), the diff viewer's outer card, and the recovery code card's now-unnecessary wrapper div. Both new primitives are covered on `/style-reference`.
