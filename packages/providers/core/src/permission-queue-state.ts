import type { AcpPermissionOption, AcpPermissionOutcome, AcpToolCallUpdate } from './types';

/**
 * The pure, dependency-free heart of the `session/request_permission` FIFO
 * queue (SPEC.md §7.24, issue #178) extracted out of `PermissionQueue`
 * (`permission-queue.ts`) so a consumer that cannot use a Node
 * `EventEmitter`-based class — a browser bundle, notably: `node:events`
 * externalizes to an empty stub in a client-side Vite build, so `class X
 * extends EventEmitter {}` throws at module-evaluation time in that
 * environment (confirmed empirically while building this PR) — can still
 * share the exact same FIFO/nested-visibility/cancel-all rules instead of
 * re-implementing them in the UI layer (Wave D.2's brief). `PermissionQueue`
 * itself is refactored to hold one `PermissionQueueState` and delegate to
 * these functions, so its existing behavior (and test suite) is unchanged.
 *
 * Every function here is pure: it takes a `PermissionQueueState` and returns
 * a new one, never mutating its input, mirroring `reduceTranscript`'s style
 * (`transcript.ts`) so both "reducers" in this package compose the same way.
 */

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
  /** Overrides `Date.now()` — a caller (e.g. a test) wanting a deterministic `enqueuedAt`. */
  enqueuedAt?: number;
}

export type PermissionResolveResult =
  | { status: 'resolved'; requestId: string; sessionId: string; outcome: AcpPermissionOutcome }
  | { status: 'stale'; requestId: string };

/** Immutable queue state: every session's FIFO list, plus an id index for O(1) lookups. */
export interface PermissionQueueState {
  readonly bySession: ReadonlyMap<string, readonly PendingPermissionRequest[]>;
  readonly byId: ReadonlyMap<string, PendingPermissionRequest>;
}

/** The empty starting state, mirroring `createTranscriptState()`. */
export function createPermissionQueueState(): PermissionQueueState {
  return { bySession: new Map(), byId: new Map() };
}

/** Enqueues a request in arrival order. Throws on a duplicate `requestId`, matching `PermissionQueue.enqueue`. */
export function enqueuePermissionRequest(
  state: PermissionQueueState,
  input: EnqueuePermissionRequestInput,
): { state: PermissionQueueState; request: PendingPermissionRequest } {
  if (state.byId.has(input.requestId)) {
    throw new Error(`PermissionQueue: duplicate request id "${input.requestId}"`);
  }
  const request: PendingPermissionRequest = {
    requestId: input.requestId,
    sessionId: input.sessionId,
    toolCall: input.toolCall,
    options: input.options,
    parentToolCallId: input.toolCall.parentToolCallId,
    enqueuedAt: input.enqueuedAt ?? Date.now(),
  };

  const bySession = new Map(state.bySession);
  bySession.set(input.sessionId, [...(state.bySession.get(input.sessionId) ?? []), request]);
  const byId = new Map(state.byId);
  byId.set(request.requestId, request);

  return { state: { bySession, byId }, request };
}

/** Every pending request for a session, oldest first (FIFO arrival order). */
export function listPermissionRequests(
  state: PermissionQueueState,
  sessionId: string,
): PendingPermissionRequest[] {
  return [...(state.bySession.get(sessionId) ?? [])];
}

/** The session's current FIFO head, if any. */
export function headPermissionRequest(
  state: PermissionQueueState,
  sessionId: string,
): PendingPermissionRequest | undefined {
  return state.bySession.get(sessionId)?.[0];
}

/**
 * True only when this request is its session's current FIFO head (SPEC.md
 * §7.24's nested-visibility rule): a nested/subagent request is actionable
 * exactly when it — not some ancestor still ahead of it — is the visible
 * head; a stale/unknown id is never actionable.
 */
export function isPermissionRequestActionable(
  state: PermissionQueueState,
  requestId: string,
): boolean {
  const request = state.byId.get(requestId);
  if (!request) return false;
  return headPermissionRequest(state, request.sessionId)?.requestId === requestId;
}

function removePermissionRequest(
  state: PermissionQueueState,
  request: PendingPermissionRequest,
): PermissionQueueState {
  const byId = new Map(state.byId);
  byId.delete(request.requestId);

  const bySession = new Map(state.bySession);
  const remaining = (bySession.get(request.sessionId) ?? []).filter(
    (item) => item.requestId !== request.requestId,
  );
  if (remaining.length > 0) {
    bySession.set(request.sessionId, remaining);
  } else {
    bySession.delete(request.sessionId);
  }

  return { bySession, byId };
}

/**
 * Resolves a request (allow/deny, or a cancellation) and removes it from its
 * queue. A stale id (already resolved, or never existed) returns
 * `{status: 'stale'}` instead of silently succeeding, per §7.3's "no longer
 * applies" rule. Denying one request never touches its siblings — they stay
 * queued in their original order (SPEC.md §7.24's "Multi-request ordering").
 */
export function resolvePermissionRequest(
  state: PermissionQueueState,
  requestId: string,
  outcome: AcpPermissionOutcome,
): { state: PermissionQueueState; result: PermissionResolveResult } {
  const request = state.byId.get(requestId);
  if (!request) {
    return { state, result: { status: 'stale', requestId } };
  }
  const nextState = removePermissionRequest(state, request);
  return {
    state: nextState,
    result: { status: 'resolved', requestId, sessionId: request.sessionId, outcome },
  };
}

/**
 * A session-level Stop: every open request for that session resolves
 * immediately as cancelled, optimistically, without waiting for the agent's
 * own follow-up update — a spinner must never dangle past the moment Stop
 * was pressed (SPEC.md §7.24's "Multi-request ordering"). A different
 * session's queue is untouched.
 */
export function cancelAllPermissionRequests(
  state: PermissionQueueState,
  sessionId: string,
): { state: PermissionQueueState; results: PermissionResolveResult[] } {
  let nextState = state;
  const results: PermissionResolveResult[] = [];
  for (const request of listPermissionRequests(state, sessionId)) {
    const resolved = resolvePermissionRequest(nextState, request.requestId, {
      outcome: 'cancelled',
    });
    nextState = resolved.state;
    results.push(resolved.result);
  }
  return { state: nextState, results };
}
