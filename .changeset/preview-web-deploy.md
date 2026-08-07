---
'@loombox/web': minor
---

Preview web deployment and its promotion path (issue #865, epic #863)

`preview.loombox.dev`, deployed by reusing production's own machinery rather than growing a second one:

- `svelte.config.js`'s `kit.version.name` now reads `LOOMBOX_BUILD_COMMIT` (the same env var `packages/relay/src/build-identity.ts` already reads at relay boot, reused here rather than a second name) — set by the new shared `build-web.yml` reusable workflow to the commit actually being built. This is a live behavior change for production too: `client/_app/version.json`'s `.version` field now carries the real git commit instead of a build timestamp.
- Settings > Appearance gained a "Build \<sha\>" line (`SettingsPage.svelte`, `data-testid="web-build-version"`) reading `$app/environment`'s `version` — the same value the health gate below compares. A preview (or production) session now shows which commit it's running without SSHing to the box.
- `scripts/deploy-preview.sh` is `scripts/deploy-prod.sh`'s shape (`releases/<sha>` + `current` symlink, the same served-build-identity health gate, the same rollback-on-failure) minus the tag argument and the relay half — preview's relay (#864) stays a separate, manually-managed deployment.
- **The decision**: what promotes a change to preview is every push to `main` (`.github/workflows/deploy-preview.yml`), not a `preview-*` tag/dispatch or a dedicated `preview` branch. Argued in full in `deploy/web/README.md`'s "Preview environment" section and `CONTRIBUTING.md`'s "Deploying to preview" section.
- `deploy/web-preview/` (compose project `loombox-web-preview`, port `5188` — recorded in `docs/deploy-relay.md`'s port table) mirrors `deploy/web/` exactly, pointed at `preview-relay.loombox.dev` by default rather than production's relay.

Verified for real against prodbox, not merged to `main` (this PR stays open per the wave's own instructions): `preview.loombox.dev` DNS (A record, DNS-only) and Caddy site block are live, `scripts/deploy-preview.sh` has been run by hand end to end against the real `/opt/apps/loombox-preview`, its health gate passed (`/_app/version.json` matched the deployed artifact), and a rollback between two real releases was rehearsed and confirmed by watching the served version change back — full transcript in the PR body, including production's container IDs before and after every step.
