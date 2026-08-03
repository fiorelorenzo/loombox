---
'@loombox/node': minor
---

Add a per-project permission policy (SPEC §7.17): allow/deny glob rules matched against the command an agent's process runs and the network destination it reaches, enforced at the node rather than relying on ACP's own agent-discretionary `session/request_permission`.

Deny always wins over allow; a project's saved policy lives in `PermissionPolicyStore` (`~/.loombox/node/permission-policy.json`, no settings UI yet); an unconfigured project keeps today's behavior (nothing blocked).

Enforced today at every interactive terminal this node opens (`PolicyEnforcedPty`, local and `ssh:` alike): a denied line is never forwarded to the real shell, the pending input is cleared, and a rejection is written back into that terminal's own output. Also wired into `NodeDaemon.getExecutionTarget()`'s exec seam (`PolicyEnforcedExecutionTarget`) for the project-scoped commands a future editor/git-management feature will drive through it — nothing project-scoped calls that seam yet, so this is not a live gate today beyond the terminal.

Not covered: an agent's own in-process tool calls (Claude Code/Codex run their own bash tool internally; this node declares `clientCapabilities.terminal: false` to ACP, so it never sees those individual commands) — that gap is namespace/bind-mount sandboxing's job (issue #257). Also named, not closed: `sudo`/`nice`/`ionice` command-prefix unwrapping, and `ssh:`-target symlink resolution.
