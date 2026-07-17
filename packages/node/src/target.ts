import type { TargetDescriptor } from '@loombox/protocol';

/**
 * Execution-target types this node exposes (SPEC §5.2, §6): `local` runs the
 * agent on the node's own machine in a git worktree (fully implemented,
 * `SessionManager`); `ssh:` runs it on a remote host reachable over SSH.
 *
 * v1 Wave C ships `local` only. `ssh:` is a type-level seam for now — the
 * pooled-SSH transport and remote supervisor deploy-and-detach are the
 * follow-up (issue #80, "Wave C.2"): `NodeDaemon.createSession()` throws a
 * clear "not implemented" error for any target whose descriptor's `kind` is
 * `'ssh'`, rather than silently doing nothing or pretending to succeed.
 */

/** The single `local` target every node exposes by default. */
export const DEFAULT_LOCAL_TARGET: TargetDescriptor = {
  id: 'local',
  kind: 'local',
  label: 'Local',
};

/**
 * The connection recipe an `ssh:` target will need once #80 lands (pooled
 * SSH transport + remote mise/PATH-aware supervisor deploy). Not consumed by
 * anything yet — this is the documented interface seam only, so a future
 * transport has an agreed-on shape to implement against instead of starting
 * from nothing.
 */
export interface SshTargetConfig {
  id: string;
  label: string;
  host: string;
  user?: string;
  port?: number;
}
