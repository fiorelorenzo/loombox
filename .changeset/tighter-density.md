---
'@loombox/web': patch
---

One tightened default for the whole chrome, no setting (issue #734, Zed-parity decisions doc A2-1): `--nav-row-height` 40→30px, `--topbar-height` 48→36px, `Button` md/sm padding one rung down the spacing scale (~37/25px → ~25/20px), `--text-body-size` 15.2→14.4px, `--text-code-size` 13.6→12.8px.

- `.destination-row` (the sidebar's Inbox/Nodes/Tracker rows) gets the same `@media (pointer: coarse)` 44px floor `Button`/`IconButton`/`Input` already carry — it never had one, and shrinking the row by 10px would have shrunk a real tap target on the tablet session sheet with nothing to catch it.
- New structural tokens `--touch-target-min` (44px) and `--touch-target-compact` (40px) in `tokens.css`, both plain `px`. `html`'s own font-size is `var(--text-body-size)`, so every `rem` value anywhere in the app (including every existing `2.75rem`/`2.5rem` coarse-pointer floor literal) computes against that token's value — tightening it would have silently shrunk every touch-target floor in the package (`Button`, `IconButton`, `Input`, `Select`, `Checkbox`, `ConfigBar`, `PermissionCard`, `PlanCard`, `TurnEditsBar`, `AppearanceSettings`) from ~41.8px actual down to ~39.6px. These two tokens pin every one of those floors to a fixed physical size instead.
- No density setting — that's A2-2, and it wasn't picked.
