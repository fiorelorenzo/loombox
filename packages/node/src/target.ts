import type { TargetDescriptor } from '@loombox/protocol';

/**
 * Execution-target types this node exposes (SPEC §5.2, §6): `local` runs the
 * agent on the node's own machine in a git worktree (fully implemented,
 * `SessionManager`); `ssh:` runs it on a remote host reachable over SSH,
 * deployed and launched via `packages/node/src/ssh/` (issue #80/#81/#82/#84:
 * `RemoteTransport`/`Ssh2Transport`, `RemoteProcessRunner`'s deploy-and-detach
 * with a tmux/screen fallback, `SessionLeaseManager`, and
 * `verifyAndPersistSshTarget`). `NodeDaemon.createSession()` routes an
 * `ssh:` target's session through that machinery, wrapped in a
 * `RemoteAgentChildProcess` so it plugs into `AgentSupervisor.startWithChild`
 * exactly like a `local` session plugs into `AgentSupervisor.start`.
 *
 * Known, deliberate gap in this wave: unlike `local`'s per-session isolated
 * git worktree, an `ssh:` session runs directly in `projectPath` on the
 * remote host — remote worktree/branch management over SSH is a natural
 * follow-up (SPEC §5.2 mentions it as part of the target's general
 * capability set) but isn't asked for by issues #80/#81/#82/#84.
 */

/** The single `local` target every node exposes by default. */
export const DEFAULT_LOCAL_TARGET: TargetDescriptor = {
  id: 'local',
  kind: 'local',
  label: 'Local',
};

/**
 * The connection recipe one `ssh:` target needs (`NodeDaemonOptions.sshTargets`,
 * keyed by matching the `TargetDescriptor.id` this node also announces).
 * Auth tries, in order (see `Ssh2Transport`): `privateKeyPath`, then
 * `ssh-agent` (autodetected via `$SSH_AUTH_SOCK` unless `agent` overrides or
 * disables it), then `password` as a last resort — matching SPEC §7.23's
 * autodetect ("picks up your keys and ssh-agent").
 */
export interface SshTargetConfig {
  id: string;
  label: string;
  host: string;
  user?: string;
  port?: number;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  agent?: string | false;
}
