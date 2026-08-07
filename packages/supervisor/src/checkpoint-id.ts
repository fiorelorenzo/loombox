import { randomUUID } from 'node:crypto';

/**
 * A monotonic, nanosecond-resolution checkpoint id, shared by every
 * checkpoint engine this package ships (`GitCheckpointStore`, issue #266;
 * `FsSnapshotCheckpointStore`, issue #267) so both sort their own
 * checkpoints the same way: lexicographically by this id, never by a
 * stored timestamp. A checkpoint's own commit/creation timestamp (git's
 * committer date, or this store's `Date.now()`) only has whole-second
 * resolution in git's case and can't be trusted to order two checkpoints
 * taken in the same second — a real scenario in a fast test run, and not
 * impossible in production either (issue #603's auto-checkpoint fires
 * once per turn, and two turns can start within the same second).
 * `process.hrtime.bigint()` never repeats and never goes backwards within
 * one process's lifetime, so the lexicographic sort of the padded string
 * is exactly the creation order; the trailing UUID fragment is only there
 * so two ids can never collide even if `hrtime` were ever coarser than
 * expected on some platform.
 */
export function generateCheckpointId(): string {
  return `${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID().slice(0, 8)}`;
}
