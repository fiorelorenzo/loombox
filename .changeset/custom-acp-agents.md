---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': patch
'@loombox/web': minor
---

Custom ACP agents defined per project, gated by a node-side allowlist (D1-3, issue #748)

`@loombox/protocol`: `customAgentRecordV1` (name/command/args/env/defaultMode/defaultConfigOptions) rides `sessionPrivateMetaV1.customAgent`, encrypted exactly like `title`/`projectPath`. A new `custom_agent_probe_request`/`custom_agent_probe_response` pair (mirrors `target-fs.ts`) lets a client check installed-vs-allowed on a target before ever creating a session. `sessionStatusEventV1` grew an optional `reason` so an `'error'` status can carry a verbatim message.

`@loombox/node`: `custom-agent.ts` — `assertCustomAgentAllowed`/`isCustomAgentCommandAllowed` (the actual security boundary), `CustomAgentNotAllowedError`, `createCustomAgentProvider`. The allowlist itself (`NodeCliConfig.customAgentAllowlist`) is file/env-only (`LOOMBOX_CUSTOM_AGENT_ALLOWLIST` or the config file's `customAgentAllowlist`), defaults to `[]` on a fresh node, and has no wire message that reads or writes it — never reachable from a client. `NodeDaemon` gates every custom-agent launch (`local` and `ssh:`) through it before ever registering a spawn recipe; a refusal reports `session_status: 'error'` with `reason` naming the allowlist. `applyCustomAgentDefaults` best-effort-applies a custom agent's `defaultMode`/`defaultConfigOptions` via the existing `session/set_config_option` mechanism.

`@loombox/relay`: routes `custom_agent_probe_request`/`response` by `nodeId`, same pending-request-table pattern as `target_fs_list_request`.

`@loombox/web`: `RelayClient.createSession` now takes an optional `customAgent`, sealed into the same private envelope as `title`/`projectPath`; `RelayClient.probeCustomAgent` is the client half of the probe pair. A new per-project `custom-agent-store.ts` (`localStorage`-keyed, mirrors `mcp-server-store.ts`'s CRUD pattern) backs `NewSessionDialog`'s "+ Define a custom agent" form, which folds a project's custom agents into the same Agent picker as its registered providers (`custom-agent:<name>` ids, never colliding with a real provider id) and sends `provider: 'custom'` alongside the record on submit.

**The allowlist's edit path**, in full: an operator sets `LOOMBOX_CUSTOM_AGENT_ALLOWLIST` (comma-separated) or the node config file's `customAgentAllowlist` (JSON array) and restarts the node (`packages/node/src/config.ts`'s `NodeCliConfig.customAgentAllowlist` doc comment, threaded through by `main.ts`'s `start()`). No wire message reads or writes it, so it is architecturally unreachable from any client, no matter which device or account.
