---
'@loombox/node': patch
---

Fix `buildStopScript`'s `setsid` branch to kill the whole process group, not just the launcher (issue #642)

Stopping an `ssh:` session that had fallen back to `setsid` (the common case on a plain server without tmux/screen) ran `kill "$(cat pid)"`, which signals exactly one process. `setsid` makes the launched process a session leader, so its pid is also its process-group id, and anything real it launches (any agent or command that forks children) kept running on the remote host after "stop" returned. The `tmux`/`screen` branches never had this problem since they tear the whole session down.

`buildStopScript`'s `setsid` branch now sends `TERM` to the process group (`kill -TERM -"$pid"`, the leading dash), polls for up to 2 seconds so a well-behaved child gets a chance to clean up, then escalates to `KILL -"$pid"` for anything still alive. `buildIsRunningScript` is unchanged (it still reads the leader's own pid with `kill -0`), and stays correct because the stop script itself blocks until the group is confirmed dead or force-killed before its `exec()` resolves, so there is no window where a caller can observe a stopped session as still "alive".

New tests in `packages/node/src/ssh/remote-process-runner.test.ts` (using the `remote-sessions-test-sandbox` harness from #518) launch a `setsid` command that forks a real child, stop the session, and assert the child itself is gone (not just the launcher), plus confirm `isRunning()` still reports correctly across the new stop script.
