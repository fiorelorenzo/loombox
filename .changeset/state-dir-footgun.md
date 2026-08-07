---
'@loombox/node': patch
---

Closed the footgun behind issue #876: a `stateDir`-typo'd debug script fell back to `defaultNodeStateDir()` (`~/.loombox/node`) and `NodeIdentityStore.create()` silently overwrote a running node's real identity keypair. `defaultNodeStateDir()` now refuses outside a genuine node entry point unless `LOOMBOX_NODE_STATE_DIR` is set or `allowLiveNodeStateDir()` was called first — `main.ts`'s `start()`, `provisionLocalNode()`, `uninstallNode()`/`resolveNodeUninstallRelayOptions()`, and `runLocalGuidedSetup()` are the only callers that do. `NodeIdentityStore.create()` now refuses to overwrite an already-persisted identity unless called with `{ replaceExisting: true }` (`loadOrCreate()` still behaves exactly as before), and any write that does replace an existing identity file first copies it to `identity.json.bak`.
