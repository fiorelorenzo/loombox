---
'@loombox/web': patch
---

Remove the paced text reveal entirely, so streamed text renders as it arrives (Zed-parity decision E2, issue #757).

`$lib/text-pacer.ts` and its test are deleted, along with every call site: `MessageItem.svelte` no longer tracks a `revealedLength`/`TextPacer` pair, it now derives `rendered` straight off `item.text`. The turn-end flush path that pushed the remaining backlog when `turn_ended` arrived (`pacer.flush()` on `!turnActive`) goes with it — there is no backlog left to flush once nothing paces the reveal in the first place. `turnActive` stays as a prop: it still gates `splitStreamingMarkdown`'s `finalized` flag, which is what actually settles a still-open Markdown construct (an unterminated fence, a building list) once the turn ends, independent of reveal timing.

This was blocked until two prerequisites landed, and both have: #755 windows the transcript so an unbounded list stays cheap, and #756 moved envelope decryption off the main thread. Both are what make removing the pacer safe rather than a regression — the pacer existed to stop a burst thrashing the DOM on the same thread that was decrypting it against an unwindowed list; neither condition holds anymore.

Verified: `pnpm --filter @loombox/web exec vitest run src/lib/components/MessageItem.test.ts src/lib/markdown.test.ts` (58 tests), `pnpm --filter @loombox/web typecheck`, `pnpm exec eslint` on every changed file, `pnpm format:check`, and `pnpm --filter @loombox/web exec playwright test tests-e2e/transcript-follow.spec.ts tests-e2e/live-transcript.spec.ts` (3 tests). See the PR body for the burst-timing measurement and which acceptance criterion is satisfied by the module's absence versus by a test.
