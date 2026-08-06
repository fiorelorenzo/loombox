# loombox node lifecycle — the five decisions Lorenzo took

Status: **settled** (2026-08-06). This is not a proposal. Lorenzo read
`docs/design/node-lifecycle-2026-08-06/index.html` (five decisions, plus one section
of findings that needed none) and picked one option each:

```
A1-2, B1-1, C1-2, D1-1, E1-3
```

Numbering matches the artifact: each item opens with an unnumbered **Today** card, then
options are numbered from 1. Quotes below are the artifact's own trade sentences, so an
implementer can see what was bought without reopening the HTML.

---

## A1-2 — the node ships as a versioned JS bundle, not a checkout and not a binary

`~/.loombox/versions/<version>/`, one esbuild bundle per release plus the two native
modules (`node-pty`, `@napi-rs/keyring`) as prebuilt binaries beside it, with a
`current` symlink the service unit points through, run by the system Node.

Bought: *"updates become the thing #656 asks for and prod already does for the web
bundle: unpack the new version next to the old one, flip a symlink, restart, roll back
by flipping it back. Nothing is ever half-updated, and the running node no longer
depends on a checkout."*

Paid: a real build+publish pipeline (bundle, per-platform native modules, signing, a
place to download from), and a Node runtime must be present on the target — already
true for the ssh path, whose `runtime_bootstrap` step installs Node when missing.

**This is the blocker for everything else.** No package in this repo emits JavaScript
today (`build` is `tsc --noEmit` everywhere, no `dist/`, no `bin`), and the systemd
unit we already generate points `ExecStart` at `$HOME/.loombox/supervisor/supervisor-bin`,
an artifact `SupervisorArtifactSource` declares and nothing implements. So the artifact
work is its own issue, ahead of every platform backend, and `supervisor-artifact.ts`'s
existing verify-before-stage shape is what it must satisfy.

**Explicitly rejected:** A1-1 (run the checkout with tsx) — which is exactly what the
hand-written devbox unit does today, and is why it stays labelled a stop-gap. It welds
a service to a working tree, so a `git pull` decides what the next restart runs.

## B1-1 — platform order stands: macOS local first, then Linux, then Windows

The epic's 4 August order is unchanged. macOS (#654) introduces the supervisor-backend
seam, Linux (#658) fills it in, Windows (#659) last.

Bought: *"the plan stays the plan, and the seam is designed against the platform whose
vocabulary is furthest from systemd's."*

Paid: *"every verification round trips through the Mac, and the machine that is
actually broken stays broken longest."* Accepted knowingly, and cheap now for two
reasons: the devbox node is already supervised by the hand-written unit, and under D1-1
the devbox is not a local-node case at all.

## C1-2 — one-shot handoff, no durable secret at rest

A device token plus a wrapped AMK, written once at provisioning time, unwrapped by the
node with its own device key on first boot, then deleted — the shape zero-touch ssh
provisioning already uses via `LOOMBOX_WRAPPED_AMK_FILE`.

Bought: *"no durable secret at rest: after first boot the machine holds a device token
and a keypair, not the recovery code, and the token can be revoked from the account
without touching the machine."*

Paid, and this is a hard sequencing constraint: *"it only works if the device identity
is genuinely durable, so #815 has to be fixed first or this silently degrades into
're-pair on every reboot'."*

**Therefore #815 blocks C1-2**, and C1-2 is what every backend writes. #815 is P1 for
this reason, not only on its own merits.

The hand-written devbox unit keeps a recovery code in a 0600 `EnvironmentFile` (C1-1's
shape) until the real path exists. That is the stop-gap, not the decision.

## D1-1 — the desktop app is the only install surface; no CLI

Lorenzo: *"il mio flusso reale sarà gui sul mac che usa agenti tramite ssh sulla
devbox ed è il flusso reale o questo o tutto sulla macchina reale"*.

So there are exactly two real topologies, and both start at a GUI on the machine the
user is sitting at:

1. **Mac desktop app → ssh → devbox.** The node runs on the Mac, drives agents on the
   devbox over ssh. Covered by the existing ssh provisioning path, which needs nothing
   new except A1-2's artifact.
2. **Everything local**, on whatever machine that is. Covered by the local backends
   (#654, #658, #659).

Bought: *"exactly the epic's ask, nothing typed, one flow."*

Paid: *"a headless server can never install a node"* — accepted, because under this
topology a headless server never needs to. It is an ssh **target**, driven by a node
that lives on a machine with a GUI; it is not a node host.

**Consequence for the devbox:** its supervised node is a developer convenience, not a
product case. Nothing in #653 is required to make `loombox-node install` exist for it,
and no CLI surface gets designed, documented or tested. If a headless node host ever
becomes a real requirement, that is a new issue that reopens this decision.

## E1-3 — uninstall removes everything by default, with a keep-data flag

Bought: *"'uninstall' means the machine is clean, which is what the word implies."*

Paid: *"irreversible by definition; a mis-click destroys local session history that
exists nowhere else, since the relay only holds ciphertext it cannot read."*

So the confirmation carries the consequence in words, naming what is about to be
destroyed and that the relay cannot restore it — the same "say plainly what will not
survive" rule #658 applies to linger. Keep-data is the explicit opt-out, and device
revocation on the relay happens in both modes: an uninstalled node must never stay
pairable.

---

## What this settles into, in order

1. **#815** — durable node identity. Blocks C1-2, so it is first.
2. **#817** — the versioned node bundle and its release pipeline (A1-2). Blocks every
   backend, including the ssh path that topology 1 depends on.
3. **#654** — macOS local, and the supervisor-backend seam every platform fills in.
4. **#658** — Linux local, filling in the seam.
5. **#659** — Windows local.
6. **#814** — uninstall on that same seam, with E1-3's default.
7. **#656** — self-update, which A1-2 reduces to unpack + symlink flip + restart.

## What is deliberately not built

- A `loombox-node` CLI (D1-1).
- A single-file signed binary (A1-3): rejected in favour of the bundle, and its native
  modules were the reason.
- Any headless-host install flow.
