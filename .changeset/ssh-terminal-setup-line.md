---
'@loombox/node': patch
'@loombox/web': patch
---

Fixes a garbage row appearing above a terminal's first prompt on every target (issue #704). The real cause was a missing `@xterm/xterm/css/xterm.css` import: without it, xterm.js's own hidden character-width measurement probe rendered inline in normal document flow instead of off-screen, on every terminal open, local or `ssh:`. Reproduced and confirmed clean on both target kinds; the `local` path itself was already clean at the byte level (no plumbing written to the channel before attaching).

Also fixes a real, separate `ssh:`-only bug found while investigating: an `ssh:` terminal used to type `cd <worktree> && clear` as PTY input once the channel was already open, which the remote PTY's line discipline echoes back like any other typed input. `Ssh2Transport.openShellChannel` now execs `cd <cwd> && exec "$SHELL" -l` with a pty attached instead — the same "ssh into a directory" idiom an interactive `ssh -t host 'cd dir && exec $SHELL'` uses — so the command is never something "typed" into the channel for the line discipline to echo in the first place.
