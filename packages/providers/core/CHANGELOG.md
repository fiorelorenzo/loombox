# @loombox/providers-core

## 0.1.0

### Minor Changes

- 55161ed: Give `@loombox/providers-core` a browser-safe entry point (`@loombox/providers-core/browser`) and move `McpServerSecretMissingError` out of `client.ts` into `mcp-secret-grants.ts`, beside the logic that raises it. The barrel exports `AcpClient`/`PermissionQueue`/`ConfigOptionStore`, which extend Node's `EventEmitter`; `vite build` tree-shakes them away, but `vite dev` evaluates every module it serves, so the web app painted a healthy page and then died on hydration with `Cannot access "node:events.EventEmitter" in client code`. `apps/web` now imports the browser entry, and a test asserts nothing reachable from it imports a `node:` builtin.
- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.
