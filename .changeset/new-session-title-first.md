---
'@loombox/web': patch
---

Put the task title first in the New session dialog and make the starting prompt optional. The form now reads Title, Agent, Workspace, Starting prompt, and the title is the field the dialog focuses on open: what identifies a session on the board is the task, not the first thing you happened to say to the agent. The starting prompt drops its `required` mark, shrinks from six rows to three, and its help text now says it can be sent later from the composer instead. Pressing Create with everything blank creates a session titled after the project folder, with no prompt sent at all (previously the dialog sent an empty string). `RelayClient.createSession` already typed `prompt` as optional and only sent the follow-up when non-empty, and the node already fell back to the project folder's basename for an empty title, so this is a dialog-only change.
