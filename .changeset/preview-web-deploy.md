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

Verified for real against prodbox, not merged to `main` (this PR stays open per the wave's own instructions):

- `preview.loombox.dev` DNS (A record, DNS-only, `152.53.44.195`) and the Caddy site block are live; Let's Encrypt already issued a real cert (`subject: CN=preview.loombox.dev`, verified with `openssl`/`curl`), and production's `app.loombox.dev` / `relay.loombox.dev` were re-checked immediately after the Caddy reload — both still 200/`{"status":"ok"}`.
- `scripts/deploy-preview.sh` was run by hand end to end against the real `/opt/apps/loombox-preview` (a real git checkout of this branch's HEAD, bundled and cloned onto prodbox rather than merged to `main`, plus the artifact `pnpm --filter @loombox/web build` actually produces). It built the image, flipped `releases/current`, recreated the container, and its health gate passed: `https://preview.loombox.dev/_app/version.json` returned `{"version":"<this deploy's real commit sha>"}`, matching the artifact exactly.
- The app itself was opened live in a browser at `https://preview.loombox.dev/` — the real gate/sign-in screen renders, offering GitHub sign-in only (no Google button, matching preview's relay config), against `PUBLIC_LOOMBOX_RELAY_URL: wss://preview-relay.loombox.dev` baked into the served HTML.
- Production's containers, checked before and after every step above with `docker ps --format` filtered to `relay-relay-1` / `relay-postgres-1` / `web-web-1`: identical container IDs throughout, never recreated, never restarted.

- A second real deploy (`29a1e14`) landed on top of the first (`c65912c`): `web_rebuild=false` correctly skipped the Docker image rebuild since `pnpm-lock.yaml`/`apps/web/package.json` hadn't changed, so it only unpacked the new release, flipped the symlink, and recreated the container — the whole run took ~5s instead of the ~140s the first (image-building) deploy took. Its health gate matched the new commit.
- Rollback rehearsed for real, not described: ran `CONTRIBUTING.md`'s documented by-hand procedure (now mirrored for preview in `deploy/web/README.md`) against these two real releases — `DEPLOYED.json`'s `previousSha` pointed at `c65912c`, flipped `releases/current` back to it, force-recreated the container, and `https://preview.loombox.dev/_app/version.json` came back `{"version":"c65912c…"}` again, confirming the flip actually took effect on the live site. Then flipped forward again to `29a1e14` (the branch's real HEAD) to leave preview serving the latest commit rather than stranded mid-rehearsal.
