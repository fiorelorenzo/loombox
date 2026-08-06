import type { AcpProvider, AcpSpawnConfig } from '@loombox/providers-core';
import type { CustomAgentRecordV1 } from '@loombox/protocol';

/**
 * D1-3's security boundary (`docs/superpowers/specs/
 * 2026-08-05-zed-parity-decisions.md` §4; issue #748): the node, never the
 * client, decides whether a custom agent's `command` may run. Thrown by
 * {@link assertCustomAgentAllowed} and caught wherever a session launch
 * resolves a provider to spawn (`@loombox/node`'s `node-daemon.ts`), where
 * its `.message` becomes the `session_status`'s `reason` the client shows
 * verbatim — "a request to run a binary outside it is refused with a
 * reason the client shows" is this error's entire job.
 */
export class CustomAgentNotAllowedError extends Error {
  constructor(readonly command: string) {
    super(
      `custom agent command "${command}" is not on this node's custom-agent allowlist and was refused. ` +
        `An operator must add it to LOOMBOX_CUSTOM_AGENT_ALLOWLIST or the config file's ` +
        `"customAgentAllowlist" on the node itself and restart it — this can never be changed from a client.`,
    );
    this.name = 'CustomAgentNotAllowedError';
  }
}

/**
 * The allowlist check itself: exact string membership, nothing fuzzier.
 * `command` is matched byte-for-byte against every allowlist entry — no
 * globbing, no realpath resolution, no basename-only comparison — so what
 * an operator typed into `LOOMBOX_CUSTOM_AGENT_ALLOWLIST`/the config file
 * is exactly what is permitted, with no ambiguity a symlink or a
 * `PATH`-relative lookup trick could exploit.
 */
export function isCustomAgentCommandAllowed(
  command: string,
  allowlist: readonly string[],
): boolean {
  return allowlist.includes(command);
}

/** Throws {@link CustomAgentNotAllowedError} unless `command` is on `allowlist` — the one call every custom-agent launch path (`local` and `ssh:` alike) must make before ever touching `AgentSupervisor`. */
export function assertCustomAgentAllowed(command: string, allowlist: readonly string[]): void {
  if (!isCustomAgentCommandAllowed(command, allowlist)) {
    throw new CustomAgentNotAllowedError(command);
  }
}

/**
 * Builds the ad-hoc v0 {@link AcpProvider} `AgentSupervisor.start()`/
 * `startWithChild()` spawn a custom agent through — the same shape every
 * registered provider (`@loombox/providers-claude`'s `claudeProvider`, ...)
 * already satisfies, just built from a client-supplied record instead of a
 * hand-written module. `enrich` is the generic ACP tier's own no-op
 * pass-through (SPEC §5.5): a client-defined custom agent gets no bespoke
 * `_meta` promotion, exactly like any other unregistered ACP agent falls
 * back to the generic tier today (`packages/providers/generic`'s
 * `createGenericProvider`, whose v0 `AcpProvider` sibling this mirrors).
 *
 * Callers MUST call {@link assertCustomAgentAllowed} first — this function
 * has no opinion on the allowlist at all, so it is not itself a security
 * boundary; it only exists to turn an already-cleared record into the
 * shape `AgentSupervisor` understands.
 */
export function createCustomAgentProvider(
  providerId: string,
  record: CustomAgentRecordV1,
): AcpProvider {
  const spawnConfig: AcpSpawnConfig = {
    command: record.command,
    args: record.args,
    env: record.env,
  };
  return {
    id: providerId,
    spawnConfig: () => spawnConfig,
    enrich: (update) => update,
  };
}
