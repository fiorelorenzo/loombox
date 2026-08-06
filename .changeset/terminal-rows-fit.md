---
'@loombox/web': patch
---

Fixed `InteractiveTerminal.svelte` proposing more xterm rows than the dock actually has room for (issue #663), leaving unexplained blank/clipped space at the bottom of an open terminal.

Reproduced and measured: `.xterm-container`'s `padding: var(--space-2xs)` (4px) sat directly on the element passed to `terminal.open()`/`FitAddon`. With `box-sizing: border-box` (`typography.css`), `FitAddon.proposeDimensions()`'s `getComputedStyle(terminal.element.parentElement).height` already included that padding, and the padding it separately tries to subtract is read off `terminal.element` itself (xterm.js's own always-unpadded `.xterm` root) — never off the container. The container's own padding therefore silently escaped the row-count arithmetic, over-proposing rows by however many pixels of padding didn't add up to a whole cell height (matches xtermjs/xterm.js#2958). Fix: the padding now lives on `.xterm-container` alone; a new zero-padding `.xterm-canvas` inside it is what `terminal.open()`/`FitAddon`/the `ResizeObserver` actually measure, so `FitAddon` sees a box whose full extent really is available.

New Playwright coverage in `cockpit-shell.spec.ts` measures live DOM geometry (`.xterm-rows`' own per-row pixel height vs. `.xterm-container`'s real content box) at three dock heights, including one not a whole multiple of the line height, and confirms switching terminal tabs and collapsing/reopening the dock never leaves a stale fit.
