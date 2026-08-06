---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': patch
---

Custom ACP agents defined per project, gated by a node-side allowlist (D1-3, issue #748)

`@loombox/protocol`: `customAgentRecordV1` (name/command/args/env/defaultMode/defaultConfigOptions) rides `sessionPrivateMetaV1.customAgent`, encrypted exactly like `title`/`projectPath`. A new `custom_agent_probe_request`/`custom_agent_probe_response` pair (mirrors `target-fs.ts`) lets a client check installed-vs-allowed on a target before ever creating a session. `sessionStatusEventV1` grew an optional `reason` so an `'error'` status can carry a verbatim message.

`@loombox/node`: `custom-agent.ts` — `assertCustomAgentAllowed`/`isCustomAgentCommandAllowed` (the actual security boundary), `CustomAgentNotAllowedError`, `createCustomAgentProvider`. The allowlist itself (`NodeCliConfig.customAgentAllowlist`) is file/env-only (`LOOMBOX_CUSTOM_AGENT_ALLOWLIST` or the config file's `customAgentAllowlist`), defaults to `[]` on a fresh node, and has no wire message that reads or writes it — never reachable from a client. `NodeDaemon` gates every custom-agent launch (`local` and `ssh:`) through it before ever registering a spawn recipe; a refusal reports `session_status: 'error'` with `reason` naming the allowlist. `applyCustomAgentDefaults` best-effort-applies a custom agent's `defaultMode`/`defaultConfigOptions` via the existing `session/set_config_option` path.

`@loombox/relay`: routes `custom_agent_probe_request`/`response` by `nodeId`, same pending-request-table pattern as `target_fs_list_request`.

Client-side custom-agent definition UI and the curated catalogue (#749) are separate follow-up work.
