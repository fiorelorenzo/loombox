---
'@loombox/web': patch
---

Right workbench sidebar: Files/Config sub-tabs, docked, no dead pin at 1280px

Two things, closed together because the second bug lived entirely inside the first fix.

**#573**: the workbench panel's pin control was visible and inert at exactly
1280px, because `viewport.ts:38`'s `isNarrowViewport(WIDE_VIEWPORT_BREAKPOINT_PX)`
built `(max-width: 1280px)` and `+page.svelte`'s own CSS built
`(min-width: 1280px)` for the same decision, both true at 1280 itself. Fixed
`isNarrowViewport` with an `exclusive` option that subtracts a fixed epsilon
(`EXCLUSIVE_BREAKPOINT_EPSILON_PX = 0.02`) from the breakpoint before building
the query, so the two sides of a boundary decision partition the pixel to
exactly one side. Covered directly in `viewport.test.ts` at 1279/1280/1281,
with a `matchMedia` stub that actually evaluates the query string rather than
returning one fixed value regardless of it.

**#571**: the Drawer's Files/Terminal/Config panel was `position: fixed` by
default (a modal-strength scrim on every open, `Overlay.svelte:135-141`, and
the same scrim strength as the New Session dialog), with the "pushes instead
of covers" behavior gated behind a pin control nobody could find, off by
default, and dead at the exact width above. Rebuilt on `$lib/dock-panel.svelte.ts`
(#570), the same shared behaviour the left sidebar runs on: collapse,
drag-resize, persistence, no second implementation. Docked (no scrim at all)
at/above `--bp-desktop` (1024px); a side sheet at 768-1023px; a bottom sheet
below 768px, unchanged from before. Open by default at/above `--bp-wide`
(1280px) once a session is selected, and sticky to whatever the user actually
chooses (open/close, or a drag-resize) from the first real interaction on.

Files and Config are sub-tabs inside the panel's own header now (a
`radiogroup`, the same mutually-exclusive-always-one-selected idiom
`ConfigBar`'s mode switch already uses), not a second copy of the topbar's
former three-button switch. The topbar keeps exactly one control for the
sidebar itself; the panel choice lives only in its own header. Both panels
stay mounted (the native `hidden` attribute) once a session/project exists,
so switching Files to Config never remounts the other one.

The terminal leaves this panel entirely. Its own bottom dock is issue #572,
not built here — closing this PR means the terminal is temporarily
unreachable from the app until #572 lands; `InteractiveTerminal.svelte` and
its `openTerminal`/PTY logic are untouched and unchanged, just unmounted from
this component.
