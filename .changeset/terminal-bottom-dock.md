---
'@loombox/web': patch
---

Give the terminal its own bottom dock, horizontal instead of a 340px-wide overlay column

The terminal used to be the third tab of the right-hand panel, so it got a
narrow vertical column for something inherently wide and short, and
opening it meant giving up Files/Config since only one panel tab could be
open at a time.

It is its own bottom dock now (design spec `2026-08-03-cockpit-v6-design.md`
§3.1-§3.3), built on the shared `DockPanel` behaviour (`edge: 'bottom'`)
issue #570 extracted: full canvas width, drag-resizable height (12rem
minimum), toggleable and closed by default, height and open state
persisted per user (`localStorage`, matching every other dock). It sits
below the left sidebar, transcript, composer and right sidebar, all of
which stay visible and interactive while it is open — it never scrims.

`InteractiveTerminal.svelte` now loads `@xterm/addon-fit` and calls
`fitAddon.fit()` on mount and on every `ResizeObserver` notification for
its container, so a continuous drag reflows the terminal to real cols/rows
(not just a CSS height change), coalesced to one `fit()` per render frame
regardless of how many `pointermove` events the drag fires. Collapsing the
dock no longer unmounts the terminal or kills its PTY: it stays mounted,
hidden by height/transform, so a collapse/reopen round trip keeps the same
terminal and its scrollback.

Below 1024px it becomes a bottom sheet with a backdrop, reusing the
sessions sidebar's own always-mounted/CSS-transform mechanism (not a
second one), and follows the same one-panel-at-a-time rule the left and
right sidebars already have below that width.
