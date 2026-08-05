# Headless dev browser on the devbox — design

Date: 2026-08-05

## Problem

Every UX/UI check so far went through `scripts/mac-desktop.sh --dev`: the Electron
app on the Mac, pointed at the dev loop running on the devbox through a reverse SSH
tunnel. That is overkill for anything that is not Electron-specific, and it is
already lopsided in practice, since the node the desktop app talks to runs on the
devbox anyway.

A headless Chrome tab on the devbox against `http://localhost:5173` is enough, and
it was verified end to end before writing this: `isSecureContext` is true and
`crypto.subtle` exists on localhost even headless, so the app's E2E crypto works;
seeding the bearer session plus completing the real recovery-code onboarding gave a
fully decrypted cockpit (real project tree from the live node, real account), and
clicks, typed keystrokes and ARIA snapshots all reach the app's own handlers.

Two frictions stop that from being a workflow rather than an improvisation:

1. Sign-in is GitHub OAuth only, which cannot be driven from a headless browser
   nobody is sitting in front of. The app authenticates with a bearer token in
   `localStorage` (`loombox:auth-session`), so a token is all that is needed — but
   obtaining one means poking at the dev Postgres by hand.
2. A fresh browser profile is a fresh device: it holds no AMK, so every launch would
   mean walking the recovery-code screen by hand, and the code ends up echoed in the
   agent's transcript through the ARIA snapshot of the input's value.

## Decision

A single script, `scripts/dev-browser-seed.ts`, resolves what a browser needs to be
a signed-in, AMK-holding device on the local dev loop, and writes it to a 0600 file
outside the repo. Nothing else changes: no relay code, no new login path.

- **Bearer token.** Reuse the newest non-expired Better Auth session for the dev
  account; mint one through Better Auth's own `internalAdapter.createSession` when
  there is none, rather than hand-writing a `session` row (schema-agnostic, survives
  a Better Auth upgrade).
- **AMK.** Call `@loombox/node`'s own `bootstrapAmkFromRecoveryCode` with
  `LOOMBOX_RECOVERY_CODE` from `.env.dev.local` — the same relay escrow round trip
  and the same crypto path the app's own new-device flow drives, so nothing about
  the AMK is faked. The synthetic device it registers has a stable, honest identity
  (`devbox-headless-browser`), persisted alongside the seed so repeat runs do not
  pile up device rows.
- **Output.** `~/.loombox/dev-browser-seed.json` (0600), holding
  `{ webUrl, relayUrl, accountId, token, amkBase64 }`. stdout carries only
  non-secret facts (account id, token expiry, whether the token was reused or
  minted) plus the browser-side snippet to apply it. The browser tool reads the file
  inside its own `code`, so neither the token nor the recovery code is ever printed
  into a transcript.
- **Account creation stays on GitHub OAuth.** If the dev database has no user at all
  (right after `scripts/dev.sh --fresh`), the script fails with that exact
  diagnosis: sign in once from a real browser, then headless works again. Enabling
  Better Auth's email/password provider on the dev relay would remove even that
  step, and was deliberately rejected for now — it puts a second login path into a
  production binary for dev convenience, and the workaround costs one sign-in per
  database wipe.

## Docs

- `AGENTS.md` gains a section on the headless route: when it is enough, when the Mac
  is still required (Electron shell, main/preload, window/menus/deep links,
  auto-update, macOS type rendering), and the exact browser-tool recipe.
- `apps/web/playwright.config.ts`'s header claims this box has no browser and that
  the e2e suite only runs on CI. That is stale: Chrome 149 and Playwright's own
  chromium are both installed, and `tests-e2e/pwa-shell.spec.ts` passes 4/4 in 20s
  locally. Corrected, since it is exactly the kind of comment that talks a future
  agent out of verifying its own work.

## Verification

Running the script against a live `scripts/dev.sh` loop and driving a headless tab
from the seed to a decrypted cockpit — the observable result is the cockpit, so that
is the proof. No unit test: the script is pure I/O glue over the dev Postgres, the
dev relay and one file, and a hermetic fake of all three would assert only that the
fake was called.
