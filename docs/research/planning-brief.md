# Custom agent cockpit — planning brief

**Status: planning / brainstorm input only. Nothing below is a finalized or approved design.** It is decision-support material — a teardown-grounded synthesis meant to be argued with, not signed off on. Treat every recommendation as a default to challenge, not a decision already made.

## Product thesis

The four incumbents each nail one slice and admit-by-absence to the others:

- **emdash** (Apache-2.0) — SSH-remote multi-worktree orchestration works. Zero mobile, sync, crypto, or voice code exists anywhere in the repo (confirmed by grep: no `react-native`/`expo`, no `e2e`/`end-to-end-encryption` hits outside test fixtures).
- **happy** (MIT) — a genuinely self-hostable, cross-platform (Expo) sync relay with real client-side E2E crypto works. No worktree parallelism; voice is hardcoded to the maintainers' ElevenLabs account + RevenueCat paywall.
- **hapi** (AGPL-3.0, fork of happy-cli) — BYO-key, multi-backend voice (ElevenLabs/Gemini Live/Qwen) and a 7-provider agent hub work. No SSH code anywhere in the repo; its own source comment states self-hosting drops E2E entirely (`hub/src/sync/syncEngine.ts:7`: "No E2E encryption; data is stored as JSON in SQLite").
- **nimbalyst** (MIT client, closed-source server) — a clean, server-blind E2E wire protocol and a zero-token tracker-import pattern (shells out to `gh`) work. Agent execution never leaves localhost (`store.ts:1770` rejects non-loopback upstream by design); the real sync server is not in the repo at all.

No single tool combines "agents actually run on my devbox" + "I can steer from my phone" + "I own the relay and it structurally cannot read my data" + "voice runs on keys I hold." The product is the bridge between these four proof points, built for **one self-hosting power-user**, not a team product.

**One-line vision:** emdash's SSH-orchestrated parallel worktrees, in your pocket, over a relay you host and encrypt yourself, with voice on your own keys.

---

## Best-of teardown matrix

| Target capability | Borrow from | How (standout files) |
|---|---|---|
| Remote SSH exec on the devbox | **emdash** (port) | `core/ssh/lifecycle/ssh-connection-manager.ts` + `ssh-client-proxy.ts` (pooled, generation-counter-safe reconnect), `core/ssh/lifecycle/remote-shell-profile.ts` (the mise/PATH-on-non-interactive-shell fix), `core/projects/worktrees/worktree-service.ts` (pool containment, branch-base metadata), `core/port-forwards/port-forward-tunnel.ts` |
| Multi-agent provider support | **happy** (port) + emdash (inspiration) | `packages/happy-cli/src/agent/core/AgentBackend.ts`, `AgentRegistry.ts`, `agent/acp/*` (generic ACP backend); emdash's `core/agents/plugin-registry.ts` parity-check pattern |
| Mobile/web companion | **happy** (fork/port) + nimbalyst (protocol inspiration) | `packages/happy-app/sources/sync/sync.ts` (per-session `InvalidateSync` caching for instant device switching); nimbalyst `packages/collab-protocol/src/personal.ts` (`DeviceInfo`, `CreateWorktreeRequestMessage`, `SessionControlCommandMessage` — design reference only, no working server) |
| Self-hostable sync relay | **happy** (fork) + nimbalyst (protocol reimplementation) | `packages/happy-server/sources/main.ts`, `Dockerfile.server` (real multi-stage Docker deploy, Postgres+Redis+env-var config); redesign schema around nimbalyst's room model |
| E2E encryption | **happy** (implementation) + nimbalyst (device-key model) | `packages/happy-cli/src/api/encryption.ts` (tweetnacl secretbox / AES-256-GCM, documented byte layout); nimbalyst `ECDHKeyManager.ts` + `TrackerEnvelopeCrypto.ts` (per-device ECDH P-256 keys, AAD-bound resource id — fixes a real spoofing hole its own comments describe) |
| BYO-key voice | **hapi** (design only — no code copied, AGPL) | `shared/src/voice.ts` (`VoiceBackendType` enum, `listConfiguredVoiceBackends` driven by operator env vars), `hub/src/web/routes/voice.ts` (token proxy, raw keys never reach client) |
| Tracker issue import | **nimbalyst** (port) + emdash (port) | `packages/extension-sdk/src/types/trackerImporter.ts` + `packages/extensions/github-issues-importer/src/backend.ts` (zero-token, shells out to `gh`); emdash `core/jira/jira-issue-provider.ts` (JQL fallback chain) |
| Visual review / diffing | **happy** (port, v1) + hapi (v2 upgrade) | `packages/happy-app/sources/components/diff/PierreDiffView.tsx` (unified/split); hapi `cli/src/modules/difftastic/` for later structural (AST-aware) diffing |
| Push notifications / device switching | **happy** + hapi (port) + nimbalyst (protocol ref) | `packages/happy-server/sources/app/push/pushDispatch.ts` (active-client suppression); hapi `hub/src/push/pushService.ts` (self-owned VAPID keys, no vendor relay) |

Full per-tool architecture notes, strengths, and "what to avoid" lists are in the source teardowns (not reproduced here for length — ask if you want the underlying detail re-surfaced).

---

## MoSCoW requirements

**Must**
- Desktop app connects to the devbox over SSH, runs each agent session in its own isolated git worktree (port emdash's SSH pooling + `remote-shell-profile.ts` + `WorktreeService`).
- Pluggable multi-provider agent adapter, scoped to **Claude Code + Codex** at launch, built on an ACP-generic backend (happy) — do not chase emdash's ~30 or hapi's 7-provider breadth.
- A relay, self-hostable via Docker on the user's own infra (prodbox), fanning out session/message state to desktop + mobile/web (fork happy-server's Fastify+Socket.IO+Postgres + `Dockerfile.server`).
- Relay is architecturally blind to content — only ciphertext crosses the wire and sits in its DB (port happy's `encryption.ts`, adopt nimbalyst's AAD-bound-resource-id + per-device ECDH wrapping).
- Mobile/web client to view live sessions, steer them (follow-up prompts, approve/deny tool calls), continue any session started on desktop (fork happy-app's Expo shell + `InvalidateSync` pattern).
- SSH/devbox credentials never leave the desktop; never held by relay or phone. Mobile steers through the relay's session protocol, never obtains the SSH key.
- Self-hosted push (operator-owned VAPID keys, no vendor push relay).

**Should**
- BYO-key voice (port hapi's backend-abstraction *shape*, not its AGPL code).
- Basic code-diff viewer on mobile/web (happy's PierreDiffView).
- One-way, read-only tracker import: GitHub Issues via `gh`, Jira via the existing MCP/JQL fallback chain. No write-back.
- Active-device push suppression (happy's `pushDispatch.ts` pattern).
- A resident daemon on the devbox (not raw per-command SSH-exec) so sessions survive a dropped connection and mobile can reconnect/resume, inspired by happy-cli's daemon/control-server.

**Could**
- Structural (AST-aware) diffing via difftastic (hapi) as a v2 upgrade.
- Additional providers (Gemini, OpenCode, Cursor) once the core loop is proven.
- Multiple simultaneous devbox targets.
- Telegram or similar secondary control/notification channel (hapi's pattern).
- Tracker-triggered session creation (a Jira ticket spins up a worktree+session automatically).
- A thin native mobile wrapper around the web client, once the PWA proves the loop.

**Won't**
- Multi-user/team collaboration, org permissioning, social/sharing features.
- Two-way tracker sync (write-back to Jira/GitHub Issues).
- Matching emdash's ~30-provider or hapi's 7-provider breadth in v1.
- Nimbalyst's collaborative rich-text editor / Lexical tracker-as-document system (only its crypto and import *design* is borrowed).
- An officially-hosted/managed relay-as-a-service — the whole point is the user runs their own.
- Copying hapi's hub/sync/socket code verbatim (AGPL-3.0 network copyleft) — read-only design inspiration only.
- Vendor-locked voice (happy's hardcoded ElevenLabs+RevenueCat) — the explicit anti-pattern.

---

## Candidate architectures

| | **Two Forks + Bridge** (emdash core + happy relay/mobile) | **Greenfield Monorepo** | **Composed Glue** (run 3 services as-is + coordination layer) |
|---|---|---|---|
| Build strategy | Fork emdash (extract SSH/worktree/ACP modules) + fork happy-server/happy-app; new resident devbox daemon + new E2E protocol bridges them | One new pnpm/Turborepo monorepo; hand-port every module as its own package; nothing forked wholesale | Run emdash (+ thin local API shim), self-hosted happy-server, and hapi hub (voice-tokens only) as live services; one new coordination-bridge process glues them |
| Effort estimate | ~24–30 eng-weeks | ~26–32 eng-weeks | ~12–18 eng-weeks (core loop 9–13wk, +voice 2–3wk) |
| Key pros | Reuses the two hardest, most battle-tested subsystems as *working* code (SSH pooling, mise/PATH fix, worktrees, a real deployed Dockerfile.server, a working Expo sync engine); clean permissive licensing; isolates the one genuinely novel piece (devbox daemon) instead of hiding it | Cleanest long-term result: one build system, schema designed E2E-first from day one, no inherited cruft (30-provider surface, dead Prisma models, AGPL) | Fastest to a demo; inherits emdash's mechanics completely unmodified; hapi usable at arm's length without ever touching AGPL code |
| Key cons | Two upstreams to track/re-sync indefinitely; devbox daemon and multi-device E2E key distribution have no working precedent anywhere in the 4 tools | Highest effort for no free head start — every port is a rewrite-with-reference, not a `git pull`; no upstream bugfix stream afterward | No resident daemon → mobile reconnect/resume is structurally unreachable; happy-server's default push is vendor Expo-token (violates a must-have); happy's crypto alone is weaker than the required per-device model; author's own write-up concludes it "is not a credible full-MVP architecture on its own" |

### Recommended: Two Forks + Bridge (emdash core + happy relay/mobile, new E2E protocol)

Rationale: it is the only candidate that satisfies the **full must-have list using working, already-deployed software** rather than paper designs or a rewrite. emdash's SSH/worktree/mise-PATH mechanics, happy-server's production Dockerfile relay, and happy-app's Expo sync engine are real, running code today — not teardown notes to re-derive. It correctly isolates the one genuinely new piece of engineering (a resident devbox daemon for reconnect/resume) as the place to budget the most schedule risk, rather than framing the whole thing as "just wire it together" (the failure mode of Composed Glue). Compared to Greenfield, it reaches the same MVP scope for meaningfully less effort by not discarding two working codebases' worth of already-solved problems — at the cost of an ongoing, manageable two-upstream maintenance burden that's a reasonable price for a solo-operator tool.

**Ideas grafted from the other two, worth folding in regardless of which architecture is chosen:**
- From Composed Glue: run a fast, low-commitment **validation spike first** — unmodified emdash + a light local control-plane shim + self-hosted happy-server (as-is protocol, no crypto/protocol redesign yet) to prove "can I see and steer a devbox session from my phone at all" before sinking weeks into the new devbox daemon and E2E protocol.
- From Composed Glue: its call-out that happy-server ships **Expo-push-token notifications by default**, which directly violates the no-vendor-push-relay must-have — this needs to be an explicit "rip out Expo push, replace with self-owned VAPID" step in the plan, not something left quietly vendor-based after the fork.
- From Composed Glue: hapi's hub deployed as an arm's-length Docker service scoped strictly to its voice token-proxy routes is a legitimate faster should-have voice v1 (copies no code, stays outside AGPL) — worth evaluating as a stopgap even though full reimplementation is the safer long-term posture.
- From Greenfield: promote the **desktop-offline topology gap** (mobile sees last-known state but can't get live output or steer if the desktop itself is fully down, not just transiently dropped) to an explicit, named decision point — don't let the daemon design quietly assume an answer either way.
- From Greenfield: a shared, **versioned schema package** (Zod-typed) for the wire protocol, and a requirement that each ported module (SSH race-safety, shell-profile env capture, worktree containment checks) be diffed against its original during review so edge-case handling isn't silently dropped in extraction.
- From Greenfield: an explicit **process gate against AGPL contamination** (no local hapi clone on the machine building this product, or a mandatory checklist review step) rather than relying on stated intent alone — both architectures touch hapi for voice/push inspiration.

---

## Open decisions for you

**None of this is decided.** These are the sharp questions that need answers before a `spec.md` can be written.

1. **Build strategy: fork(s) vs. greenfield vs. composed glue?**
   - Options: (a) two forks bridged by a new protocol — emdash core + happy relay/mobile; (b) greenfield monorepo, hand-port everything; (c) composed glue — run emdash/happy-server/hapi hub as near-unmodified services plus a coordination layer.
   - Recommendation: (a), with a fast (b)-flavored validation spike (unmodified emdash + shim + self-hosted happy-server) done first to prove the core loop before committing to the devbox daemon/E2E build-out.

2. **Agent provider scope for v1?**
   - Options: match emdash's ~30 providers; match hapi's 7; match happy's 3-plus-ACP; minimal — Claude Code + Codex only, ACP backend wired in from day one.
   - Recommendation: Claude Code + Codex only, on happy's ACP-generic backend, so future providers are absorbed near-free later.

3. **First client: native mobile vs. web-PWA?**
   - Options: native Expo app first (happy's approach — real background push, native voice APIs); web-PWA first (hapi's approach — no App Store friction); ship both simultaneously.
   - Recommendation: web-PWA first, native Expo wrapper deferred to could-have, given push/voice are should/could-have, not launch-blocking.

4. **Voice priority: build now vs. defer?**
   - Options: ship BYO-key voice in v1 as a core differentiator; defer entirely post-v1; ship a minimal single-backend voice now, defer multi-backend fallback.
   - Recommendation: defer to post-v1 (should-have). None of the four tools show a working self-hosted + E2E + BYO-key voice combination together — prove the core cockpit loop first.

5. **Self-host topology across devbox + prodbox: how exposed is the relay?**
   - Options: relay on prodbox, Tailscale-only exposure (phone joins the tailnet); relay on prodbox exposed publicly via Caddy/Let's Encrypt on a subdomain; relay and agent execution merged onto one host.
   - Recommendation: relay on prodbox (Docker+Caddy+Tailscale already provisioned there), Tailscale-only in v1; public Caddy-fronted subdomain as a should/could-have upgrade once reachability-without-Tailscale is actually needed. Note this directly interacts with decision 6's topology gap below.

6. **Encryption model: full multi-device E2E vs. transport-only trust?**
   - Options: nimbalyst-style per-device ECDH identity keys + AAD-bound envelopes (true E2E, relay never sees plaintext even from its own admin); happy's tweetnacl/AES-GCM as-is (closer to a single shared secret); skip true E2E, rely on TLS + Tailscale WireGuard transport encryption only (hapi's actual self-hosted posture).
   - Recommendation: nimbalyst's protocol *shape*, implemented with happy's actual crypto library, adopting nimbalyst's AAD-binding fix from day one. Flagged explicitly: since the user is both relay operator and sole end user, transport-only is a legitimate, cheaper YAGNI option — but it quietly abandons the "genuine E2E" requirement, so it must be a conscious choice, not a default fallen into.

7. **(New, surfaced by the judge pass) Desktop-offline topology gap: what happens when the desktop itself is fully down, not just disconnected?**
   - Options: accept the gap for v1 (mobile sees last-known state only, cannot get live output or steer until desktop is back); give the devbox daemon its own relay credential so mobile can reach it even with the desktop off, changing the trust model (SSH/relay credentials would no longer live solely on desktop).
   - Recommendation: no default given here deliberately — this trade cuts against the "SSH credential never leaves desktop" must-have and needs to be resolved explicitly before the devbox daemon is designed, not discovered after.

---

*Source material: four full tool teardowns (emdash, happy, hapi, nimbalyst) with file-level citations, a thesis synthesis, three candidate architecture write-ups with effort estimates and risk lists, and a judge pass ranking them — all supplied as structured input to this brief. Ask if you want any teardown's full "what to avoid" list or component breakdown re-surfaced in more detail.*
