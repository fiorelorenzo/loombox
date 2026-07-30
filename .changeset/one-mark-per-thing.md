---
'@loombox/web': patch
---

Spend a dot only where a dot means something.

The header already worked this way: a healthy connection shows nothing, because
"a permanently green dot in the app's highest-attention corner spent those pixels
saying nothing". Three surfaces still ignored that rule.

Session rows drew a status dot for every tone including the neutral ones (no
status yet, awaiting input, exited), so the common case was an identical grey
speck in the row's leading indent and the dot could not be read as meaning
anything. It now appears for the three tones that do mean something (working,
needs permission, error), into a grid column that holds its width either way, so
a title never jogs sideways when its session starts working. The status label
still reaches a screen reader on every row.

Transcript turns and queued prompts drew a 4px dot above the role word: muted for
an agent, accent for the user. On a right-aligned gutter it landed over the
label's last letter, unattached to anything. The accent moved onto the word
itself, so the cue survives and the speck does not.

Also in the sidebar: the account button showed the full address truncated
mid-domain while the menu it opens repeated the whole thing one line above, and
"Sign out" was styled as a destructive action. The button carries a short
identity now, and signing out is a normal menu item.

`StatusDot`'s two diameters became tokens, since a caller reserving the dot's
slot needs the same number the component uses.
