---
'@loombox/providers-codex': patch
'@loombox/providers-core': patch
---

Fix Codex's permission-option verb classification against real button text, and correct SPEC.md's guessed labels (issue #820, spike #182)

`@agentclientprotocol/codex-acp@1.1.10`'s real `CodexApprovalHandler` labels its permission buttons "Allow Once" / "Allow for Session" (or "Allow Host/Root for Session") / "Reject" — never the "Yes" / "Yes, for this session" / "Stop, and explain what to do differently" text SPEC.md §7.24 and `packages/providers/codex/src/permissions.ts` assumed (`docs/research/codex-acp-completeness.md` §4). The rendered permission card was never actually wrong — `PermissionCard.svelte` always renders the agent's own `option.name` verbatim, never a per-provider label table — but `mapCodexPermissionOptions`'s text-matching classifier never fired against real Codex text (it only ever hit its own kind-based fallback), and nothing in the real source supports the "abort, not a deny" distinction SPEC.md drew for Codex's reject option, which is exactly as ordinary as Claude's or the generic tier's.

- `@loombox/providers-codex`'s `CodexPermissionVerb` is renamed from `'yes' | 'yes_for_session' | 'stop_and_explain'` to `'allow_once' | 'allow_for_session' | 'reject'`, matching Claude's own verb-naming convention. `classify()`'s text patterns now match the real label vocabulary (`reject`, `session`, `allow once`) as the primary path, narrowly enough that an execpolicy/network-policy amendment option's "Allow Commands Starting With ..."/"Allow <host> in the Future" text still falls through to the kind-based fallback instead of misclassifying a persistent grant as one-time.
- SPEC.md §7.24 corrected to cite the real labels and the verifying research doc, dropping the unevidenced "abort, not a deny" claim.
- `packages/providers/core/test/fixtures/codex-like-acp-agent.mjs`'s `session/request_permission` fixture now sends the real option shapes, so every conformance suite drives real data instead of the fictional text.

Verified: `pnpm --filter @loombox/providers-codex --filter @loombox/providers-core --filter @loombox/web --filter @loombox/node exec vitest run` (all green, including two new `PermissionCard.test.ts` cases proving the UI names real Codex option shapes correctly and that Claude's own five-verb labels keep working unaffected), `pnpm --filter @loombox/providers-codex --filter @loombox/providers-core --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, and the full `pnpm format:check`.
