---
'@loombox/web': patch
---

The session transcript now mounts only the visible range plus a small overscan, not every item a session ever received (issue #755, cockpit-parity decision E1-3). A 2000-item transcript used to pay for 2000 mounted rows on every render, on a phone as much as a desktop; it now mounts on the order of a few dozen.

Hand-rolled windowing (`$lib/transcript/windowing.svelte.ts`), not a dependency: the crux of this issue is a bespoke anchoring contract (streaming stays pinned to the bottom with no jump; reading history doesn't get yanked around as off-screen rows get measured), and that glue is most of the work regardless of which engine computes the visible range. Owning the ~90 lines of offsets/binary-search math keeps it testable against plain numbers instead of a third party's `ResizeObserver` internals, for zero added dependency surface. Row heights are unknown until measured (a one-line tool row versus a 400px diff), so every row starts at a flat estimate and is re-measured via `ResizeObserver` once mounted; two spacer `<li>`s stand in for whatever's hidden above/below, sized from the engine's own running offsets, so the existing `.items` flex/gap rhythm (including the tool-call "compact" spacing) keeps working unmodified for whichever rows are actually mounted.

`TranscriptTimeline.svelte` is a new component carrying everything the transcript region owned before (the scroll container, follow-the-bottom state, "Jump to latest") plus the new anchoring: while following, it keeps re-reading the browser's own accurate `scrollHeight` (issue #508's original mechanism, now re-run on a measured-height change too, not only a new item); while reading history, a row above the window trading its estimate for a real height nudges `scrollTop` by that exact delta instead of a `content-visibility`-style silent jump.

Accepted consequence: native browser find (Ctrl/Cmd+F) can only match currently-mounted rows, not the whole transcript. SPEC.md §7.19/§7.24's planned in-app search (issues #203/#263) is designed against the reducer's event model rather than the DOM for exactly this reason and is unaffected.
