import type { RelayStore } from './store';

/**
 * Relay data retention (#102, SPEC §9's "relay data lifecycle"). Deletes
 * expired/over-cap ciphertext (sessions, blobs, resync-ring entries) through
 * the `RelayStore` interface, not raw SQL — so this one algorithm runs
 * identically over the Postgres-backed store (the real, CLI-driven path,
 * see `prune-cli.ts`) and the in-memory store (this file's own hermetic
 * tests), which is also what "keep both stores in lockstep" (#101/#102)
 * actually buys: `prune.test.ts` proves the same pruning decisions against
 * both backends without needing Docker or a live Postgres.
 */

/** 90 days — a deliberately generous default; self-hosters tune it via `RELAY_RETENTION_MS` (see `prune-cli.ts`). */
export const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface PruneOptions {
  /**
   * Sessions/blobs whose `createdAt` is older than `now() - retentionMs` are
   * TTL-pruned. `undefined` disables the TTL pass entirely (size-cap-only
   * mode). Ring entries are deliberately not TTL-pruned — they're already
   * bounded by `ringBufferSize` (a count-based cap) and, unlike sessions/
   * blobs, don't carry a wall-clock `created_at` column (see
   * `migrations.ts`'s `0004_blob_quota_retention` comment on why that
   * column was added only to `blobs`, not `session_ring_entries`) — the
   * size-cap pass below is what prunes ring entries, using `seq` (always
   * monotonic, so always a correct age proxy) instead.
   */
  retentionMs?: number;
  /**
   * Per-account byte budget (blobs + ring entries, `store.quota`'s same
   * number as #101's write-time quota — `prune-cli.ts` defaults both to the
   * same env var). When an account is over this, its oldest blobs are
   * pruned first, then its oldest ring entries if still over. `undefined`
   * disables the size-cap pass entirely (TTL-only mode).
   */
  maxAccountBytes?: number;
  /** Reports what would be pruned without deleting anything (#102 acceptance). */
  dryRun?: boolean;
  /** Injectable clock, for deterministic TTL-boundary tests. */
  now?: () => number;
}

export interface PruneReport {
  dryRun: boolean;
  expiredSessions: number;
  expiredBlobs: number;
  overCapBlobs: number;
  overCapRingEntries: number;
}

/** Runs the TTL pass: sessions and blobs older than the retention window. Idempotent — a second run sees nothing left to expire. */
async function pruneExpired(
  store: RelayStore,
  cutoff: number,
  dryRun: boolean,
  report: PruneReport,
): Promise<void> {
  const sessions = await store.sessions.listAllMeta();
  for (const meta of sessions) {
    if (meta.createdAt < cutoff) {
      report.expiredSessions += 1;
      if (!dryRun) await store.sessions.deleteSession(meta.id);
    }
  }

  const blobs = await store.blobs.listForRetention();
  for (const blob of blobs) {
    // `createdAt === undefined` means a pre-#101-migration row of unknown
    // age (see `BlobRetentionMeta`'s doc comment) — never TTL-pruned.
    if (blob.createdAt !== undefined && blob.createdAt < cutoff) {
      report.expiredBlobs += 1;
      if (!dryRun) await store.blobs.delete(blob.key);
    }
  }
}

/**
 * Runs the size-cap pass: for every account over `maxAccountBytes`, deletes
 * its oldest blobs first (by `createdAt`, unknown-age rows sorted last so
 * they're the least likely to be touched), then — only if still over
 * budget — its oldest ring entries (by `seq`, oldest-session-prefix-first,
 * via the same contiguous-prefix eviction `pushRingEntry`'s capacity path
 * already uses). Re-reads real usage from `store.quota` after every actual
 * deletion rather than subtracting locally, so it can't drift from the
 * store's own accounting; in `dryRun` mode (nothing is actually deleted)
 * it estimates by subtracting each candidate's own byte count instead.
 */
async function pruneOverCap(
  store: RelayStore,
  maxAccountBytes: number,
  dryRun: boolean,
  report: PruneReport,
): Promise<void> {
  const blobs = await store.blobs.listForRetention();
  const ringEntries = await store.sessions.listRingEntriesForRetention();

  const accountIds = new Set<string>();
  for (const blob of blobs) accountIds.add(blob.accountId);
  for (const entry of ringEntries) accountIds.add(entry.accountId);

  for (const accountId of accountIds) {
    // A blank accountId means unattributed pre-migration data (see
    // `BlobRetentionMeta`) — never size-cap-prune it, we don't know who to
    // charge it to, let alone whether they're actually over budget.
    if (!accountId) continue;

    let usage = await store.quota.getUsageBytes(accountId);
    if (usage <= maxAccountBytes) continue;

    const accountBlobs = blobs
      .filter((blob) => blob.accountId === accountId)
      .sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity));
    for (const blob of accountBlobs) {
      if (usage <= maxAccountBytes) break;
      report.overCapBlobs += 1;
      if (!dryRun) {
        await store.blobs.delete(blob.key);
        usage = await store.quota.getUsageBytes(accountId);
      } else {
        usage -= blob.bytes;
      }
    }

    if (usage <= maxAccountBytes) continue;

    const accountRingEntries = ringEntries
      .filter((entry) => entry.accountId === accountId)
      .sort((a, b) => a.seq - b.seq);
    for (const entry of accountRingEntries) {
      if (usage <= maxAccountBytes) break;
      report.overCapRingEntries += 1;
      if (!dryRun) {
        await store.sessions.pruneRingEntriesThrough(entry.sessionId, entry.seq);
        usage = await store.quota.getUsageBytes(accountId);
      } else {
        usage -= entry.bytes;
      }
    }
  }
}

/** Runs the retention pass described by `opts` (#102). Safe to call repeatedly (idempotent). */
export async function prune(store: RelayStore, opts: PruneOptions = {}): Promise<PruneReport> {
  const now = opts.now ?? Date.now;
  const dryRun = opts.dryRun ?? false;
  const report: PruneReport = {
    dryRun,
    expiredSessions: 0,
    expiredBlobs: 0,
    overCapBlobs: 0,
    overCapRingEntries: 0,
  };

  if (opts.retentionMs !== undefined && Number.isFinite(opts.retentionMs)) {
    await pruneExpired(store, now() - opts.retentionMs, dryRun, report);
  }
  if (opts.maxAccountBytes !== undefined) {
    await pruneOverCap(store, opts.maxAccountBytes, dryRun, report);
  }

  return report;
}
