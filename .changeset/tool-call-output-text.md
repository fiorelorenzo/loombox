---
'@loombox/web': patch
---

Show a tool call's actual output instead of its wire envelope. `content`
arrives from ACP as an array of `ToolCallContent`, and anything that was not
already a plain string was rendered with `JSON.stringify` — so a failed
command printed `[{"type":"content","content":{"type":"text",...}}]` where its
error should have been (issue #689).
