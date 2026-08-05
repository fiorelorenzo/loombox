---
'@loombox/protocol': patch
'@loombox/node': patch
'@loombox/web': patch
---

Files and the terminal used to stop working permanently after a node restart,
and blame the offline node for it. The eleven session handlers that guarded on
`if (!bridge) return` (`prompt_inject`, `fs_list_request`, `terminal_open`,
`terminal_input`, `terminal_resize`, `terminal_close`,
`test_runner_config_get/set/detect`, `run_start`, `run_cancel`) never actually
needed the live agent bridge except for `prompt_inject` — listing a directory,
opening a terminal, and running a saved command only ever touched the session
record and its target. Ten of the eleven now resolve that record straight from
`SessionManager`, so they keep working on a session reloaded `'disconnected'`
after a restart exactly as well as on a live one; `prompt_inject` still can't
reach an agent that no longer exists, and stays a logged no-op (no reply
channel exists for it to answer on).

Widens the wire's `session_status` vocabulary with `'disconnected'`
(protocol-side, alongside the existing `'queued'`/`'starting'`) and pushes it
on every reconnect for a node's own disconnected sessions, so the client can
finally tell a session apart from a live one: the session row shows a
"Disconnected" badge and the composer disables itself with an explanation,
instead of offering a prompt that can never be delivered.
