# loombox redesign v2 — design spec ("Deck", with a selectable Style system)

Status: agreed with Lorenzo (2026-07-25). Supersedes the direction framing in
`docs/design/redesign.md` (Warp Deck), which stays valid as the structural/motion
base; this spec sets the visual direction, the style system, the finish work, and
three UX features on top of it.

## 0. Decisions made (with Lorenzo)

- **Direction = "Deck"** (mission-control / terminal register) is the DEFAULT look.
- **Style is user-selectable** among three full visual languages: **Deck** (default),
  **Loom**, **Studio**. Each ships **Dark + Light**. Users pick their Style in
  Appearance, on top of the existing theme (dark/light/system) and accent presets.
- **Light theme gets real art-direction**, per Style (not a mechanical derivation of dark).
- **Icons: a bespoke hand-drawn set** matched to the Warp & Weft mark's stroke (not a library).
- **All three UX features this round**: directory picker (local + remote), SSH host
  discovery, connection management.
- **Staging: build the token architecture + Deck to 100% first** (default, with all the
  finish fixes and the three UX features), ship it, then add **Loom** and **Studio** as
  fast-follow Styles on the same architecture.
- **Kept, not reopened**: the Warp Deck structure (rail → sessions → canvas → drawer),
  the azure accent + 6 accent presets + custom, the Warp & Weft `BrandMark`, Inter +
  JetBrains Mono, and the `WovenLoader` / thread-draw motion.

Visual references (artifacts): Deck (the chosen default), Loom, Studio mockups, plus
the "finish Warp Deck" proposal. The Deck mockup is the source of truth for the Deck
Style's tokens.

## 1. The Style system (architecture)

Appearance becomes three orthogonal axes: **Style × Theme × Accent**.

- `Style` ∈ { deck, loom, studio } — set on `:root` as `data-style`.
- `Theme` ∈ { dark, light } (resolved from dark/light/system) — `data-theme`.
- `Accent` — the existing azure default + 6 presets + custom, unchanged, layered last.

### Token layers (in `apps/web/src/lib/styles/`)

1. `tokens.css` — the **contract**: the full set of CSS custom properties every
   component reads (colors: `--bg`, surface tiers, hairlines, ink tiers, semantic
   ok/warn/danger; `--accent-*`; **plus new axes that Styles vary**: a density/spacing
   scale, a type scale, radii, a `--texture` background var, and a `--motion-feel`
   grouping). Components NEVER hard-code a value; they read tokens only. This is the
   single most important rule of the redesign.
2. `styles/deck.css`, `styles/loom.css`, `styles/studio.css` — each defines the token
   VALUES for its Style, with a `:root[data-style="X"]` block for dark and a
   `:root[data-style="X"][data-theme="light"]` block for light. Deck ships first; the
   other two files can be stubs that inherit until built.
3. Accent stays as today (`deriveAccentPalette`), applied after Style so any accent
   works in any Style.

**Deck token values (dark)** come from the Deck mockup: `--bg:#0a0c0f`, panels
`#0e1114`/`#101418`, rail `#08090b`, hairlines `rgba(255,255,255,.09/.16)`, ink
`#e6e9ec`/`#8b9299`/`#5a6167`, azure `#3b9df7` + `--azure-glow`, ok `#34d399`
warn `#f5b942` danger `#f26565`, tight radii `3/5/7px`, a faint `--bg-grid` and
`--scanline` texture, mono-forward data. Deck light must be independently art-directed
(crisp cool paper, real surface separation, sharper ink), NOT derived from dark.

**Style-conditional flourishes** that can't be pure tokens (e.g. Loom's woven texture,
Deck's grid/scanline, Studio's generous spacing) are done with a few `[data-style="X"]`
CSS rules against the same markup — never separate component variants.

### Appearance UI

`AppearanceSettings` grows a **Style** section (three labeled preview swatches:
Deck/Loom/Studio) above the existing Theme + Accent sections. Selection persists like
theme/accent do. A Style preview swatch shows a tiny representative chip of that Style.

## 2. The finish (applies to all Styles via tokens + shared components)

These are the concrete defects from the analysis; all are token/shared-component work
so they benefit every Style:

- **Icon system (bespoke, ~16-20 icons):** a `apps/web/src/lib/components/ui/Icon.svelte`
  (or an icon module) drawing a hand-made set at 1.6px stroke, rounded caps, tuned to the
  BrandMark. Replaces every letter/unicode placeholder: rail (Sessions/Inbox/Nodes/
  Command/Settings), sessions collapse chevron, target-health dots, tool-call glyphs,
  file-tree, attach, copy, etc. `IconButton`/`Button` icon slots consume it.
- **One button language:** delete the four hand-rolled button implementations
  (`.new-session-button`, `.add-target-button`, `.empty-sessions-cta`, the two dialogs'
  `.btn*`, `AttentionInbox`'s bare button) and route every call site through the shared
  `Button`/`IconButton` primitive (which already has primary/secondary/ghost/danger).
  Give the primitives a `testid` override prop (redesign follow-up #454) so surfaces can
  adopt them without breaking tests.
- **Drawer that closes + IA cleanup:** add a backdrop-dismiss and an `Escape` handler to
  the drawer; render the drawer and the account menu through ONE shared overlay root with
  a documented z-index scale (fixes the stacking bug where the account menu, nested in the
  header's stacking context, collides with the drawer). Collapse the redundancy: **rail =
  launcher, drawer = the only content surface, account menu = identity only** (Sign out +
  an Appearance shortcut). Inbox/Nodes/Settings are reachable only via rail → drawer.
- **Dock icon regenerated from the mark:** extend `scripts/gen-brand-assets.mjs` (or a
  sibling) to emit a properly padded, azure-squircle `apps/desktop/assets/icon.png` (and
  the tray icons) from the same `BrandMark` path data, so it matches the in-app mark and
  sits at the right size next to other dock icons. Delete the stale `fix/desktop-dock-icon`
  branch.
- **Consistency sweep:** `ErrorNotice` for every error, `EmptyState` (differentiated per
  surface) for every empty, `Card`/`Button` in `AppearanceSettings` swatches and config
  panels, an identity treatment (avatar + "Signed in as") on the account trigger.

## 3. UX features

All three share the same shape: the node-side logic already exists and is tested; the
work is an **additive protocol message pair**, a **relay routing/passthrough**, a
**relay-client method**, and a **UI surface**. None need new node mechanisms.

### 3.1 Directory picker (local + remote)

- Replace `NewSessionDialog`'s bare `projectPath` text input with a
  `DirectoryPicker.svelte`: editable breadcrumb + a recent-paths list + a lazy tree
  browse, one widget for both a local target and a remote (ssh) target.
- New target-scoped protocol pair `target_fs_list_request` / `target_fs_list_response`
  (keyed by `nodeId` + `targetId`, like provisioning already is), a
  `RelayClient.browseDirectory()` method, and node-side handling that lists a directory
  (dirs first) on the target's filesystem (local or over SSH).
- **Crypto boundary (Lorenzo's "full E2E" v1 stance):** the directory listing is sealed
  E2E like session content, NOT sent as plaintext metadata — derive a per-target key from
  the AMK, consistent with the rest of the system. This is an explicit decision, not a default.
- Ship the **recent-paths dropdown** (pure client-side, from session history) as an
  independent quick win regardless.

### 3.2 SSH host discovery (Add target)

- `discoverSshTargets()` / `SshHostCandidate` already exist in
  `packages/node/src/ssh/host-candidates.ts` (parses `~/.ssh/config`, detects the
  ssh-agent). Export them from `@loombox/node`'s index; replace the desktop bridge stub
  `apps/desktop/src/main/ssh-candidates.ts` with a real call; add an additive protocol
  message to expose candidates to the PWA.
- `AddTargetWizard` step 1 becomes a **candidate-card picker** (host, user@addr, key/agent
  status, a reachability dot) with **"Enter manually"** as the fallback, replacing the
  blind host/user/port/alias form.

### 3.3 Connection management

- `TargetStatusView` grows **Reconnect / Update / Remove** (and Edit) actions on each
  target, backed by new additive protocol messages `decommission_target` / `target_update`
  (node-side `decommission.ts` + `target-update-monitor.ts` already exist and are tested).
- **Edit = decommission-then-reprovision with prefilled fields** for now (100% reuse of
  tested machinery; a brief visible target gap during the swap). Revisit a true
  patch-in-place edit only if usage shows it's needed often.

## 4. Staging / waves

1. **Foundation:** the Style-system token architecture (`tokens.css` contract + the
   `data-style`/`data-theme` resolution + `deck.css` dark+light), the icon system, and
   the Button/overlay/drawer consolidation. Everything downstream depends on this.
2. **Deck finish (parallel per surface):** migrate every surface onto the tokens + shared
   primitives + icons so it looks right in Deck dark AND light. The Appearance Style picker.
   The dock-icon pipeline.
3. **UX features (parallel):** directory picker, SSH discovery, connection management —
   each protocol + node + UI. These can run alongside wave 2 (different files).
4. **Loom + Studio Styles:** `loom.css` + `studio.css` (dark+light) + their
   Style-conditional flourishes, validated against every surface. Fast-follow.

Each wave merges to a green `main` before the next, gated by CI, via feature-branch PRs
(the parallel-backlog-execution model already used this session).

## 5. Testing & constraints

- Every changed component keeps its Vitest tests green (behavior preserved; restyle +
  token migration only). New components (DirectoryPicker, Icon) ship tests from commit one.
  New protocol messages ship Zod schemas + tests in `packages/protocol`. New node handlers
  + relay routing ship tests. A Playwright check that the Style picker switches
  `data-style` and that the drawer closes on Esc/backdrop.
- Clean-room, MIT, Conventional Commits, keep `main` green.
- Accessibility: the icon set carries labels; the Style picker + drawer are keyboard
  operable; focus-visible everywhere; `prefers-reduced-motion` respected.

## 6. Out of scope (this round)

Mobile/Capacitor-specific polish beyond responsive behavior; a true patch-in-place target
edit; new accent presets; any change to the crypto/protocol beyond the three features'
additive messages.
