import type { Snippet } from 'svelte';

/**
 * The one state shape every panel that loads something over the relay
 * reduces its own flags into before handing off to `ui/AsyncPanel.svelte`
 * (issue #650). A tagged union, not independent booleans: "error and
 * empty at the same time" (the Runner's own #244 bug — a failed load
 * fell through to the empty-catalog message, stacking both) is
 * unrepresentable by construction here, not merely avoided by careful
 * `{:else if}` ordering the way every hand-rolled copy tried to.
 *
 * Deliberately has no fifth "idle" member: a caller that has nothing to
 * report yet (the one render tick before its own `$effect` kicks off the
 * request) simply doesn't mount `AsyncPanel` at all, rather than this
 * union growing a state whose only job is "render nothing" — see e.g.
 * `PrOpenDialog`'s `preview`/`loading` still both being falsy on that
 * first tick.
 */
export type AsyncPanelState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly retryable?: boolean }
  | { readonly status: 'empty'; readonly message: string; readonly cta?: Snippet }
  | { readonly status: 'loaded'; readonly data: T };

/**
 * The established "the node went quiet" sentence (issue #582's Files
 * panel wording, reused verbatim by `DirectoryPicker` per #505 — two
 * independent precedents, not one) — the one phrasing a bounded-wait
 * timeout should read as everywhere in the app. `subject` names the
 * thing that didn't answer ("This folder", "The runner config", "The
 * pin list") so a caller never has to restate the explanation, only say
 * what went quiet (issue #650's "a caller can name the thing that did
 * not answer, not rewrite the explanation").
 */
export function timeoutMessage(subject: string): string {
  return `${subject} didn't answer in time. The node may be asleep, offline, or on an older relay.`;
}

/**
 * Turns a caught `RelayClient` request rejection into copy fit for a
 * person: a bounded-wait timeout (`RelayClient: timed out waiting for
 * X_response (X_request)`, the shape every relay call rejects with once
 * its own timeout fires) gets {@link timeoutMessage}'s sentence instead
 * of that wire-phrased identifier; anything else (a real thrown error)
 * is shown as-is. Never call this on a structured `{outcome:'error'}`
 * reply's own `message` — that's already node-composed prose for a
 * human, not a caught exception (see `DirectoryPicker`'s own
 * `loadErrorRetryable` doc comment on that distinction).
 */
export function loadErrorMessage(subject: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.includes('timed out waiting') ? timeoutMessage(subject) : raw;
}

/**
 * The sibling of {@link timeoutMessage} for a *mutating* action's own
 * timeout (issue #652's duplicate sweep — found hand-rolled identically,
 * modulo the trailing verb, in `ArchiveSessionDialog`, `CheckpointRestoreDialog`,
 * `CommitDialog`, `DiscardHunkDialog` and `GitBranchPanel`). Deliberately a
 * different sentence from {@link timeoutMessage}, not a shared one:
 * `loadErrorMessage` names a THING that stayed silent ("This folder didn't
 * answer"), which is honest for a read. A write's own timeout cannot make
 * that same claim — the request may have landed on the node and only the
 * reply got lost — so it says plainly that the outcome is unknown rather
 * than implying nothing happened. `action` names what the caller cannot
 * confirm happened ("archived", "restored", ...); omitted (`GitBranchPanel`,
 * whose one handler covers several different mutations), the sentence
 * stays generic.
 */
export function writeTimeoutMessage(action?: string): string {
  const base = 'Nothing answered in time. The node may be asleep, offline, or on an older relay.';
  return action ? `${base} Nothing was ${action}.` : base;
}

/** The write-side counterpart of {@link loadErrorMessage} — see {@link writeTimeoutMessage}'s doc comment for why the two sentences differ. */
export function writeErrorMessage(action: string | undefined, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.includes('timed out waiting') ? writeTimeoutMessage(action) : raw;
}
