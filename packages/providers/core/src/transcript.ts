import type {
  AcpDiff,
  AcpMessageChunkKind,
  AcpMessageChunkUpdate,
  AcpPlanEntry,
  AcpPlanUpdate,
  AcpToolCallStatus,
  AcpToolCallUpdate,
  AcpToolKind,
  AcpTranscriptUpdate,
  AcpUsageUpdate,
} from './types';

/**
 * The v1 transcript reducer (SPEC.md §7.24 "One reducer, append-only by
 * id"; §5.5 "core owns tool_call/tool_call_update, plan_update,
 * usage_update"). Pure: `reduceTranscript(state, update)` always returns a
 * new `TranscriptState`, never mutates its input, so the same reducer can
 * run identically for a live stream and for replayed history (§7.22).
 */

/** A coalesced message/thought item: one per (turn, kind, messageId). */
export interface TranscriptMessageItem {
  type: 'message';
  /** `${turnId}::${kind}::${messageId}` — stable across chunks so a virtualized transcript never remounts it (SPEC.md §7.24). */
  id: string;
  kind: AcpMessageChunkKind;
  turnId: string;
  messageId: string;
  /** The accumulated text after every chunk appended so far. */
  text: string;
}

/** A tool-call item, created by `tool_call` and mutated in place by `tool_call_update`. */
export interface TranscriptToolCallItem {
  type: 'tool_call';
  id: string;
  turnId: string | undefined;
  title: string | undefined;
  toolKind: AcpToolKind | undefined;
  status: AcpToolCallStatus | undefined;
  diff: AcpDiff | undefined;
  rawInput: unknown;
  content: unknown;
  /** Promoted from a vendor `_meta` field by a provider's `enrich()` hook (SPEC.md §5.5); marks a nested/subagent tool call. */
  parentToolCallId: string | undefined;
}

export type TranscriptItem = TranscriptMessageItem | TranscriptToolCallItem;

export interface UsageRecord {
  sessionId: string;
  tokensUsed: number | undefined;
  contextWindow: number | undefined;
  costUsd: number | undefined;
  /**
   * A client-side heuristic, NOT a protocol guarantee (SPEC.md §16:
   * "usage_update is session-level (no per-tool attribution) — subagent-
   * exclusion is a client-side heuristic, flag it"). True when this
   * usage_update was reduced while a nested tool call (one with a
   * `parentToolCallId`) was still `pending`/`in_progress` in this session's
   * transcript, on the reasoning that the usage being reported mid-flight is
   * most likely the subagent's own. A later UI should exclude a `true`
   * record from the live context-fill percentage meter, while still folding
   * its cost into `TranscriptState.cumulativeCostUsd` (SPEC.md §7.9).
   */
  attributedToSubagent: boolean;
}

export interface TranscriptState {
  /** Ordered by first appearance; a coalesced chunk update never changes an item's position. */
  items: TranscriptItem[];
  /** ACP replaces the whole plan on every `plan_update`; this is always that latest list verbatim (SPEC.md §7.24). */
  plan: AcpPlanEntry[];
  /** The latest `usage_update` seen for this session, if any. */
  usage: UsageRecord | undefined;
  /** Running total of every `usage_update.costUsd` seen, regardless of subagent attribution (SPEC.md §7.9). */
  cumulativeCostUsd: number;
}

/** The empty starting state for a session's transcript. */
export function createTranscriptState(): TranscriptState {
  return { items: [], plan: [], usage: undefined, cumulativeCostUsd: 0 };
}

function messageItemId(kind: AcpMessageChunkKind, turnId: string, messageId: string): string {
  return `${turnId}::${kind}::${messageId}`;
}

function reduceMessageChunk(
  state: TranscriptState,
  update: AcpMessageChunkUpdate,
): TranscriptState {
  const id = messageItemId(update.kind, update.turnId, update.messageId);
  const index = state.items.findIndex((item) => item.type === 'message' && item.id === id);

  const items = state.items.slice();
  if (index === -1) {
    const item: TranscriptMessageItem = {
      type: 'message',
      id,
      kind: update.kind,
      turnId: update.turnId,
      messageId: update.messageId,
      text: update.text,
    };
    items.push(item);
  } else {
    const existing = items[index] as TranscriptMessageItem;
    items[index] = { ...existing, text: existing.text + update.text };
  }
  return { ...state, items };
}

function reduceToolCall(state: TranscriptState, update: AcpToolCallUpdate): TranscriptState {
  const index = state.items.findIndex((item) => item.type === 'tool_call' && item.id === update.id);

  const items = state.items.slice();
  if (index === -1) {
    const item: TranscriptToolCallItem = {
      type: 'tool_call',
      id: update.id,
      turnId: update.turnId,
      title: update.title,
      toolKind: update.toolKind,
      status: update.status,
      diff: update.diff,
      rawInput: update.rawInput,
      content: update.content,
      parentToolCallId: update.parentToolCallId,
    };
    items.push(item);
  } else {
    // tool_call_update mutates the existing entry in place: a field the
    // update didn't resend (e.g. a status-only flip omitting `diff`) must
    // not clobber what was already recorded (SPEC.md §7.24).
    const existing = items[index] as TranscriptToolCallItem;
    items[index] = {
      ...existing,
      turnId: update.turnId ?? existing.turnId,
      title: update.title ?? existing.title,
      toolKind: update.toolKind ?? existing.toolKind,
      status: update.status ?? existing.status,
      diff: update.diff ?? existing.diff,
      rawInput: update.rawInput ?? existing.rawInput,
      content: update.content ?? existing.content,
      parentToolCallId: update.parentToolCallId ?? existing.parentToolCallId,
    };
  }
  return { ...state, items };
}

function reducePlan(state: TranscriptState, update: AcpPlanUpdate): TranscriptState {
  return { ...state, plan: update.entries.slice() };
}

/**
 * The subagent-attribution heuristic (SPEC.md §16/§7.9): true while any
 * tool call carrying a `parentToolCallId` is still `pending`/`in_progress`.
 * Documented as a heuristic, not a protocol guarantee, because ACP's
 * `usage_update` itself carries no tool-call linkage.
 */
function hasActiveNestedToolCall(items: readonly TranscriptItem[]): boolean {
  return items.some(
    (item) =>
      item.type === 'tool_call' &&
      item.parentToolCallId !== undefined &&
      (item.status === 'pending' || item.status === 'in_progress'),
  );
}

function reduceUsage(state: TranscriptState, update: AcpUsageUpdate): TranscriptState {
  const usage: UsageRecord = {
    sessionId: update.sessionId,
    tokensUsed: update.tokensUsed,
    contextWindow: update.contextWindow,
    costUsd: update.costUsd,
    attributedToSubagent: hasActiveNestedToolCall(state.items),
  };
  return {
    ...state,
    usage,
    cumulativeCostUsd: state.cumulativeCostUsd + (update.costUsd ?? 0),
  };
}

/**
 * Reduce one ACP v1 update into a new `TranscriptState`. Never mutates
 * `state`; a late listener that kept a reference to the old state still sees
 * the pre-update value (SPEC.md §7.24).
 */
export function reduceTranscript(
  state: TranscriptState,
  update: AcpTranscriptUpdate,
): TranscriptState {
  switch (update.kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return reduceMessageChunk(state, update);
    case 'tool_call':
    case 'tool_call_update':
      return reduceToolCall(state, update);
    case 'plan_update':
      return reducePlan(state, update);
    case 'usage_update':
      return reduceUsage(state, update);
  }
}

/**
 * The tool-call id chain from `toolCallId`'s immediate parent up to its
 * root ancestor (nearest first), walking `parentToolCallId` links (SPEC.md
 * §5.5's `enrich()`-promoted nested/subagent marker). A UI's permission-queue
 * nested-visibility rule (SPEC.md §7.24: "a pending request nested inside a
 * collapsed ancestor auto-expands that ancestor chain") uses this to know
 * which group ids to force open for a given head request.
 *
 * `toolCallId` itself is never included. Returns `[]` for an unknown id, a
 * root-level call (no `parentToolCallId`), or a broken/cyclic chain once a
 * link no longer resolves to a known item — this never throws. v1 has no
 * bespoke provider that populates `parentToolCallId` yet (§7.24: "ships in
 * v2"), so this is a real no-op today and only exercised once a provider's
 * `enrich()` hook starts promoting one.
 */
export function ancestorChainForToolCall(
  items: readonly TranscriptItem[],
  toolCallId: string,
): string[] {
  const byId = new Map<string, TranscriptToolCallItem>();
  for (const item of items) {
    if (item.type === 'tool_call') byId.set(item.id, item);
  }

  const chain: string[] = [];
  const visited = new Set<string>([toolCallId]);
  let current = byId.get(toolCallId)?.parentToolCallId;

  while (current !== undefined && !visited.has(current)) {
    chain.push(current);
    visited.add(current);
    current = byId.get(current)?.parentToolCallId;
  }

  return chain;
}
