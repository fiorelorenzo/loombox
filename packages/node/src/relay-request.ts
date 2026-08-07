import type { WireMessageV1 } from '@loombox/protocol';

/**
 * The minimal surface a one-off "send a message over this node's existing
 * relay connection, wait for the matching reply" client needs — never a
 * new connection (issue #156's original precedent, `attachments.ts`'s
 * `RelayBlobSource`). `RelayConnection` (this package's real production
 * connection) already satisfies this shape; a test substitutes a tiny
 * fake with no WebSocket/network involved at all.
 *
 * Previously declared independently in both `attachments.ts` and
 * `ssh/relay-lease-client.ts` (the latter's own doc comment already called
 * out "mirroring attachments.ts's RelayLike" — an acknowledged duplicate,
 * not an accidental one). Both re-export this one definition now, so the
 * two files' public `RelayLike` types can never quietly diverge; existing
 * `import { type RelayLike } from './attachments'` /
 * `from './ssh/relay-lease-client'` call sites are unaffected.
 */
export interface RelayLike {
  send(message: WireMessageV1): void;
  on(event: 'message', listener: (message: WireMessageV1) => void): void;
  off(event: 'message', listener: (message: WireMessageV1) => void): void;
}

/**
 * Sentinel {@link awaitRelayMessage}'s `match` returns for an inbound
 * message that isn't the reply being waited for — distinct from any real
 * resolve value (including `undefined`), so `T` itself stays free to be
 * `boolean`/`undefined`/anything else without an ambiguous "no match"
 * case (`RelayLeaseClient.release`'s `boolean` result — `false` is a real,
 * legitimate answer, not "keep waiting").
 */
export const NO_MATCH: unique symbol = Symbol('awaitRelayMessage: no match');

/**
 * Sends one request over `relay` (via `send`, called synchronously once
 * the listener is armed) and resolves with whatever `match` returns for
 * the first inbound message it recognizes as the reply, or rejects with
 * `timeoutMessage` after `timeoutMs`. The listener is removed exactly
 * once, whichever of those two fires first — never both, never neither.
 *
 * Issue #652's duplicate sweep: this listen/match/timeout/cleanup dance
 * was hand-rolled identically three times before this — `RelayBlobSource.
 * downloadBlob` (`attachments.ts`) and `RelayLeaseClient.release`/
 * `RelayLeaseClient.request` (`ssh/relay-lease-client.ts`), the latter two
 * already next to each other in one file. One copy means a future fix to
 * the dance itself (mirrors `apps/web`'s `RelayClient.sendTrackedRequest`,
 * the same pattern's much larger client-side instance) lands once.
 */
export function awaitRelayMessage<T>(
  relay: RelayLike,
  match: (message: WireMessageV1) => T | typeof NO_MATCH,
  send: () => void,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (message: WireMessageV1): void => {
      const result = match(message);
      if (result === NO_MATCH) return;
      clearTimeout(timer);
      relay.off('message', onMessage);
      resolve(result);
    };
    relay.on('message', onMessage);
    const timer = setTimeout(() => {
      relay.off('message', onMessage);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    send();
  });
}
