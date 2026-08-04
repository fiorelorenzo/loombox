---
'@loombox/web': minor
'@loombox/node': minor
'@loombox/protocol': minor
---

Terminal dock: the terminal's own card and duplicated "Terminal" titlebar are gone (issue #669, design spec §4 D1-2/D2-2). One thin bar remains at the top of the dock, carrying live connection status, the session's real working directory, the shell running the active PTY, and a new-tab control that opens genuinely additional terminals for the same session, each kept alive when you switch away from it. `cwd`/`shell` are real values reported by the node (`terminal_opened`'s payload gained these two fields) — never guessed client-side.

The dock itself moved to `--color-rail` and dropped its hairline border against the canvas, so the seam is a colour step instead of a line; the resize handle stays discoverable on hover and still works from the keyboard.
