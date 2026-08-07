/**
 * Turns an `AttentionState.detail` payload into the human-readable `reason`
 * `wireAgentSession`'s `'attention'` listener puts on the `session_status`
 * it forwards (SPEC §7.21; issue #271) — the exit code or error message
 * `AgentSession.handleTerminal()` (`@loombox/supervisor`) already captures
 * in `detail` for a mid-session `'error'`/`'exited'` transition, but that
 * listener used to drop on the floor, forwarding bare `status`/`updatedAt`
 * for every one of them.
 *
 * Issue #730 gave `'error'` a `reason` only for the PRE-spawn failure path
 * (`NodeDaemon.sendSessionStatus`'s direct calls from `createSessionInternal`'s
 * catch, MCP/env preflight failures, ...) — those run before a
 * `SessionBridge`/`AgentSession` exists at all, so they never go through
 * `'attention'` in the first place. A crash or unexpected exit AFTER a
 * bridge existed had no reason text whatsoever: the exact gap #271 asks
 * to close with state the node already has, not a guess.
 *
 * Returns `undefined` for every status this can't say anything honest
 * about (never invents text for `'working'`/`'awaiting_input'`/etc., and
 * degrades quietly rather than throwing on a `detail` shape it doesn't
 * recognize) — the caller's own `reason === undefined ? {} : { reason }`
 * spread (mirroring `sendSessionStatus`'s existing convention) then simply
 * omits the field, exactly like a peer that never populated it.
 */
export function reasonForAttentionState(state: {
  status: string;
  detail?: unknown;
}): string | undefined {
  if (state.status === 'error') {
    const detail = state.detail as { message?: unknown } | undefined;
    return typeof detail?.message === 'string' && detail.message.length > 0
      ? detail.message
      : undefined;
  }
  if (state.status === 'exited') {
    const detail = state.detail as { code?: unknown } | undefined;
    const code = typeof detail?.code === 'number' ? detail.code : undefined;
    return `agent process exited (exit code ${code ?? 'unknown'})`;
  }
  return undefined;
}
