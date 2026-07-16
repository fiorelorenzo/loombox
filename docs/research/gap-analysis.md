# loombox spec — final gap report

**Verdict:** The spec (`ideas/loombox/spec.md`) is unusually candid and mostly complete for a brainstorm-stage document — it already names its own top risks in §14 rather than hiding them. It is not yet buildable as-is, though: three decisions are genuinely unresolved and would cause an autonomous build to diverge or stall (device pairing/revocation has zero design despite being a v1 acceptance item; the client framework is a literal unresolved fork; there's no test/CI convention for loombox's own code). Everything below P0 is real but is backlog-grade hardening, not a blocker to starting the build.

No false positives survived cross-checking; every finding below cites real spec text.

---

## P0 — blocks autonomous build, fix before handing off

1. **Device pairing, revocation, rotation, and lost-device/lost-relay recovery for the E2E mesh.** §8 requires per-device wrapped session keys and §12 lists "per-device E2E envelopes" as a v1 acceptance item, but no pairing flow, device registry, revocation/re-wrap behavior, or recovery path exists anywhere (§14 names this the top risk but doesn't resolve it). **Fix:** add a "Device lifecycle" subsection to §8: pairing (QR/short-code confirmed by an already-trusted device), a device registry (id/pubkey/status), a revoke action that rotates live session keys and states whether old ciphertext stays readable by the revoked key, and a re-pairing path for a lost device or rebuilt relay.

2. **Client framework left as an open "React or Svelte" fork.** §10 states "Client: a PWA (React or Svelte)" while §10.1's landing site already commits to SvelteKit — the actual product client every UI epic depends on is undecided. **Fix:** pin `apps/web` to one framework in §10 (e.g. SvelteKit, matching the landing repo), with the same specificity already given to the landing stack.

3. **No testing strategy or CI/CD defined for loombox's own repos.** §7.15 specs a test-runner as a *product feature for users' projects*, but §10/§10.1/§15 name no test framework, coverage bar, or CI workflow for loombox's own packages — undercutting the spec's stated goal of autonomous incremental building. **Fix:** add a subsection pinning a unit/integration runner (e.g. Vitest) + e2e tool (e.g. Playwright) for the PWA, a "new packages ship tests from commit one" rule, and a GitHub Actions workflow gating merge on lint/typecheck/test.

## P1 — real gaps, should be resolved during early milestones

4. **Searchable transcript archive contradicts the ciphertext-only relay.** §8 says the relay "only ever handles ciphertext," but §7.19 wants "a searchable archive of every session's transcript" with no reconciling mechanism. **Fix:** state in §7.19/§8 that search is client-side only, over content each device has already decrypted; cross-device completeness is bounded by what's synced. (Softer than the crypto-design gap above — this has an obvious answer, just needs stating.)

5. **No spend/cost guardrail.** §7.9 is visibility-only ("a live meter"); §7.16's concurrency governance covers CPU/RAM/disk but never dollars, despite the core pitch being unattended parallel agents burning real API cost overnight (§7.22). **Fix:** add a per-project/per-session spend cap to §7.16 that auto-pauses and surfaces in the attention inbox (§7.13).

6. **No collision protection for two sessions in the same non-worktree folder.** §6 deliberately allows running directly in a working directory (no worktree required), but §7.2's "each isolated (separate worktree or separate folder)" claim breaks if two concurrent sessions target the same plain folder — nothing locks, warns, or queues. **Fix:** add a same-folder mutual-exclusion rule to §7.1/§7.2: reject or queue a second in-place session on a folder already in use, or at minimum warn.

7. **Relay data layer has no retention policy or backup/DR plan.** §10 names only "Postgres for encrypted blobs + metadata" with no retention or disaster-recovery story anywhere, including §14's own risk list, even though the relay is the sole copy of session history and device registrations on one VPS. **Fix:** add to §9/§14: a retention policy (TTL/size cap, prunable via CLI) and a backup/RPO line (e.g. nightly dump to off-box storage, tested restore). (Skip naming a migration tool — that's covered by §10's own "to be confirmed" framing.)

8. **No protocol version negotiation across independently-updated components.** §10 says the wire protocol is "versioned" but never defines a handshake or minimum-supported-version behavior for a lagging node/PWA against an updated relay. **Fix:** add to §10/§8: every message carries a version; relay/node/client declare a supported range at connect; relay prompts "update required" instead of failing silently; rollout order relay → nodes → clients.

9. **No default sandboxing posture named.** §7.17 says "optional sandboxing," already flagged as an open question in §14 and deferred to v2 in §12 — but no target mechanism is named. **Fix:** in §7.17, name a mechanism to design toward (e.g. namespace/bind-mount scoping to the worktree, containers where available) and state that "optional" should not mean "off by default" once v2 ships; note the macOS fallback.

10. **No verification mechanism for the auto-provisioned supervisor binary.** §14 requires the bootstrap to "verify the supervisor binary," but §7.23 never says how (no signing scheme or pinned key named). **Fix:** add to §7.23: node ships a pinned public key, releases are signed (e.g. minisign/sigstore) and verified before execution, distributed via GitHub Releases with published checksums.

11. **No at-rest storage mechanism for secrets/SSH keys/provider tokens on the node.** §8/§7.17 cover transit ("never sent to the relay") but not at-rest protection on the node/supervisor host. **Fix:** state in §8: OS-native secret storage where available (Keychain / libsecret/keyring), explicit fallback for a headless box with no keyring session, otherwise permission-scoped encryption tied to the node's own keypair.

12. **No prompt-injection/egress defense for untrusted tracker/MCP content.** §7.10 has agents read/write GitHub/Jira content and §7.7 adds arbitrary MCP servers, with no statement that this content is untrusted input. **Fix:** add a line to §7.17/§8: tracker/MCP content is untrusted input, not operator instruction; any tool call it triggers still passes through the existing approve/deny gate (§7.3).

13. **No multi-node session ownership model.** §9 allows multiple nodes (Mac + devbox); §7.22 says supervisors survive disconnects, but nothing governs which node owns a given supervisor or how an orphaned session gets reassigned. **Fix:** add a lease-based ownership model to §7.22/§9: a renewable ownership token per session; a second node may only attach read-only while the lease is live; on expiry another node may reclaim it, surfaced as an explicit action in the PWA.

14. **No backpressure model for the relay fan-out.** Nothing addresses a slow client (phone on cellular) stalling delivery, or memory pressure from a burst of output (large diff, verbose build log). **Fix:** add to §5.6/§7.16: bounded per-client output queues, drop-oldest-plus-resync-marker on overflow, and a guarantee that a slow client never blocks delivery to faster clients or the supervisor's own persistence.

15. **No conflict rule for offline-queued approve/deny actions.** §10 calls the PWA "offline-tolerant" and §7.3 allows switching devices mid-session, but nothing defines what happens when a queued approval targets a tool-call request that's expired or already resolved elsewhere. **Fix:** add to §7.3: define which actions queue offline (a follow-up prompt: yes) versus which don't (a specific approve/deny: no — discard stale ones with "this approval no longer applies" rather than silently applying/dropping).

16. **No interrupt/stop control for a running agent turn.** All rollback is post-hoc (§7.20's checkpoint/rollback); nothing lets the user stop a turn mid-flight, despite "steer from my phone" (§1) implying exactly that. **Fix:** add a distinct stop/interrupt action (one tap from desktop and mobile) to §7.3, separate from §7.20's checkpoint/rollback.

17. **ACP library unnamed and Codex's ACP support unconfirmed, no fallback stated.** §5.5/§10 commit v1 to "Claude Code + Codex via ACP" without naming a concrete SDK or confirming Codex actually speaks ACP today. **Fix:** name the ACP library to build on in §10, and add a contingency to §12: if Codex's ACP support is incomplete at build time, v1 ships Claude Code only, Codex added once support lands.

18. **No update-trigger for already-provisioned remote targets.** §7.23 says the bootstrap "re-runs on version change" but not what triggers that. **Fix:** add to §7.23: the PWA surfaces when a remote target is outdated (via the version handshake in #8 above) and offers a one-click "update this target" action.

19. **No onboarding/first-run flow for the common non-SSH case.** §7.23 fully specs adding an `ssh:` target, but nothing describes first install → stand up/point at a relay → register first node → first local session. **Fix:** add a first-run flow near §7.23/§9 covering point-at-existing-relay vs. one-command self-host, node auto-registration, and first local-target session.

## P2 — polish/hardening, fine to file as backlog issues post-spec

- **Diff review & checkpoint/rollback for non-git projects.** §6 makes "any folder, no git required" a differentiator, but §7.4/§7.20 read as git-shaped with no non-git diff/snapshot mechanism named. Add a content-hash or filesystem-snapshot fallback to §7.20.
- **Provider ToS/rate-limit exposure from many concurrent automated CLI sessions.** Nothing addresses whether Claude Code/Codex subscriptions permit this usage pattern or what happens when shared-credential rate limits are hit. Add a line to §14's risk list.
- **Relay observability.** §7.21 covers nodes/targets only, not relay uptime/queue depth, and alerting can't depend solely on the relay. Add a `/health` endpoint + external uptime check note to §7.21.
- **MCP server trust boundary.** §7.7 doesn't state whether a project's secrets are visible to every added MCP server by default. Add an explicit per-server grant requirement to §7.7/§7.17.
- **Provider credential storage/concurrent multi-target sharing.** No statement on whether the same Claude Code/Codex credential is shared or per-target, or behavior under concurrent use. Add a line to §8.
- **Project organization at scale.** §7.2 has a board/list view but no pin/tag/archive/filter. Add to §7.2.
- **Global quick-switcher** distinct from §7.19's content search. Add a fuzzy jump-to-session/project action.
- **Keyboard-driven UX / command palette.** No shortcuts or palette mentioned anywhere in §7. Add as a cross-cutting requirement.
- **Mobile approval UX detail.** §7.3 states the capability but not how a large diff/command renders on phone or whether push notifications carry actionable buttons. Add a mobile approval-card spec to §7.3.
- **Notification granularity.** §7.11 has presence-aware routing but no per-project mute or quiet hours. Add toggles to §7.11.
- **Accessibility posture.** Nothing stated for keyboard/screen-reader/contrast. Add one line to §11 declaring the deliberate v1 scope (or lack thereof).
- **Decommission/uninstall flow for a remote target.** §7.23 only covers adding a target. Add a "remove target" action (stop/disable units, revoke device key, offer cleanup).
- **v0-to-v1 data migration/disposability.** §12's v0 entry implies throwaway data but never says so explicitly. Add one sentence to §12.
- **Rate limiting / abuse protection on the public relay.** No per-IP connection/enrollment limits or storage-exhaustion cap. Add to §8/§9.
- **Telemetry/analytics/privacy stance.** Pitch rests on "relay can't read your data" but no statement on telemetry anywhere. Add a no-telemetry-by-default line to §8/§11.
- **Versioning/changelog process for the monorepo.** §10.1 lists 9 packages under the reserved `loombox` npm scope with no version/changelog/publish process stated. Add a line (e.g. Changesets + GitHub Releases).
- **Per-epic Definition-of-Done in §15.** Optional strengthening only — per this repo's own AGENTS.md, granular DoD/dependency breakdown is a later graduation-step concern, not a spec.md defect.

---

## Already solid (no action needed)

- **Threat model & trust boundaries (§8):** clear on what the relay can/cannot see, SSH-credential handling, and transit-level secret scoping.
- **Feature breadth (§7.1–7.23):** the 23-feature list is comprehensive for the product surface (sessions, terminals, git, MCP, ports, usage, trackers, notifications, inbox, CI, tests, concurrency, guardrails, templates, history, checkpoints, health, persistence, SSH setup) with no major functional area missing.
- **Deliberate deferrals are correctly scoped, not silent gaps:** sandboxing/prompt-injection are explicitly v2 (§12), the tech-stack preamble ("Proposed, to be confirmed in the repo") legitimately covers unnamed libraries (SSH lib, ORM, migration tool), and stopping short of per-epic DoD matches this repo's own spec-vs-planning split.
- **Self-awareness:** §14's own open-questions section already names its two hardest problems (E2E key distribution, sandboxing) honestly rather than glossing over them — rare and valuable for a spec at this stage.
