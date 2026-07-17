import { EventEmitter } from 'node:events';

import type { AcpPermissionOption, AcpPermissionOutcome, AcpToolCallUpdate } from './types';

export interface PendingPermissionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly toolCall: AcpToolCallUpdate;
  readonly options: AcpPermissionOption[];
  /** Copied off `toolCall.parentToolCallId`: a UI layer uses this to force open a collapsed ancestor group (SPEC.md §7.24). */
  readonly parentToolCallId: string | undefined;
  readonly enqueuedAt: number;
}

export interface EnqueuePermissionRequestInput {
  requestId: string;
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

export type PermissionResolveResult =
  | { status: 'resolved'; requestId: string; sessionId: string; outcome: AcpPermissionOutcome }
  | { status: 'stale'; requestId: string };

/**
 * The per-session `session/request_permission` FIFO queue state machine
 * (SPEC.md §7.24 "Tool-call permissions", §5.5 "core owns
 * session/request_permission"; issue #178). This is state only: no UI, no
 * wire I/O. A caller (`AcpClient`, or a test) feeds it incoming requests via
 * `enqueue()` and resolves them via `resolve()`/`cancelAll()`; every
 * subscriber sees the same queue, so "resolving a request from any
 * subscriber removes it everywhere" falls straight out of there being one
 * shared `Map`, not a per-subscriber copy.
 */
export class PermissionQueue extends EventEmitter {
  private readonly queues = new Map<string, PendingPermissionRequest[]>();
  private readonly byId = new Map<string, PendingPermissionRequest>();

  /** Enqueues an incoming request in arrival order. Emits `'enqueued'`. */
  enqueue(input: EnqueuePermissionRequestInput): PendingPermissionRequest {
    if (this.byId.has(input.requestId)) {
      throw new Error(`PermissionQueue: duplicate request id "${input.requestId}"`);
    }
    const request: PendingPermissionRequest = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      toolCall: input.toolCall,
      options: input.options,
      parentToolCallId: input.toolCall.parentToolCallId,
      enqueuedAt: Date.now(),
    };
    const list = this.queues.get(input.sessionId) ?? [];
    list.push(request);
    this.queues.set(input.sessionId, list);
    this.byId.set(request.requestId, request);
    this.emit('enqueued', request);
    return request;
  }

  /** Every pending request for a session, oldest first (FIFO arrival order). */
  list(sessionId: string): PendingPermissionRequest[] {
    return [...(this.queues.get(sessionId) ?? [])];
  }

  /** The session's current FIFO head, if any. */
  head(sessionId: string): PendingPermissionRequest | undefined {
    return this.queues.get(sessionId)?.[0];
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
    const request = this.byId.get(requestId);
    if (!request) return false;
    return this.head(request.sessionId)?.requestId === requestId;
  }

  /**
   * Resolves a request (allow/deny, carrying the chosen option id, or a
   * cancellation) and removes it from its queue. A stale id (already
   * resolved, or never existed) returns `{status: 'stale'}` instead of
   * silently succeeding, per §7.3's "no longer applies" rule. Emits
   * `'resolved'` so every subscriber (any UI surface, the attention inbox)
   * observes the same resolution exactly once.
   */
  resolve(requestId: string, outcome: AcpPermissionOutcome): PermissionResolveResult {
    const request = this.byId.get(requestId);
    if (!request) {
      return { status: 'stale', requestId };
    }
    this.remove(request);
    const result: PermissionResolveResult = {
      status: 'resolved',
      requestId,
      sessionId: request.sessionId,
      outcome,
    };
    this.emit('resolved', result);
    return result;
  }

  /**
   * A session-level Stop: every open request for that session resolves
   * immediately as cancelled, optimistically, without waiting for the
   * agent's own follow-up update — a spinner must never dangle past the
   * moment Stop was pressed (SPEC.md §7.24's "Multi-request ordering").
   */
  cancelAll(sessionId: string): PermissionResolveResult[] {
    return this.list(sessionId).map((request) =>
      this.resolve(request.requestId, { outcome: 'cancelled' }),
    );
  }

  private remove(request: PendingPermissionRequest): void {
    this.byId.delete(request.requestId);
    const list = this.queues.get(request.sessionId);
    if (!list) return;
    const next = list.filter((item) => item.requestId !== request.requestId);
    if (next.length > 0) {
      this.queues.set(request.sessionId, next);
    } else {
      this.queues.delete(request.sessionId);
    }
  }
}
