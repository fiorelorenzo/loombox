---
'@loombox/protocol': minor
'@loombox/providers-core': minor
'@loombox/node': minor
'@loombox/web': patch
---

Wires the browser's own MCP config/status surface into the one resolution path #750 (D2-2) built on the node (issue #794).

- `apps/web`'s Config panel (`McpServerConfigPanel.svelte`) now forwards its per-project `mcp-server-store.ts` list — only the currently-enabled records — into `RelayClient.createSession`'s new `mcpServerConfigs` option, which seals it into `session_create`'s private envelope exactly like `title`/`projectPath`. A server added there is launched for the very next session on that project.
- The node's `mcp_server_status` event gains a `disabled` flag (`@loombox/protocol`'s `mcpServerStatusEntryV1`, mirrored in `@loombox/providers-core`'s `AcpMcpServerStatusEntry`): `true` only on the exact failure that just auto-disabled the node's own `McpConfigStore` record after three consecutive failures (`NodeDaemon.recordMcpServerOutcome`/`autoDisableMcpServer`, now reporting instead of only logging).
- The Config panel renders a new "Server status" section off `RelayClient.mcpServerStatusesFor(sessionId)` (threaded through `ProjectConfigPanel`): every failed server by name and reason, with an auto-disabled one visibly distinct from one that will simply be retried next session — including a server only the node itself is configured with, not just this device's own list.
- New copy on the "Configured servers" section makes the two-store merge legible: this device's own declarations are one input the owning node merges with its own store, not the whole truth.
- No secret value crosses either surface: `mcp-server-store.ts` never held one, and `mcp_server_status.reason` is always the human-readable failure detail, never a secret (`mcp-secret-grants.ts`'s node-local boundary unweakened).
