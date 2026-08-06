---
'@loombox/protocol': minor
'@loombox/providers-core': minor
'@loombox/node': minor
---

Launch a session's MCP servers on its execution target, local or `ssh:` (Zed-parity D2-2, issue #750). `NodeDaemon.resolveMcpServers` is now the one resolution path: this node's own `McpConfigStore` (global + project) merged with a client's per-project `mcpServerConfigs` declarations, forwarded inside `session_create`'s encrypted `SessionPrivateMetaV1` (`@loombox/protocol`'s new `mcp-servers.ts` schema, mirrored client-side, never a secret value). Secrets keep resolving node-side and are injected at launch, never sent to the relay.

A server that fails to start — a missing binary or a failed MCP handshake — is excluded from that one attempt and retried without it (`startAgentWithMcpFallback`), so the session still opens with its remaining servers instead of quietly losing tools; the exclusion, its category (`missing_binary` | `handshake_failed` | `secret_missing`), and the underlying reason are pushed as a new `mcp_server_status` session-lifecycle event (`@loombox/protocol`'s `session-events.ts`, mirrored in `@loombox/providers-core`'s `AcpSessionWireEvent`/`TranscriptState.mcpServerStatuses`). A revoked/ungranted secret grant fails before any worktree/lease/agent is touched, and is now visible on the wire too (a minimal `session_announce` plus `session_status: 'error'` and `mcp_server_status`, both naming the server), not just a `console.warn`. Three consecutive failures for the same node-store-owned server auto-disable it (`McpConfigStore.setProjectEnabled`/`setGlobalEnabled`); a client-declared server has nothing here to disable, so it keeps being reported until the client acts. A server that already started is unaffected by a sibling's failure.
