---
'@loombox/node': minor
---

Add the native tracker's MCP tool contract (SPEC §7.10, §7.7)

`@loombox/node` gets `tracker-mcp-tools.ts`: `createTrackerMcpTools`, which builds `tracker_list`/`tracker_get`/`tracker_create`/`tracker_update`/`tracker_link_session` — the five tools SPEC §7.10 names for agent access to the native tracker — from a `NativeTrackerStore` plus a session's already-resolved `(projectPath, authorId, sessionId)`. Every input schema is a `.strict()` Zod object with no `projectPath`/`authorId`/`sessionId` field, so a session's tools are structurally bound to its own project and identity rather than merely checked against them; a call naming another project's record id fails exactly like a call naming a made-up one. Output is the real `TrackerRecord` (`fields`/`system`/indexed columns from #210's data model), with no ad-hoc DTO.

No node-side MCP host consumes this yet — this repo's whole MCP surface today only lets a session declare an _external_ MCP server (stdio/http/sse) that the ACP agent connects to itself; there is no mechanism to run an MCP server inside the node and serve tool calls from it. That's a distinct, larger piece of work, filed as a follow-up issue rather than faked here.
