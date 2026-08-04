---
'@loombox/web': patch
---

Attention Inbox: a card per session with the agent's message in full, a dim-then-clear undo window, and j/k/digit keyboard triage

Each inbox row now shows the agent's actual last message in full
(`AttentionInboxItem.agentMessage`, plumbed by #662), rendered through the
same sanitised Markdown pipeline the transcript itself uses — no more
one-line derived "need" label with nothing else to go on (design spec
`2026-08-04-cockpit-v7-decisions.md` §5, E1-3, issue #671).

Answering a permission or a reply no longer removes the row on the next
store tick. It dims, shows the outcome, and offers Undo for a couple of
seconds before the real `resolvePermission`/`sendPrompt` call actually
fires (E2-1) — Undo cancels that deferred call outright, so it is a true
restore, not a race against an already-sent resolution.

`j`/`k` move a list-wide keyboard cursor across rows; a digit key answers
whichever row the cursor is on (the same binding `PermissionCard`'s own
`#148` keydown handler already provides when it holds literal focus
directly); Enter drops into a focused `awaiting_input` row's reply box.
Per the spec's own conflict resolution: the permission option buttons no
longer print a `1`/`2`/`3` digit of their own (E1-3's amendment) — the
key bindings still work, and the inbox's own hint bar is now the only
place a digit shortcut is advertised.
