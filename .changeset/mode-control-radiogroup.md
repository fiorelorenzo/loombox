---
'@loombox/web': patch
---

Give the mode segments a role a screen reader can read

`ConfigBar`'s mode control (Auto | Plan) was a `role="group"` wrapping two
plain `Button`s, with the current mode marked only by a background tint via a
`selected` class. A screen reader heard "Auto, button. Plan, button." with no
way to tell which one was current, the one fact the control exists to carry.

It is now a `role="radiogroup"` of `role="radio"` segments with `aria-checked`
and a roving `tabindex` (WAI-ARIA APG's radio group pattern): Tab enters the
group once, landing on the checked segment, and Left/Up and Right/Down move
both the focus and the selection, wrapping at the ends.

I picked radiogroup over the topbar panel switch's `aria-pressed` (`Button`'s
`pressed` prop from the earlier topbar fix) because the two controls mean
different things. Mode is mutually exclusive and always has exactly one value,
which is what a radio group is for. The panel switch is not: `toggleDrawer` in
`+page.svelte` closes the open panel on a second click of its own segment, so
"none selected" is a real, reachable state there, which is exactly what
`aria-pressed` (independently on/off, legitimately all-off) describes and a
radio group cannot. The panel switch keeps `aria-pressed`; I am not touching
it here, and I do not think it needs to change either, since it is not a
radio group by nature. `Button` gained plain pass-through `role`,
`ariaChecked`, `tabindex` and `onkeydown` props to carry this without a
hand-rolled `<button>` inside `ConfigBar`, so the segmented-control idiom
stays one shared primitive; every existing call site is unaffected.

`ConfigBar.test.ts` now asserts the selected mode through the accessibility
tree (`getByRole('radio', { checked })`), not the class name, which is what
let this ship unmarked.
