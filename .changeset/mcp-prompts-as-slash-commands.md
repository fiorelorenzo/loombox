---
'@loombox/protocol': minor
'@loombox/providers-core': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Consume MCP prompts and surface them as slash commands (Zed-parity D5-2, issue #754). The node now speaks MCP directly (`@loombox/providers-core`'s new `mcp-prompt-client.ts`, hand-rolled JSON-RPC over stdio/HTTP, mirroring `AcpClient`'s own conventions) — a second, independent connection per launched server, separate from whatever the ACP agent itself does with `mcpServers` at `session/new`, since a real `omp acp` binary never forwards an MCP server's prompt catalogue onto its own `available_commands_update`.

Right alongside `mcp_server_status`, a new `mcp_server_prompts` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, same "ride the existing `session_update` envelope, no-op on an empty list" shape) carries every launched server's own `prompts/list` catalogue, attributed by server name. A server with no prompts contributes nothing; an unreachable server is silently excluded rather than breaking the push for the others.

Selecting one in the composer's `/` picker (merged with the agent's own `commandsFor` catalogue, each MCP-sourced row tagged `mcpServer`/`mcpArguments`) sends the server's own rendered definition, not the raw typed text: a new `mcp_prompt_get_request`/`mcp_prompt_get_response` wire pair (`@loombox/relay` routes/fans it out exactly like `fs_list_request`/`fs_list_response`) asks the node to call that prompt's real `prompts/get`, with the user's typed argument text folded in. A failed render falls back to sending the user's raw typed text rather than blocking the send.

Resources (D5-3) stay out of scope.
