---
'@loombox/web': minor
---

The thinking-display preference goes from a boolean to three states, automatic as the default (Zed-parity decision C4-2, issue #745; closes #661).

`$lib/expand-thoughts.ts`'s store now holds a `ThoughtDisplayMode` (`'collapsed' | 'expanded' | 'automatic'`) instead of a boolean, persisted to `localStorage` the same way `$lib/accent.ts`/`$lib/theme.ts` persist their own — a plain string, no JSON. A pre-#745 stored boolean is migrated rather than discarded: `'true'` becomes `'expanded'`, and `'false'` becomes `'automatic'`, not the new `'collapsed'` — `false` used to mean "collapsed once settled, forced visible while producing" (issue #660's fix), which is exactly what `'automatic'` means now, so an existing user's thoughts keep streaming visibly exactly as before rather than silently going dark. `'collapsed'` is new: a stronger, previously-unavailable "never, period" choice that suppresses a thought's body even while it's actively producing text (the header's timer and woven-thread motif still show activity).

`MessageItem.svelte` computes each mode's own baseline (`'expanded'`/`'collapsed'` are constants, `'automatic'` is exactly the existing `thinking` prop) and layers a per-thought manual override on top: clicking the disclosure always sets it, and it then wins over the mode's baseline for as long as that thought's component instance stays mounted. This is what keeps automatic mode from reintroducing issue #661 — a thought expanded by hand stays expanded for that thought straight through its own settle transition — without turning the display mode itself back into per-component state (v8's B2-1, issue #709, stays settled): the mode is still one global preference, read once and applied to every thought in every session, and the override sets no default for any other, future thought.

The Appearance settings panel (`AppearanceSettings.svelte`) gets a third "Thinking" section, a radiogroup styled identically to the existing Theme control, with Automatic listed first to match its status as the default.

Verified: `pnpm --filter @loombox/web exec vitest run src/lib/expand-thoughts.test.ts src/lib/components/MessageItem.test.ts src/lib/components/AppearanceSettings.test.ts src/lib/components/pages/SettingsPage.test.ts` (67 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.
