---
'@loombox/web': minor
---

Add the per-project TrackerMode picker and live-target configuration UI (SPEC §7.10, issue #220)

`ProjectConfigPanel`'s right-sidebar config surface now has a Tracker section, ahead of MCP servers/plugins since it's the one config choice SPEC §7.10 calls "every project chooses, once" that everything else in a future tracker view will depend on.

A project with no `TrackerMode` set (reading `tracker-mode-store.ts`, issue #209) opens straight into the picker: a `role="radiogroup"` choice between native and live, following #549's precedent for a genuinely mutually-exclusive control. Choosing live reveals a provider choice (GitHub/Jira) and then that provider's own target fields (`owner`/`repo`/optional Projects v2 board number for GitHub, `cloudId`/`projectKey` for Jira) — the fields are conditional on provider, never one flat set. The connected account is picked from a new `ConnectedAccountPicker`, backed by a new `RelayClient.connectedAccounts` store (fed by the `connected_account_list` snapshot #221 already syncs, the same "request once on handshake" shape `sessions` uses). No connected account for the chosen provider renders an `EmptyState` with a real, working next step ("Use native mode instead") rather than an empty dropdown — there is no in-app "connect an account" flow yet (that's #230), so this doesn't invent one.

Once a mode is saved, switching it is explicit: a summary card with a "Change tracker mode" button, not an always-editable form — the editor reopens pre-filled from the current mode, never blank. Draft validation goes through a new `tracker-config-form.ts`, a thin wrapper over `@loombox/protocol`'s own `trackerMode` Zod schema, so the form can never accept something the rest of the app's own re-validation would then reject; a bad or incomplete draft shows a real error, never a silent no-op.

New: `apps/web/src/lib/tracker-config-form.ts`, `apps/web/src/lib/components/ConnectedAccountPicker.svelte`, `apps/web/src/lib/components/TrackerConfigPanel.svelte`, plus their tests. `RelayClient` gained a `connectedAccounts` readable store (relay-client.ts, relay-client.test.ts) and `ProjectConfigPanel`/`+page.svelte` wire it through. `tests-e2e/form-rhythm.spec.ts` gained a case for the new form's field stacking.
