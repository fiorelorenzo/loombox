---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Add per-project test/lint/build command configuration and auto-detection (SPEC §7.15, issue #245)

A project's test/lint/build commands can now be read, saved, and auto-detected through the owning node: `TestRunnerConfigStore` (`@loombox/node`) persists them per project (mirrors `PermissionPolicyStore`'s JSON-file shape), and `detectTestRunnerCommands` proposes commands from `package.json`'s `scripts` block via whichever `ExecutionTarget` the project's session runs on (`local` or `ssh:`), picking `pnpm`/`yarn`/`npm` syntax off the project's lockfile. Detection only ever proposes a command for a script that genuinely exists — never a guessed default for a project with nothing detectable.

Five new v1 wire messages (`test_runner_config_get`/`_set`/`_detect` client-to-node, `test_runner_config_result`/`_detected` node-to-client), routed/fanned out by the relay exactly like `fs_list_request`/`fs_list_response`, sealed under the session key so no command string ever reaches the relay in the clear. `RelayClient` gains `getTestRunnerConfig`/`setTestRunnerConfig`/`detectTestRunnerConfig`; `ProjectConfigPanel` gains a new "Test, lint & build" section (`TestRunnerConfigPanel`) with per-command explicit save and an "Auto-detect" action whose suggestions are shown for confirmation and never applied without an explicit Accept click.

This ships the configuration half of SPEC §7.15's test runner (issue #245); the streaming execution half (issue #244, running the configured commands with live output and cancellation) is tracked separately.
