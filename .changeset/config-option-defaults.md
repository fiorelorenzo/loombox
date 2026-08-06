---
'@loombox/web': minor
---

Remember the last-used model/effort/mode per agent, with a project-scoped override that wins (Zed-parity decision D4-3, issue #753)

Every session used to start at the agent's own defaults; the config-option catalogue is agent-declared per session and nothing persisted between sessions. Now:

- `$lib/config-option-defaults.ts` remembers each provider's last-used value per category, account-wide — one un-parameterized `localStorage` key holding every agent's values, the same persistence mechanism `$lib/accent.ts`/`$lib/expand-thoughts.ts` already use for a single account-scoped preference (D4-2).
- `$lib/config-option-overrides.ts` layers a project-scoped override on top, stored the same per-project-path way `$lib/mcp-server-store.ts` already stores its own config (`mcp-server-store.ts:44`). A project override beats the account-wide value when both exist (D4-3's core rule).
- `$lib/config-option-resolution.ts` resolves the two against a session's live catalog: project beats account beats the agent's own default, and a remembered/overridden value the agent no longer offers is dropped silently rather than sent — `RelayClient.setConfigOption` already rejects an unsupported value (issue #718), so this never resurrects that failure mode.
- `+page.svelte` applies a brand-new session's resolved defaults the moment its real catalog arrives (never optimistically — the agent's own ack is still the only source of truth), and remembers a genuine user pick's ack as the account's new last-used value once it lands. Applying a remembered/overridden value never itself counts as a fresh "last used" pick — otherwise a project's own override would immediately bleed back into the account-wide value the moment its ack arrived, the exact cross-project bleed D4-3 exists to prevent.
- `ConfigBar.svelte` shows which layer produced each category's current value — a `Badge` per category (`Project`/`Account`/`Agent default`) plus a `title` summary on the trigger — and a `pin`/`unpin` `IconButton` per category to set or clear that project's override. This is the named cost the D4-3 pick calls out explicitly: "whichever surface ships this has to show which one is currently winning."

Session templates (D4-4, issue #259) stay explicitly out of scope.

`NewSessionDialog`'s `onCreated` callback now also passes the provider id the session was created with, so the caller can resolve which agent's remembered defaults/overrides apply without a race against the session announce.

Verified: `pnpm --filter @loombox/web exec vitest run src/lib/config-option-defaults.test.ts src/lib/config-option-overrides.test.ts src/lib/config-option-resolution.test.ts src/lib/components/ConfigBar.test.ts src/lib/components/NewSessionDialog.test.ts src/routes/page.test.ts` (129 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.
