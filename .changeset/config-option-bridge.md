---
'@loombox/protocol': patch
'@loombox/relay': patch
'@loombox/node': patch
'@loombox/supervisor': patch
'@loombox/web': patch
---

Fix the node dropping the config_option wire message, so changing model or thinking effort never reached the agent (issue #718)

This is the last of three gaps in the same chain. #705 seeded the config-option catalogue from session/new so the pickers had something to show. #707 fixed AcpClient.setConfigOption to send and read the real ACP wire shape. Neither mattered on their own: RelayClient.setConfigOption sent a real config_option wire message, the relay routed it to the owning node correctly, and NodeDaemon.handleInbound hit its default case and dropped it. The comment said so outright. So the only thing that ever happened was the client's own optimistic guess at the new value, which the next real config_options push from the agent would silently revert.

NodeDaemon.handleInbound now handles config_option: it calls through to the session's live AgentSession.setConfigOption (a new method, delegating to AcpClient.setConfigOption), gated on the same lease check prompt_inject uses for an ssh: session. I confirmed the wire message's existing {category, optionId} shape needed no changes: #707 already resolves configId/type from the session's own catalogue entry.

A rejected set has to reach the user, not die in a console.warn. There was no wire shape to carry that, so I added one: config_option_result, a new node-to-client reply carrying outcome: 'ok' | 'error' plus the agent's own rejection message, correlated by category rather than a request id (config_option never had one, and category is the natural key every config-option store in this codebase already groups on). Fanned out to a session's subscribed clients exactly like fs_list_response.

I dropped the client's optimistic update rather than keep and reconcile it. With a real round trip, the agent's own config_options push is what actually updates the picker, so there is no local guess left to ever have to revert on a rejection. RelayClient now tracks which categories it has an outstanding config_option for, so it can tell its own pending request apart from a sibling device's, and publishes a ConfigOptionErrorNotice (mirrors the existing PermissionStaleNotice) when the agent refuses.

A config_option for a session with no live agent (reloaded 'disconnected' after a restart, a real state since #702) now answers honestly with config_option_result: error instead of being silently dropped.

Verified against a real omp acp binary through a real node: set the model, set the thinking effort, read both back off the agent's own config_options push, and confirmed a real rejection ("Unknown ACP model: ...") reaches config_option_result. Added a node-level test driving the real config_option wire message; reverted the handler and watched it fail with the exact old symptom before restoring the fix.
