import type {
  AcpAvailableCommand,
  AcpConfigOption,
  AcpDiff,
  AcpMessageChunkKind,
  AcpMessageChunkUpdate,
  AcpPlanEntry,
  AcpPlanUpdate,
  AcpSessionStatus,
  AcpSessionWireEvent,
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

/**
 * SPEC.md §7.9's live percentage meter warns once context fill crosses this
 * threshold. Not a round number picked for its own sake: real-world
 * auto-compaction thresholds on ACP-speaking agents cluster between roughly
 * 80% and 95% of the window (Claude Code's own default is reported anywhere
 * from ~80% to ~95% depending on source/version, with an internal cap around
 * 83% — see the PR description for the sources) — 80 sits at the LOW end of
 * that range, so the warning fires before the EARLIEST point any of them
 * might silently compact, giving the user the most lead time to act (wrap up
 * the turn, or intervene) rather than being surprised by a summary later.
 * Exported so a future consumer (e.g. issue #250's inbox surfacing) reuses
 * this exact number instead of picking its own.
 */
export const CONTEXT_NEAR_LIMIT_THRESHOLD = 80;

export interface UsageRecord {
  sessionId: string;
  /** Tokens currently in context, per the last update this session's live percentage meter trusts — see `attributedToSubagent`. */
  tokensUsed: number | undefined;
  contextWindow: number | undefined;
  /** The latest reported `cost.amount`, regardless of attribution — always folded into `TranscriptState.cumulativeCostUsd`, see `reduceUsage`. */
  costUsd: number | undefined;
  /**
   * A CLIENT-SIDE HEURISTIC, not a protocol guarantee (SPEC.md §16: ACP's
   * own `usage_update` is flat and session-level — `{used, size, cost}`,
   * agentclientprotocol.com/protocol/v1/schema's `UsageUpdate` — with no
   * field linking it to any tool call at all). True when the *most recent*
   * usage_update was reduced while a nested tool call (one with a
   * `parentToolCallId`) was still `pending`/`in_progress` in this session's
   * transcript, on the reasoning that a subagent invocation shows up as
   * exactly that shape (Claude Code's `_meta.claudeCode.parentToolUseId`,
   * promoted by `enrich()`) and the usage reported while it's running is
   * most likely the subagent's own, much smaller, context window rather
   * than the parent's.
   *
   * What it keys on: ONLY tool-call in-flight state, correlated by TIMING —
   * nothing on the wire event itself names a tool call. How it fails:
   *  - Out-of-order delivery: if the subagent's own `tool_call` hasn't been
   *    reduced yet when its `usage_update` arrives, this reads `false` and
   *    the subagent's smaller numbers leak into the parent's percentage for
   *    one update — the exact bug this heuristic exists to avoid, just not
   *    perfectly closed.
   *  - A genuine parent-turn usage_update that happens to arrive while an
   *    unrelated nested tool call is still open reads `true` and gets
   *    wrongly suppressed — the percentage lags behind real parent-context
   *    growth until that unrelated nested call settles.
   *  - It assumes ACP-visible nesting is the only source of "someone else
   *    is spending in this session": a provider that runs a subagent
   *    entirely inside one tool-call invocation, with no separate
   *    ACP-visible child call, is invisible to it.
   *
   * When true, `tokensUsed`/`contextWindow` on THIS record are carried over
   * UNCHANGED from the last `false` record (frozen) rather than the numbers
   * this update reported — see `reduceUsage`. `costUsd` is NEVER frozen: it
   * always reflects the newest report, folded into
   * `TranscriptState.cumulativeCostUsd` regardless of this flag (SPEC.md
   * §7.9: "still included in the cumulative cost figure").
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
  /** The session's latest cumulative-cost figure, derived from every `usage_update.cost` seen (SPEC.md §7.9) — see `reduceUsage` for why this is a running max, not a sum, and why it is never gated on subagent attribution. */
  cumulativeCostUsd: number;
  /** This session's latest pushed status, if any `session_status` event has arrived yet (SPEC.md §7.13/§7.24; issue #126). */
  status: AcpSessionStatus | undefined;
  /** The ISO timestamp of `status`'s own transition, mirrored from the pushing `session_status` event. */
  statusUpdatedAt: string | undefined;
  /** This session's complete, negotiated config-option catalog (SPEC.md §7.24; issue #149) — always the full current set, replaced wholesale by a `config_options`/`config_option_update` event, never patched per-category. `[]` until the first push arrives. */
  configOptions: AcpConfigOption[];
  /** This session's complete, agent-declared `/`-command catalogue (SPEC.md §7.24; issue #741) — always the full current set, replaced wholesale by an `available_commands_update` event, never patched per-command. `[]` until the agent sends one (a real agent's first `available_commands_update` arrives with its first `session/prompt` reply, not at session creation) — a genuinely empty catalogue, not an error state. */
  commands: AcpAvailableCommand[];
  /** True between a `turn_started` and its matching `turn_ended` (SPEC.md §7.24; issue #128) — the deterministic replacement for a client-side idle-timeout guess. */
  turnActive: boolean;
  /** The `stopReason` of the most recently settled turn, if any `turn_ended` event carried one. */
  lastStopReason: string | undefined;
}

/** The empty starting state for a session's transcript. */
export function createTranscriptState(): TranscriptState {
  return {
    items: [],
    plan: [],
    usage: undefined,
    cumulativeCostUsd: 0,
    status: undefined,
    statusUpdatedAt: undefined,
    configOptions: [],
    commands: [],
    turnActive: false,
    lastStopReason: undefined,
  };
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
  // `update.id` is typed `string`, but the wire cast that produces an
  // `AcpSessionWireEvent` (`apps/web/src/lib/relay-client.ts`'s
  // `openJson<AcpSessionWireEvent>`) never validates it, so a malformed
  // `tool_call`/`tool_call_update` can carry `id: undefined` at runtime
  // (issue #548). `-1` here (never look up an existing row) keeps that
  // case from matching an EARLIER malformed item that also has `id:
  // undefined` — `undefined === undefined` would otherwise silently merge
  // two unrelated tool calls into one row.
  const index =
    update.id === undefined
      ? -1
      : state.items.findIndex((item) => item.type === 'tool_call' && item.id === update.id);

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
 * Full detail — what it keys on and how it fails — lives on
 * `UsageRecord.attributedToSubagent`, which this feeds.
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
  const attributedToSubagent = hasActiveNestedToolCall(state.items);
  const previous = state.usage;

  // §7.9/§16: a subagent-attributed update is excluded from the parent's
  // context-fill *percentage* by FREEZING tokensUsed/contextWindow at the
  // last non-subagent record, rather than adopting the subagent's own
  // (much smaller) numbers and relying on a UI-side guard to hide them —
  // that earlier shape just traded "the meter bounces to the wrong number"
  // for "the meter bounces to blank," which is still a bounce. Freezing
  // here, once, means every consumer of `state.usage` sees a stable figure
  // with no guard of its own to get wrong.
  const usage: UsageRecord = {
    sessionId: update.sessionId,
    tokensUsed: attributedToSubagent ? previous?.tokensUsed : update.tokensUsed,
    contextWindow: attributedToSubagent ? previous?.contextWindow : update.contextWindow,
    costUsd: update.costUsd,
    attributedToSubagent,
  };

  // ACP's `cost.amount` is documented as "Total cumulative cost for
  // session" (agentclientprotocol.com/protocol/v1/schema's Cost type) — a
  // running total the agent itself reports, not a per-update delta — so
  // this takes the latest figure rather than summing one (summing would
  // double-count every update after the first). Deliberately NOT gated on
  // `attributedToSubagent`: a subagent tool call spends against the same
  // session, and the agent's own cumulative total already reflects that
  // spend (SPEC.md §7.9: "still included in the cumulative cost figure").
  // `Math.max` only guards against an out-of-order delivery ever making the
  // figure visibly shrink.
  const cumulativeCostUsd =
    update.costUsd === undefined
      ? state.cumulativeCostUsd
      : Math.max(state.cumulativeCostUsd, update.costUsd);

  return { ...state, usage, cumulativeCostUsd };
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
 * Reduce one {@link AcpSessionWireEvent} into a new `TranscriptState` — the
 * wider reducer entry point for everything that can travel inside a
 * `session_update` envelope (SPEC.md §7.13/§7.24/§8; issues #126/#128/#149),
 * additive to {@link reduceTranscript}: every ACP transcript-reducer update
 * kind delegates straight through to it unchanged, and the six
 * session-lifecycle kinds are folded into the new `status`/`configOptions`/
 * `commands`/`turnActive`/`lastStopReason` fields instead. Never mutates
 * `state`, same contract as `reduceTranscript`.
 */
export function reduceSessionEvent(
  state: TranscriptState,
  event: AcpSessionWireEvent,
): TranscriptState {
  switch (event.kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan_update':
    case 'usage_update':
      return reduceTranscript(state, event);
    case 'session_status':
      return { ...state, status: event.status, statusUpdatedAt: event.updatedAt };
    case 'config_options':
    case 'config_option_update':
      return {
        ...state,
        configOptions: event.options.map((option) => ({ ...option, choices: [...option.choices] })),
      };
    case 'available_commands_update':
      return { ...state, commands: event.commands.map((command) => ({ ...command })) };
    case 'turn_started':
      return { ...state, turnActive: true };
    case 'turn_ended':
      return { ...state, turnActive: false, lastStopReason: event.stopReason };
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
