# Design decisions

One row per design answer that actually landed. The canvas (now Claude Design,
before that the hand-built HTML decks under `docs/design/`) draws the options;
this file is the answer. An agent implementing with omp should never need to
open a design tool to know what was decided — read this table and the export's
`github.md` screen map instead.

`Rule it creates` is usually empty. It is filled only when the decision produced
something a component can violate — a row with a rule is binding on an
implementer, a row without one is context.

| ID | Round | Question | Answer | Rule it creates |
|---|---|---|---|---|
| D1 | redesign.md (Warp Deck synthesis) | Which of the three scored directions (Cockpit, Calm, Tactile) becomes the shipped design language? | Warp Deck: Cockpit's rail→sessions→canvas→drawer structure, disciplined by Calm's restraint (accent reserved for meaning, quiet left-edge status stripes), animated by Tactile's `stroke-dashoffset` technique formalized as "thread-draw". | A tinted-background status signal on a list row (instead of a left-edge stripe) is a violation, except `PermissionCard`, which is the one deliberate exception. |
| D2 | redesign.md §0 | Which existing brand primitives does Warp Deck keep vs. rewrite? | Locked, additive-only: `#3b9df7` azure accent, the 6-preset theme system + `deriveAccentPalette`'s hover/active/subtle/contrast formula, the Warp & Weft `BrandMark`/`BrandLockup`, Inter (`--font-ui`) + JetBrains Mono (`--font-mono`), `WovenLoader`'s two variants/two sizes/reduced-motion contract. | Rewriting any of the above (new accent hue, new mark, new type pairing, a rebuilt `WovenLoader`) instead of extending it is a violation. |
| D3 | redesign.md §3 | What does each elevation tier mean and who uses it? | Three tiers only: `flat` (generic rows, hairline-divided), `raised` (selected rows, tool-call rows, cards), `floating` (`PermissionCard`, Dialog, Drawer overlay, Command Palette). | A component hand-rolling its own `border` + `shadow` combination instead of one of the three tiers (once `Card.svelte`'s `elevation` prop exists) is a violation. |
| D4 | redesign.md §2 | What is the motion vocabulary and does each transition have more than one job? | Five named transitions (`beat-in`, `shuttle-in`/`shuttle-out`, `thread-lift`, `tension-press`, `status-crossfade`, `thread-draw`), each with exactly one documented use; all durations collapse to 0ms under `prefers-reduced-motion: reduce`. | Inventing a bespoke one-off transition instead of reusing a named one (once the token layer ships) is a violation. |
| D5 | ux-review-2026-08-05, decision B1-2 (issue #667), confirmed already shipped in v7 | Does the user's own transcript turn get more than one visual signal? | No: a raised fill is the only signal. The gutter accent bar that used to also mark the user's turn is gone. Exactly one signal per role. | Reintroducing a second signal (e.g. a gutter accent bar) on a user turn is a violation. |
| D6 | analysis-v2.md §3 | Does the "still not there" verdict on v0.2.0 mean re-opening Warp Deck's structure? | No. The bones (rail→sessions→canvas→drawer, the elevation ladder, "accent reserved for meaning") are correct and not up for debate this round; what's unfinished is a checklist against `redesign.md` (icon system, `Button`/`EmptyState` call-site migration, dock icon pipeline), not a new design pass. | |
| D7 | analysis-v2.md §4 | How does the macOS dock icon get fixed? | Regenerate it from the same `gen-brand-assets.mjs` pipeline that already produces every other brand asset from `BrandMark.svelte`, padded to ~80% tile-in-canvas (Apple's keyline convention), filled with the real azure accent; drop the stale hand-supplied 1024px PNG. Mechanical, not a new design. | A hand-supplied dock icon asset that bypasses `gen-brand-assets.mjs` is a violation. |
| D8 | analysis-v2.md §3 | Is the light theme just "finish the spec as written"? | No — explicitly not locked. Light was derived by mechanically reapplying dark's relative opacity deltas to a light ground and reads flat (`--color-surface` vs `--color-surface-raised` is a 3-value blue-channel difference). It needs independent re-tuning: cooler/crisper paper instead of warm cream, real luminance separation for `raised`, sharper ink for text, shadows retuned darker/tighter rather than lower-opacity dark copies. No final light-theme values exist yet — see Unresolved. | |

## Unresolved — no answer to record yet

These were raised in a review but never reached a picked option. Do not infer
an answer from "Today" markers in the frozen HTML decks: those mark what the
code does now, not what was chosen.

- **Rail icon set — library vs. bespoke.** `redesign.md` §5 specs a 16-icon,
  20×20, 1.5px-stroke hand-drawn set. `analysis-v2.md` §4 calls this "bounded,
  auditable work" but flags it as still needing Lorenzo's explicit sign-off
  ("Decision 3") because a library alternative exists and the original SPEC
  brief predates seeing the finished mark in production. That sign-off was
  never given in either file.
- **Project-directory picker mechanism (UX gap A, analysis-v2.md §2).** Needs a
  target-scoped `target_fs_list_request/response` protocol pair. Open question
  stated verbatim in the source: is a directory *listing* (paths/filenames, no
  contents) metadata-adjacent like `target_list`, or does it need full E2E
  sealing like message content? Never answered.
- **SSH host discovery wiring (UX gap B, analysis-v2.md §2).** Described as
  "close to pure wiring" (export the existing function, replace the stub,
  add one protocol message pair, add a candidate list to the wizard) but no
  UI layout or copy was picked.
- **Connection management: edit vs. decommission-and-reprovision (UX gap C,
  analysis-v2.md §2).** Explicitly called "an open design question" in the
  source: a real patch-in-place edit mechanism, or reframed as
  decommission-then-reprovision (reuses existing tested machinery, costs a
  visible target gap during the swap). Never answered.
- **Node-lifecycle decisions A1–E1 (`node-lifecycle-2026-08-06/`, epic #653).**
  The deck's own text says "five decisions there are yours. A1 is the one
  that blocks the other four." None were picked in the artifact; F1 in the
  same deck ("what I found and did tonight, no decision needed") is context,
  not a decision, and is not recorded above.
- **Every `A`/`B`/`C`/... option set in `ux-review-2026-08-04/`,
  `ux-review-2026-08-05/`, `zed-parity-2026-08-05/`, `turn-delimitation-2026-08-04/`,
  `ground-inversion-2026-08-06/`, `terminal-dock-2026-08-04/`, and
  `audit-2026-08-03/`.** These are option decks (each item marked `opt
  is-current` shows only what the code does today, "Today"/"Observed", not a
  choice), built to be picked from and never resolved in writing anywhere in
  the repo. Section F ("defects") of `ux-review-2026-08-05/` is the one
  exception: those items state plainly they need no decision because they are
  bugs, and the fix is the fix — they belong in the issue tracker, not this
  table.
- **Typography/density refinements (analysis-v2.md §3, closing paragraph).**
  Called "low-risk refinements worth doing in the same pass," not a decision
  with a picked value (push mono further into technical/data text, err denser
  row height) — direction only, no concrete numbers chosen.
