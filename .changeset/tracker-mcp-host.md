---
'@loombox/node': minor
---

A native-mode project's session now actually gets the five `tracker_*` tools issue #211 defined (`tracker_list`/`tracker_get`/`tracker_create`/`tracker_update`/`tracker_link_session`) served to its agent, closing the gap issue #211 deliberately left open: the tool contract existed but nothing served it. `TrackerMcpHost` runs a real `@modelcontextprotocol/sdk` MCP server in-process, on a loopback-only (`127.0.0.1`), token-in-URL HTTP endpoint per session — one more entry the session's own `mcpServers` list carries, resolved and injected automatically by `NodeDaemon.resolveMcpServersWithTracker` for a `{kind:'native'}` project, never something the user hand-adds. A `live`-mode (GitHub/Jira) project never gets this server at all, so its agent never sees `tracker_*` in its own `tools/list`.

Authority: `tracker_list`/`tracker_get` are pure reads, called straight through with no prompt, same as any other read-only tool. `tracker_create`/`tracker_update`/`tracker_link_session` mutate the real tracker, so each one is gated through the session's own live `AgentSession.permissions` FIFO queue before it runs — the exact queue and the exact D3-4 profile gate (issue #752) every other mutating tool call already goes through, never a separate or weaker mechanism.

The endpoint routes by two independent ids: the URL's own random per-session token never changes for that session's whole lifetime, while the underlying MCP protocol connection is free to open and close as many times as the connected agent's own MCP client library does — this host does not assume a client keeps exactly one connection alive throughout a session.
