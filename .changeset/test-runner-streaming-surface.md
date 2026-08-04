---
'@loombox/protocol': minor
'@loombox/node': minor
'@loombox/relay': minor
'@loombox/web': minor
---

Add the streaming test/lint/build runner surface (SPEC §7.15, issue #244)

Running a project's configured test/lint/build command (issue #245's config half) now streams live results from the cockpit instead of requiring a raw terminal. `packages/node/src/test-runner-process.ts` runs the command via `sh -c` on either target: locally with `child_process.spawn({ detached: true })`, so a cancel kills the whole process group (`process.kill(-pid, 'SIGKILL')`), not just the launcher; over `ssh:` it reuses the existing `RemoteProcessRunner` (setsid+fifo+log-tail) rather than opening a second channel, adding its own exit-code side-channel on top since that runner never captured one for a background job, and its cancel goes through `RemoteProcessRunner.stop()`, whose `setsid` branch now kills the whole remote process group (issue #642/#645). Both targets classify "command not found" as a uniform POSIX 127 instead of branching on ENOENT vs. remote shell text. `NodeDaemon` evaluates the project's permission policy (`evaluateCommandLine`, the same entry point `PolicyEnforcedPty`/`PolicyEnforcedExecutionTarget` use) before ever spawning, so a denied command surfaces as `could_not_start` with a policy reason and never runs.

Five new v1 wire messages (`run_start`/`run_cancel` client-to-node, `run_started`/`run_output`/`run_exit` node-to-client), modeled on `terminal.ts`, routed/fanned out by the relay exactly like `terminal_open`/`terminal_output`, sealed under the session key so no command, output, or outcome ever reaches the relay in the clear. `RelayClient` gains `startRun`/`cancelRun`/`onRunOutput`/`runsFor`. The right sidebar's Files/Config sub-tabs gain a third "Runner" tab (`RunnerPanel.svelte`): one Run/Cancel action per configured command, its combined output streaming live (reusing the display-only `TerminalOutput` component), settling to a pass/fail/could-not-start state with the real exit code.

Cancelling reaps the whole process tree on both targets, including forked grandchildren — verified with a `sleep 30 &`-forking fixture at the process, `NodeDaemon`, and (ssh) `RemoteProcessRunner` layers. Closing a node now also cancels every still-running local/ssh run instead of leaking it, the same way it already does for open terminals.
