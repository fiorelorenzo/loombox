---
'@loombox/node': minor
---

A node now refuses to start when another live process already holds its state dir's identity (issue #929), and every systemd/launchd unit this package generates now checks its own KillMode/KeepAlive invariant before rendering.

Found on production: two `devbox-node-1` processes held the same identity against the relay for 15 hours, both inside one systemd cgroup, both reconnecting on every relay restart, both healthy — because the unit's forking `tsx` wrapper meant `KillMode=process` only ever signalled the wrapper, never the daemon it forked, and nothing on the node side checked for a second holder either.

`node-lock.ts` is new: `acquireNodeLock({ stateDir, nodeId })` claims a `node.lock` PID file under the state dir, refusing loudly (`NodeLockHeldError`, naming the live holder's pid) when another process already holds it. A held lock's holder pid is verified live via `kill(pid, 0)`, with a Linux-only `/proc/sys/kernel/random/boot_id` cross-check so a lock surviving a reboot is never mistaken for live no matter what its recorded pid now happens to point at; anything the check can't positively confirm dead is treated as live, the safe failure. A confirmed-dead holder (the exact case a hard `SIGKILL` leaves behind) is reclaimed automatically, so a crashed node's lock never wedges its own restart. `main.ts`'s `start()` acquires this before touching device-login/AMK/relay, and releases it from `stop()` or on any later startup failure.

`daemon-entrypoint-invariant.ts` is new: `assertDirectDaemonEntrypoint(execStart, execArgs)` refuses an `execStart`/`execArgs` naming a known forking dev-loop wrapper (`tsx`, `ts-node`, `nodemon`, `pm2`, `forever`, ...) anywhere in its path — the exact regression class behind this incident. `systemd-provisioning.ts`'s `generateSystemdUnit` and `launchd-provisioning.ts`'s `generateLaunchdPlist` both call it unconditionally, so every caller (remote `ssh:` provisioning, the Linux-local backend issue #658, and the launchd backend issue #654) is covered without any call-site change.
