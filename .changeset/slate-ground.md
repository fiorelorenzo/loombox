---
'@loombox/web': patch
---

Zed-parity A1-2 (issue #733): the dark theme's neutral ramp inverts — chrome (`--color-rail`) is now the lightest surface, the content well (`--color-bg`, i.e. `.canvas`) the darkest, each of the four values roughly 7 L* apart with a real blue-grey hue (~258°) instead of the old near-zero-chroma near-black. `--color-surface`/`--color-surface-raised` keep their existing "higher tier reads lighter" ordering between those two ends.

- Dark's alpha hairlines (`--color-border-*`/`--color-fill-*`) are re-tuned (9/16/28% → 13/23/40%, fill 6/12% → 8/17%) so the three-tier ladder holds the same lightness separation on the new, lighter ground (A3-1: same hairline/shadow model, only the numbers moved — no shadow gained or lost anywhere).
- `--color-text-secondary`/`--color-text-muted` are re-lightened so they still clear AA/large-text contrast against `--color-rail`, the lightest and hardest of the four grounds.
- `--color-danger`/`--color-info` and all six `accent-presets.ts` dark values are re-lightened in-hue so they still clear `AA_CONTRAST_MIN` (4.5:1) as text against `--color-surface-raised`. `--color-success`/`--color-warning` already cleared it unchanged.
- Light theme is untouched — it isn't being inverted, and its own hue (~267-272°) already sits close enough to dark's new ~258° that the two read as one family.
- `InteractiveTerminal.svelte`'s jsdom/no-stylesheet CSS-token fallbacks are updated to match.
