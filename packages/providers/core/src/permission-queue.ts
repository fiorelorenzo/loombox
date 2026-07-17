import { EventEmitter } from 'node:events';

import {
  cancelAllPermissionRequests,
  createPermissionQueueState,
  enqueuePermissionRequest,
  headPermissionRequest,
  isPermissionRequestActionable,
  listPermissionRequests,
  resolvePermissionRequest,
  type EnqueuePermissionRequestInput,
  type PendingPermissionRequest,
  type PermissionQueueState,
} from './permission-queue-state';
import type { AcpPermissionOutcome } from './types';

export type {
  EnqueuePermissionRequestInput,
  PendingPermissionRequest,
  PermissionResolveResult,
} from './permission-queue-state';

/**
 * The per-session `session/request_permission` FIFO queue state machine
 * (SPEC.md §7.24 "Tool-call permissions", §5.5 "core owns
 * session/request_permission"; issue #178). This is state only: no UI, no
 * wire I/O. A caller (`AcpClient`, or a test) feeds it incoming requests via
 * `enqueue()` and resolves them via `resolve()`/`cancelAll()`; every
 * subscriber sees the same queue, so "resolving a request from any
 * subscriber removes it everywhere" falls straight out of there being one
 * shared state, not a per-subscriber copy.
 *
 * The FIFO/nested-visibility/cancel-all rules themselves live in
 * `permission-queue-state.ts` as plain, `EventEmitter`-free functions — this
 * class is a thin `EventEmitter` wrapper around that pure state so a
 * Node-side caller keeps the familiar event-driven API. A browser client
 * that cannot safely extend `node:events` (it externalizes to an empty stub
 * in a client-side Vite build) consumes the pure functions directly instead
 * (see `apps/web/src/lib/relay-client.ts`'s `permissionQueueFor`).
 */
export class PermissionQueue extends EventEmitter {
  private state: PermissionQueueState = createPermissionQueueState();

  /** Enqueues an incoming request in arrival order. Emits `'enqueued'`. */
  enqueue(input: EnqueuePermissionRequestInput): PendingPermissionRequest {
    const { state, request } = enqueuePermissionRequest(this.state, input);
    this.state = state;
    this.emit('enqueued', request);
    return request;
  }

  /** Every pending request for a session, oldest first (FIFO arrival order). */
  list(sessionId: string): PendingPermissionRequest[] {
    return listPermissionRequests(this.state, sessionId);
  }

  /** The session's current FIFO head, if any. */
  head(sessionId: string): PendingPermissionRequest | undefined {
    return headPermissionRequest(this.state, sessionId);
  }

  /**
   * True only when this request is its session's current FIFO head. This is
   * the nested-visibility rule from SPEC.md §7.24: a nested/subagent
   * request (one whose `toolCall` carries a `parentToolCallId`) is
   * actionable exactly when it — not some ancestor still ahead of it in the
   * same session's queue — is the visible head; a stale/unknown id is never
   * actionable.
   */
  isActionable(requestId: string): boolean {
    return isPermissionRequestActionable(this.state, requestId);
  }

  /**
   * Resolves a request (allow/deny, carrying the chosen option id, or a
   * cancellation) and removes it from its queue. A stale id (already
   * resolved, or never existed) returns `{status: 'stale'}` instead of
   * silently succeeding, per §7.3's "no longer applies" rule. Emits
   * `'resolved'` so every subscriber (any UI surface, the attention inbox)
   * observes the same resolution exactly once.
   */
  resolve(requestId: string, outcome: AcpPermissionOutcome) {
    const { state, result } = resolvePermissionRequest(this.state, requestId, outcome);
    this.state = state;
    if (result.status === 'resolved') this.emit('resolved', result);
    return result;
  }

  /**
   * A session-level Stop: every open request for that session resolves
   * immediately as cancelled, optimistically, without waiting for the
   * agent's own follow-up update — a spinner must never dangle past the
   * moment Stop was pressed (SPEC.md §7.24's "Multi-request ordering").
   */
  cancelAll(sessionId: string) {
    const { state, results } = cancelAllPermissionRequests(this.state, sessionId);
    this.state = state;
    for (const result of results) this.emit('resolved', result);
    return results;
  }
}
