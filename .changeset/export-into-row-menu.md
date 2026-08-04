---
'@loombox/web': patch
---

Move transcript export out of the session header into the session row's `⋯` menu, and stop drawing it as a copy icon

The session header carried a bare copy-glyph icon button next to the
Workbench and Terminal toggles, with no label to say what it did — it
turned out to be transcript export. The header now carries exactly the
two toggles that actually open a panel, both labelled, one consistent row
(design spec `2026-08-04-cockpit-v7-decisions.md` §4, D3-3, issue #670).

Export moved into the session row's `⋯` menu (sidebar), next to Copy
project path and Archive session…, as a plain "Export transcript" menu
item — no copy glyph anywhere on this action now, matching the real verb.
It is offered only from the currently open session's own row, since that
is the only transcript this page holds decoded client-side; the copy
behaviour itself (`exportTranscriptText` + `copyToClipboard`) is
unchanged, only its trigger moved.

Accepted cost, stated so it doesn't get relitigated: exporting the
transcript is now a hop back to the sidebar from inside it.
