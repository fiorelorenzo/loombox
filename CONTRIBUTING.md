# Contributing to loombox

Thanks for working on loombox. This document covers the two things that are easy
to get wrong: the clean-room licensing rule and the local dev flow.

## Clean-room rule (read this first)

loombox is **greenfield and MIT-licensed** (see [LICENSE](LICENSE)). It draws
**design inspiration** from a handful of existing tools, but it imports or copies
**no code** from any of them. Reimplement; never vendor.

| Tool      | License      | What we borrow                                                                  |
| --------- | ------------ | ------------------------------------------------------------------------------- |
| emdash    | Apache-2.0   | SSH/worktree/mise-PATH mechanics; provider-agnostic ACP (design only)           |
| Happy     | MIT          | relay + PWA architecture, E2E crypto primitives, push suppression (design only) |
| Nimbalyst | MIT (client) | per-device E2E protocol shape, tracker-importer pattern (design only)           |
| **HAPI**  | **AGPL-3.0** | BYO-key voice **idea only**                                                     |

**HAPI is AGPL-3.0. This is a hard process gate:**

- **Never clone, copy, vendor, or otherwise place HAPI source in any workspace
  this repo's tooling or agents touch.** Design inspiration is fine; a local
  checkout is not.
- Do not copy code from emdash, Happy, or Nimbalyst either. Their permissive
  licenses would allow it, but the deliberate choice to reimplement keeps our
  licensing clean and avoids a permanent multi-upstream maintenance burden.
- Every dependency must be MIT/BSD/ISC/Apache-2.0-class. A CI job
  (`pnpm license:check`) fails the build if any production dependency introduces
  an AGPL/GPL-family license.
- Every pull request must tick the "no code copied from HAPI or any AGPL source"
  box in the PR template.

If you are unsure whether something crosses the line, treat it as if it does and
ask in the PR.

## Local development

Prerequisites: Node (see [.node-version](.node-version)) and
[pnpm](https://pnpm.io) 11.x. On the dev box, runtimes come from `mise`.

```bash
pnpm install            # install the whole workspace
pnpm -r typecheck       # typecheck every package
pnpm lint               # lint the whole repo
pnpm test               # run the full Vitest suite
pnpm format             # apply Prettier
```

The CI gate (`.github/workflows/ci.yml`) runs lint + format check + typecheck +
test + the license scan on every PR. Keep `main` green.

## Local dev loop

`scripts/dev.sh` brings up relay + node daemon + web PWA together as plain
host processes (`tsx watch` / `vite dev`), so you get real HMR and
attachable debuggers at full production parity: a real Postgres database,
real Better Auth, and a real GitHub OAuth device/session flow, not a
stubbed one. There's no offline mode — see AGENTS.md and the script's own
header comment for why that's deliberate.

One-time setup: run `scripts/dev.sh` once. It copies `.env.dev.example` to
the gitignored `.env.dev.local` and stops, telling you to register a GitHub
OAuth App on your own GitHub account (Settings > Developer settings >
OAuth Apps > New OAuth App) with Homepage URL `http://localhost:5173` and
Authorization callback URL `http://localhost:8790/api/auth/callback/github`,
then paste the generated client id/secret into `.env.dev.local`. Everything
else in that file — the Better Auth signing secret, the node daemon's
device token — either fills itself in or is optional until you actually
need the node; see the comments in `.env.dev.example` for the full flow.
Run `scripts/dev.sh` again and it brings up a dockerized dev Postgres, then
the relay, then the web app, waiting on each one's own health check before
starting the next rather than racing them.

The port map is fixed on purpose — the GitHub callback above and Better
Auth's trusted-origins check are both registered against these exact ports:

| Service         | Address                                          |
| --------------- | ------------------------------------------------ |
| web (HMR)       | http://localhost:5173                            |
| relay           | http://localhost:8790 (`ws://localhost:8790/ws`) |
| postgres        | 127.0.0.1:5435                                   |
| relay inspector | 127.0.0.1:9230                                   |
| node inspector  | 127.0.0.1:9231                                   |

To attach a debugger, point Chrome's `chrome://inspect` (or VS Code's
"Attach to Node Process") at `127.0.0.1:9230` for the relay or
`127.0.0.1:9231` for the node — both stay open for the life of the process,
across every `tsx watch` restart. `Ctrl+C` stops relay/node/web but leaves
Postgres running, since it holds your signed-in account and sessions;
re-onboarding through GitHub OAuth on every restart would defeat the point
of the loop. Use `scripts/dev.sh --stop` to also stop Postgres, or
`--fresh` to wipe its data and start over with a clean database.

If you're testing the desktop app on the Mac (see AGENTS.md), `scripts/dev.sh`
opens reverse SSH forwards automatically (`--no-mac` to skip them) so the
Mac's own `http://localhost:5173` reaches this box's dev server — the same
"localhost is a secure context" reasoning as the GitHub callback above, so
the app's E2E crypto works on the Mac with no certificate and no Chromium
flags.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/).
- **Changesets:** any change to a released package ships a changeset
  (`pnpm changeset`). See [.changeset/README.md](.changeset/README.md) and
  [Releases](#releases) below.
- **Tests from commit one:** every package ships tests. Vitest for unit/
  integration, Playwright for the PWA. Prefer writing the test first.
- **Spec is the source of truth:** read the relevant `SPEC.md` section(s) before
  implementing, and check `SPEC.md` §16 for the grounded reference to build
  against.

## Releases

loombox uses [Changesets](https://github.com/changesets/changesets) for
per-package semver, changelogs, and GitHub Releases. **No package is published
to npm** — every package in this monorepo is `package.json`'s `"private": true`
and there is no registry configured (`access: "restricted"` in
[.changeset/config.json](.changeset/config.json) is just the safe default, it
never gets exercised). "Releasing" here means: bump versions, write
`CHANGELOG.md` entries, tag the commit, and create a GitHub Release per
package.

`.changeset/config.json`'s `ignore` array is deliberately **empty**, so every
workspace package versions together. It used to list `@loombox/web`,
`@loombox/mobile` and the eslint config as "not independently released", and
that broke the release workflow outright: Changesets refuses a changeset that
mentions both an ignored and a non-ignored package, and almost every real
change here touches `apps/web` alongside `packages/*`. Six of thirteen pending
changesets were in that state, `release.yml` had failed on every push to main
for as long as those changesets existed, so no version PR was ever opened and
every package sat at `0.0.0`. Ignoring the app that changes most also meant it
got no changelog. Keep the array empty: a package that genuinely has nothing
to say in a release simply has no changeset mentioning it, which already
leaves it alone.

**As a contributor:** when your change affects any package or app, run
`pnpm changeset` before opening your PR, pick the affected package(s) and a
semver bump, and write a short summary. The generated Markdown file goes in
`.changeset/` and is committed alongside your change. Purely internal changes
(docs, CI/tooling, tests with no package behavior change) don't need one.

**What happens after merge** (`.github/workflows/release.yml`, using
[changesets/action](https://github.com/changesets/action)):

1. Every push to `main` checks for pending changesets. If there are any, the
   workflow opens (or updates) a "Version Packages" PR that runs
   `pnpm version-packages` (`changeset version`): it consumes the pending
   changesets, bumps each affected package's version, writes/updates its
   `CHANGELOG.md`, and deletes the consumed changeset files.
2. Merging that PR back into `main` triggers the workflow again. This time
   there are no pending changesets, so it runs `pnpm release`
   (`changeset publish`) instead: this tags the versioned commit (per package,
   `<pkg-name>@<version>`) and skips the actual `npm publish` step because
   every package is private. `changesets/action` then pushes those tags and
   creates a GitHub Release per tag, with the changelog entry as the release
   body.

No manual version bumps or hand-written tags: the version + tag + release all
come from the changeset(s) that landed on `main`. The workflow needs
"Allow GitHub Actions to create and approve pull requests" enabled under
**Settings → Actions → General → Workflow permissions** (already on for this
repo) or it can't open the Version Packages PR.

## Deploying to prod

loombox ships to prodbox (`app.loombox.dev`, `relay.loombox.dev`) via a
tag-triggered pipeline: pushing a `vX.Y.Z` tag deploys that exact commit,
automatically, through a self-hosted GitHub Actions runner that lives on
prodbox. `.github/workflows/deploy-prod.yml` and `scripts/deploy-prod.sh`
are the mechanics (heavily commented); this section covers what a human
needs to know.

This is independent of the [Releases](#releases) changesets flow above:
changesets tags individual packages (`@loombox/relay@0.4.0`, etc.) purely
for changelog/GitHub-Release bookkeeping and never deploys anything. A
`vX.Y.Z` tag is a separate, deliberate "ship main to prod now" marker a
human cuts by hand. The two tag namespaces can't collide (`v*` vs.
`@loombox/*@*`), so there's no ambiguity about which triggers what.

### Cutting a release tag

From a `main` you already expect to be green in CI — the pipeline checks
this itself and refuses to deploy otherwise, see below:

```bash
git checkout main && git pull
git tag -a v2026.07.29 -m "deploy 2026-07-29"   # see below for the version
git push origin v2026.07.29
```

There's no single "loombox version" tracked anywhere — every package under
`packages/*` versions independently via changesets — so this tag is just a
human-facing marker of deploy history, not a package version. A date-based
tag like the example above is the least confusing convention (it answers
"when did this ship" without implying a semver bump of anything in
particular), but a plain incrementing `vX.Y.Z` works too; either is fine as
long as it sorts after the previous one. Check the last one with:
`git tag -l 'v*' | sort -V | tail -1`.

### What the pipeline does

1. **`build-web`** (GitHub-hosted `ubuntu-latest`): checks out the tag,
   installs the workspace, builds `@loombox/web`, uploads `apps/web/build/`
   as an artifact. Runs off-box on purpose — prodbox has 4 shared vCPUs and
   also hosts pitchbox and embertold, so the monorepo install and build
   never touch it.
2. **`deploy`** (self-hosted, on prodbox): first confirms the tagged commit
   has a completed, successful `ci.yml` run. A tag is pushed by hand, and
   per [AGENTS.md](AGENTS.md)'s local-verification notes this repo's merge
   gate is procedural rather than a branch-protection rule (private
   free-tier repo, no "required checks"), so nothing else stops someone
   tagging a commit CI never saw or already failed. This is the backstop.
   It then runs `scripts/deploy-prod.sh`, which:
   - syncs the tagged source into `/opt/apps/loombox` (relay's `.env` and
     backups, and the release/deploy-record state below, are excluded from
     the sync and never touched);
   - unpacks the built web bundle into a new `releases/<sha>/` and
     atomically flips the `releases/current` symlink at it;
   - rebuilds the relay's and/or web's Docker image only if something that
     actually affects that image changed (the dependency lockfile, or,
     for the relay, its own source) — most deploys are web-only content
     changes and rebuild nothing, so the relay isn't even restarted (a
     restart would drop every live WebSocket connection for no reason);
   - health-gates the result against the relay's `/health`, the public
     site, and a comparison of the served build's identity against what
     was actually just deployed — a green HTTP status alone has, before,
     turned out to still be serving a stale cached Docker layer;
   - on any failure past the flip, rolls back to the last known-good
     release/image itself and fails the workflow red. Only on success does
     it record `DEPLOYED.json` and prune old releases.

A web-only deploy usually finishes in a couple of minutes; a relay rebuild
(rare) takes longer.

### Checking what's live

```bash
ssh prodbox cat /opt/apps/loombox/DEPLOYED.json
```

Shows the deployed tag, commit, timestamp, who/what triggered it, the
previous commit (today's rollback target), and the content hashes the next
deploy diffs against to decide whether either image needs rebuilding.
`releases/current` on prodbox is a symlink to `releases/<sha>/`; the
running web container is whatever it currently resolves to
(`deploy/web/docker-compose.live.yml` bind-mounts it straight in). A quick
check that doesn't need SSH at all: `curl -s
https://app.loombox.dev/_app/version.json` — compare it against
`apps/web/build/client/_app/version.json` from the commit you expect to be
live.

### Rolling back by hand

The pipeline already rolls itself back automatically when a deploy's own
health gate fails. Hand-rollback is for the other case: a release that
passed its health gate but turned out to have a real bug. On prodbox:

```bash
ssh prodbox
cd /opt/apps/loombox
prev=$(jq -r '.previousSha // empty' DEPLOYED.json)
# Empty means there is nothing to roll back TO: this is the first deploy the
# pipeline ever made on this box. Re-deploy a known-good tag instead.
[ -n "$prev" ] && [ -d "releases/$prev" ] || echo 'no previous release on this box'
ln -sfn "$prev" releases/current.tmp && mv -T releases/current.tmp releases/current
cd deploy/web
docker compose -f docker-compose.yml -f docker-compose.live.yml \
  up -d --force-recreate --no-build --no-deps web
```

(`ln -sfn` + `mv -T` rather than a bare `ln -sfn` onto the live symlink: the
swap is then atomic, so a reader never catches `current` mid-replacement. The
`-n` matters either way, since without it `ln` would helpfully create the new
link _inside_ the directory the old one points at.)

`--force-recreate` is load-bearing and was measured: `docker compose restart`
does re-resolve a flipped symlink, but it never re-reads compose config, so
only a recreate is correct in every case. Verified live on 2026-07-29 by
flipping between two real releases and watching the served
`_app/version.json` change.

That covers the common case (web-only). If the release you're undoing also
rebuilt the relay, its pre-deploy image was tagged before the rebuild as
`relay-relay:latest-rollback` — restore it the same way
`scripts/deploy-prod.sh`'s own rollback path does:

```bash
docker tag relay-relay:latest-rollback relay-relay:latest
cd /opt/apps/loombox/deploy/relay
docker compose up -d --force-recreate --no-build --no-deps relay
```

(That rollback tag only exists if a relay rebuild actually ran during the
deploy you're undoing — `DEPLOYED.json`'s `inputs.relaySrc` changing
between the last two deploys is how to tell.)

For fast iteration on the web app against real prod infra without cutting a
release tag for every fix, see `scripts/deploy-web.sh`'s header — it's the
unofficial, faster sibling of this pipeline, not a replacement for it.

### Deploying to preview

A second, fully isolated environment for testing changes before they reach
production, at `preview.loombox.dev` / `preview-relay.loombox.dev`. The
relay half (#864) is a manual bring-up, not auto-deployed - its own
compose project, its own Postgres, its own GitHub OAuth App, sharing
nothing with the pipeline above; see `docs/deploy-relay.md`'s "Preview
environment" section for the full runbook, including the one step that's
manual on purpose (GitHub OAuth Apps have no creation API).

The web half (#865, epic #863) **is** auto-deployed, on every push to
`main` (`.github/workflows/deploy-preview.yml`,
`scripts/deploy-preview.sh`), deliberately a different promotion trigger
than production's tag-cut pipeline above. `deploy/web/README.md`'s own
"Preview environment" section has the full argument for why push-to-main
won this over a `preview-*` tag/dispatch or a dedicated `preview` branch
(the short version: the other two can silently drift from what main
actually looks like, which is the one failure mode that makes a preview
environment worthless), how the served commit stays provably matched to
the artifact (the exact same `client/_app/version.json` health gate
`deploy-prod.sh` uses), how it's visible in the app itself (Settings >
Appearance's Build line), and how to roll it back by hand.

`build-web.yml` is the one place both pipelines get the web bundle from -
split out of `deploy-prod.yml` when this pipeline was added so there is
exactly one job that knows how to build `@loombox/web`, not two that can
drift apart.
