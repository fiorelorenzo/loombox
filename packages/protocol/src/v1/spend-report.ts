import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Wire surface for the aggregate spend-over-time view (SPEC §7.9's "shows
 * spend over time per project/provider"; issue #249). Node-addressed by
 * `nodeId` + `projectPath`, exactly like `tracker-records.ts`'s
 * `tracker_snapshot_request`/`_response` pair and for the identical
 * reason: a project's spend history outlives any one session that ran up
 * part of it, and must be reachable with zero sessions currently running.
 * `envelope` is sealed to the **project** key (`deriveProjectKey`), not a
 * session key — see `tracker-records.ts`'s own doc comment for why that
 * key family, not `deriveSessionKey`, is the one that makes a session-less
 * read possible.
 *
 * `sinceDate`/`untilDate` (inclusive, `YYYY-MM-DD`, UTC) travel in the
 * clear on the request, not inside an envelope: a date range is a query
 * parameter, not project content, the same reasoning `spend-cap.ts`'s own
 * doc comment gives for `spend_cap_get` carrying no envelope at all.
 *
 * The rows this carries are never a second, independently-computed cost
 * figure. `@loombox/node`'s `NodeDaemon.recordUsageCost` is the one place
 * a `usage_update.costUsd` becomes either a live cumulative total
 * (`SessionBridge.spendCumulativeCostUsd`, `spend-cap.ts`'s own concern —
 * SPEC §7.16's cap enforcement) or a persisted `SpendLedgerStore` delta
 * (this file's concern) — both read the identical reported increase,
 * never two divergent calculations of "how much did this session actually
 * cost."
 *
 * A day with no recorded row for a project/provider means exactly that:
 * no `usage_update` cost increase was ever observed for it, not a real
 * zero. `rows` only ever contains days that actually happened — an empty
 * array for an in-range project is a legitimate "no data" answer, which
 * the client (never this payload) turns into an honest "no data" reading
 * rather than a fabricated $0.00 (SPEC §7.9's live-meter convention,
 * `StatusBar.svelte`'s own doc comment).
 */
export const spendReportRowV1 = z.object({
  /** UTC calendar date (`YYYY-MM-DD`) this delta was attributed to — the wall-clock day the underlying `usage_update` arrived, not any date embedded in agent-reported data (ACP carries no such timestamp). */
  date: z.string().min(1),
  /** Provider id (e.g. `'claude'`, `'codex'`), opaque here exactly like `Session.provider`. */
  provider: z.string().min(1),
  /** Summed cost delta in USD for this project/provider/date — always > 0 (`SpendLedgerStore.recordDelta` rejects a non-positive delta; there is nothing to persist for a day nothing increased). */
  costUsd: z.number().positive(),
});
export type SpendReportRowV1 = z.infer<typeof spendReportRowV1>;

/** The plaintext a `spend_report_response` envelope decrypts to: every ledger row this node holds for the requested project, already date-filtered server-side by the request's `sinceDate`/`untilDate`. */
export const spendReportResponsePayloadV1 = z.object({
  rows: z.array(spendReportRowV1),
});
export type SpendReportResponsePayloadV1 = z.infer<typeof spendReportResponsePayloadV1>;

/** Parses and validates a decrypted `spend_report_response` payload, throwing on an invalid one. */
export function parseSpendReportResponsePayloadV1(data: unknown): SpendReportResponsePayloadV1 {
  return spendReportResponsePayloadV1.parse(data);
}

/** Same as {@link parseSpendReportResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseSpendReportResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SpendReportResponsePayloadV1> {
  return spendReportResponsePayloadV1.safeParse(data);
}

/** A client asks the owning node for a project's spend-ledger rows, optionally bounded to `[sinceDate, untilDate]` (either or both omitted = unbounded on that side). No envelope — see this file's doc comment. */
export const spendReportRequest = z.object({
  type: z.literal('spend_report_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  requestId: z.string().min(1),
  sinceDate: z.string().min(1).optional(),
  untilDate: z.string().min(1).optional(),
});
export type SpendReportRequest = z.infer<typeof spendReportRequest>;

/** The owning node's reply to `spend_report_request` — always sent, even when `rows` is empty (a project with nothing recorded in range is a real, representable answer, not a dropped request). */
export const spendReportResponse = z.object({
  type: z.literal('spend_report_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type SpendReportResponse = z.infer<typeof spendReportResponse>;
