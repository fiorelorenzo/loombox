---
'@loombox/node': minor
'@loombox/desktop': minor
'@loombox/web': minor
---

macOS-local resident node provisioning, and the supervisor-backend seam every platform fills in (issue #654, epic #653)

Importing a local project on macOS with no node yet now installs, starts, pairs, and announces one — the desktop app's own "Set up a node on this Mac" control, no shell.

- `packages/node/src/supervisor-backend.ts` is new: the platform seam every resident-node backend implements — `install`/`start`/`stop`/`status`/`uninstall`/`survivesReboot`, nothing above it spelling `unit`, `plist`, `systemctl`, or `launchctl`. Two implementations wired: `packages/node/src/launchd/launchd-supervisor-backend.ts` (macOS-local, wrapping the existing `launchd-provisioning.ts` plan/execute mechanism unchanged) and `packages/node/src/ssh/systemd-supervisor-backend.ts` (the `ssh:` path, wrapping the existing `systemd-provisioning.ts` unchanged). #658 (Linux local) and #659 (Windows local) each add one new file implementing this same interface.
- `packages/node/src/local/provision-local-node.ts` is new: composes the shared zero-touch pairing primitives the `ssh:` reference (`provision-and-pair.ts`) already uses — `target_identity`, `mint_node_token`, `amk_handoff`, all reused unchanged — with a `SupervisorBackend.install()` call for THIS machine, dispatched through an injected backend so #658/#659 only ever add a backend, never touch this orchestration.
- `packages/node/src/node-release.ts` is new: `createLocalFsNodeReleaseSource`, the A1-2 versioned-bundle (`~/.loombox/versions/<version>/` + `current` symlink) fetch side for a locally-staged release.
- `apps/desktop/src/main/provisioning/provision-local-node-bridge.ts` + a new `provisionLocalNode` IPC channel (`apps/desktop/src/shared/bridge.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/ipc/handlers.ts`) wire the above for real: resolves the node-bundle version from `@loombox/node`'s own `package.json`, a real launchd `SupervisorBackend`, and a real local-filesystem `fetchArchive`.
- `apps/web/src/lib/local-node-provision.ts` is new: the renderer-side trigger, reached only from inside the desktop shell on macOS. `apps/web/src/lib/components/AddProjectDialog.svelte`'s zero-target empty state offers "Set up a node on this Mac" there instead of the plain no-nodes message; `+page.svelte` supplies the callback using this device's own already-unlocked auth token and AMK (decision C1-2: a one-shot device token plus wrapped AMK, consumed and deleted on the node's first boot, no durable secret at rest). Everywhere else (a PWA tab, another platform, not yet signed in) the empty state is unchanged.
- Decision D1-1 ("the desktop app is the only install surface, no CLI") holds: nothing here adds a `loombox-node` CLI or a headless-host install path.

Verified: `pnpm --filter @loombox/node exec vitest run` (149 files, 1627 passed, 1 skipped), `pnpm --filter @loombox/node typecheck` (0 errors), `pnpm --filter @loombox/desktop exec vitest run` (10 files, 40 passed), `pnpm --filter @loombox/desktop typecheck` (0 errors), `pnpm --filter @loombox/web exec vitest run` (169 files, 2070 passed), `pnpm --filter @loombox/web typecheck` (0 errors), `pnpm exec eslint` on every changed file (clean), full `pnpm format:check` (clean).

Not verified here, and cannot be from this machine (Linux devbox): the plist is asserted as a string in `launchd-supervisor-backend.test.ts`/`launchd-provisioning.test.ts`, never loaded by real `launchd`; `createLaunchdSupervisorBackend`'s `launchctl` calls only ever run against a fake `LaunchdIo` in tests; the full "import a project → node installed, running, paired, announced" path has not run end to end against a real filesystem/keychain/launchd. Needs `scripts/mac-desktop.sh` on the real Mac.
