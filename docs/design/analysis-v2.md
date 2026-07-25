## Framing

Lorenzo's read ("much better than before, but still not there") matches what all five audits independently converge on: **the visual direction is right and shouldn't be re-opened; what's missing is finishing a plan that's already written down, plus one real design gap (light theme) and three real UX gaps (dir picker, SSH discovery, connection management) that need new wiring, not just polish.** Nothing here argues for a re-brainstorm of Warp Deck itself.

Locked and not up for debate in this round, per instruction: azure accent, Warp & Weft mark, Inter/JetBrains Mono, WovenLoader.

---

## 1. Defects, by severity

**Blockers** (visible on first look, no taste call required to agree these are broken):
- Rail nav (`S`/`I`/`N`/`⌘`/`⚙`), the sessions-chevron (`«`/`»`), and the target-health dots are still literal placeholder glyphs. The redesign brief (`redesign.md` §5) already specs the real 20×20 icon set to replace them — it was simply never built (wave 2 of a 5-wave sequence never landed).
- Four independent, drifting button systems (`Button.svelte` proper, `.new-session-button`, `.add-target-button`, `.empty-sessions-cta`, plus two dialogs' own `.btn*` copies, plus `AttentionInbox`'s bare `<button>`). This is exactly Lorenzo's "outline / filled navy / light-blue" complaint, and it's structural: any future tweak to `Button.svelte` propagates to none of the copies.
- Drawer + account menu: a genuine stacking-context bug (account-menu-dropdown is nested inside the sticky header's own stacking context, capping its effective z-index below the Drawer's) *combined with* a real missing affordance (Drawer has no backdrop-dismiss and no Escape handler — the only close path is a button that can be visually obscured by the very menu it collides with). This is "a side drawer you cannot close," confirmed as a real bug, not a taste issue.
- macOS Dock icon: three independently confirmable defects on the actual pixel-sampled asset — no safe-zone padding (99.6% edge-to-edge, so it reads oversized next to neighbors), wrong color entirely (amber/gold, not the azure brand accent), and it was never wired into the `gen-brand-assets.mjs` pipeline that correctly generates every *other* brand asset from `BrandMark.svelte`. The one merged "dock icon fix" (PR #424) only changed when the icon shows, never touched the asset itself.

**Major:**
- Light theme is quantifiably flat: `--color-surface` (`#ffffff`) vs `--color-surface-raised` (`#fffdfa`) is a 3-value difference in the blue channel; borders sit at 8%-alpha on near-white; shadows tuned for dark surfaces do almost nothing on a pale background. Dark's three surface tiers are meaningfully stepped; light's were derived by reapplying dark's *relative* opacity deltas to a light ground without re-checking they still read as distinct — this needs independent re-tuning, not just "finish the spec as written."
- Empty states are undifferentiated (identical dimmed BrandMark + one sentence everywhere) and inherit the mismatched-CTA problem from the button defect.
- Drawer/rail/account-menu triple redundancy: Inbox, Nodes, and Settings are each reachable from three unrelated widgets with no visual link between them — usable but confusing, and it's what's letting the stacking bug exist in the first place (the account menu was bolted on as a seventh, independent overlay state instead of folding into the drawer's own state machine).

**Minor:**
- `AppearanceSettings` swatches and other config panels bypass `Card`/`Button` with inline styles.
- Plain `<p class="error">` in places instead of `ErrorNotice`.
- Account-menu trigger shows a raw truncated id in monospace, no avatar/"Signed in as."
- Rail's "Command" item and the header's `⌘K` button label the same action inconsistently.
- `+page.svelte` at 3,790 lines and growing is a contributing root cause across several of the above (nothing reveals the whole picture in one glance, so drift like four parallel button systems goes unnoticed) — worth a follow-up refactor ticket, not urgent on its own.

## 2. UX gaps (Lorenzo's three, plus what the flow audit found underneath)

All three of Lorenzo's flagged gaps share the same shape: **the hard node-side logic already exists and is tested; what's missing is protocol messages to expose it to the relay/client, and a UI surface to drive it.** None require new node-side mechanisms from scratch.

**A. Project-directory picker (local + remote).** Today `projectPath` in `NewSessionDialog` is a bare freehand `<input>` for both target kinds — no autocomplete, no browse, no existence validation. `FileReferencePicker`/`fs_list` looks like it should back this but structurally can't: it's sealed with a *session*-derived key, and there's no session yet at new-session time. Needs a target-scoped protocol pair (`target_fs_list_request/response`, keyed by nodeId+targetId like provisioning already is), a `browseDirectory()` relay-client method, and a new dirs-only `DirectoryPicker.svelte`. Real open question: is a directory *listing* (paths/filenames, not contents) metadata-adjacent like `target_list`, or does it need full E2E sealing like message content — Lorenzo's "full E2E" stance (one of his six locked v1 decisions) should decide this explicitly rather than defaulting either way.

**B. SSH host discovery.** `discoverSshTargets()` (parses `~/.ssh/config`, detects the ssh-agent) already exists and is solid in `packages/node/src/ssh/host-candidates.ts` — it's just not wired anywhere: not exported from `@loombox/node`'s index, the desktop bridge (`ssh-candidates.ts`) is a hardcoded stub returning empty, and there's no RPC exposing it to the PWA at all. `AddTargetWizard` step 1 is consequently a blind host/user/port/alias text form, exactly what SPEC §7.23 promised *not* to ship. This is close to pure wiring: export the function, replace the stub body, add one additive protocol message pair, add a candidate-list UI in the wizard with "enter manually" as fallback.

**C. Connection management (edit/remove/reconnect/update).** `TargetStatusView` is read-only (refresh/close only) despite SPEC explicitly promising a decommission action and a one-tap update. `decommission.ts` and `target-update-monitor.ts` are implemented and tested node-side; there is zero wire exposure (no `target_remove`/`decommission_target`/`target_update` message type anywhere in the protocol), and the view component has no `onRemove`/`onEdit`/`onReconnect` props to hang UI on even once the backend exists. "Edit" specifically has an open design question: a real patch-in-place mechanism, or reframed as decommission-then-reprovision (reuses 100% existing tested machinery, costs a visible target gap during the swap).

Everything else in the flow audit (permission queue, tool-call rows, plan card, onboarding/pairing) reads as solid and out of scope for this round.

## 3. Visual direction verdict

Keep Warp Deck's structural/motion/elevation thesis — cockpit register, monochrome-plus-one-accent, border-driven, closer to Vercel/Linear/Zed than Raycast's glassy register. The bones (rail → sessions → canvas → drawer, the flat/raised/floating elevation ladder, "accent reserved for meaning") are the right shape and already scored well against the alternatives the redesign doc itself evaluated. Two different problems need two different responses:

1. Most of what reads as "unfinished" is literally an unfinished checklist against a plan that already exists on paper (icon system, button/EmptyState call-site migration, dock icon pipeline) — finish it, don't redesign it.
2. Light theme is a genuine design gap, not an unfinished one — it was derived by mechanically reapplying dark's opacity formula to a cream base rather than being independently art-directed, so "just finish the spec" won't fix it; the spec's own light values need redoing (cooler/crisper paper instead of warm cream, real luminance separation for `raised`, sharper ink for text, shadows retuned darker/tighter rather than lower-opacity dark copies).

Typography and density calls (push mono further into technical/data text generally; err denser, closer to Linear's row height, reserving generous space for empty-states/onboarding only) are low-risk refinements worth doing in the same pass, not separate decisions.

## 4. Brand/icon plan

Two of three brand-asset problems already have a documented, unimplemented answer:
- **Dock icon:** regenerate from the same `gen-brand-assets.mjs` pipeline that already correctly produces every other brand asset (favicons, PWA icons) from `BrandMark.svelte`'s locked path data — pad to ~80% tile-in-canvas (matching Apple's keyline convention, since macOS doesn't auto-mask), fill with the real azure accent, drop the stale hand-supplied 1024 PNG. Mechanical: reuse the script's existing `tiledMarkSvg(tile, markFraction)` helper with different parameters, not a new design. Recommend hoisting the shared constants (`MARK_PATHS`/`AZURE`/`TILE_BG`) into `packages/shared` so web and desktop generators share one source instead of drifting again, and folding tray icons into the same generator.
- **Rail icon set:** `redesign.md` §5 already specs a 16-icon, 20×20, 1.5px-stroke hand-drawn set matched to `BrandMark`'s weight — bounded, auditable work, not a new design decision (see Decision 3 below for the one place this is still worth Lorenzo's explicit sign-off, since a library alternative exists and the SPEC brief predates seeing the finished mark in production).

## 5. Feature recommendations (beyond the three named gaps)

- Reference audit's "Go-to-folder" modal pattern (Cyberduck/macOS Finder Cmd+Shift+G) is a good escape hatch to pair with any tree/breadcrumb picker — power users typing a known path shouldn't have to click through levels.
- Recency-first for both dir picker and SSH hosts (VS Code Remote-SSH's quickpick pattern) — surfacing "used before" as a flat list beats hierarchy for repeat access, and it's the cheapest slice to ship first in both flows.
- Decouple "test connection" from "provision" in the SSH wizard (TablePlus/DbVisualizer pattern) so failures are attributable ("SSH auth failed" vs "reached host but bootstrap failed") — currently you only find out something's wrong after committing to Review.
- Path completion (if/when live remote autocomplete is built later) must be sourced live per-keystroke from the node, never a cached snapshot — this is the exact bug class VS Code/Warp/JetBrains all still have open reports for.
