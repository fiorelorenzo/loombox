/**
 * Wires a `NodeDaemon`'s inbound `'provision_target_request'` events (issue
 * #408's zero-touch add-target wizard) to `./ssh/provision-and-pair.ts`,
 * streaming its progress back over the relay as `provision_progress`/
 * `provision_target_result`. Mirrors `amk-epoch.ts`'s own shape: `NodeDaemon`
 * deliberately never holds this device's own ECDH private key (see its
 * class doc comment), so a caller that *does* hold it (`main.ts`, via
 * `identity.ts`'s `NodeIdentityStore`) closes that loop here, exactly like
 * `wireAmkEpochAdoption` does for AMK-epoch rotation.
 */
import type { ProvisionTargetRequest } from '@loombox/protocol';

import type { NodeDaemon } from './node-daemon';
import type { AmkHandoffActingIdentity } from './ssh/amk-handoff-provision';
import { discoverSshTargets, type DiscoverSshTargetsOptions } from './ssh/host-candidates';
import {
  provisionAndPair,
  type ProvisionAndPairOptions,
  type ProvisionAndPairProgress,
} from './ssh/provision-and-pair';
import type { SshTargetConfig } from './target';

/**
 * The subset of `ProvisionAndPairOptions` this wiring can't derive from
 * `NodeDaemon`/the inbound request itself — deployment-specific config a
 * caller (`main.ts`) supplies once, up front. `supervisor` has no built-in
 * default (issue #86: no real signed-artifact source exists yet in this
 * repo) — exactly like `provisionAndPair`/`provision()` themselves require
 * it with no default, so this wiring doesn't invent one either.
 */
export interface WireProvisionAndPairOptions {
  relayUrl: string;
  accountId: string;
  /** This (acting) node's own bearer token — the same one it authenticates to the relay with. */
  authToken: string;
  /** This node's own ECDH identity (private key + raw public key), from `identity.ts`'s `NodeIdentityStore` — never held by `NodeDaemon` itself. */
  actingIdentity: AmkHandoffActingIdentity;
  supervisor: ProvisionAndPairOptions['supervisor'];
  claudeCodeOAuthToken?: string;
  /** Passed straight through to `discoverSshTargets` for alias resolution (issue #83); tests override `homeDir`/`env`. */
  discoverOptions?: DiscoverSshTargetsOptions;
  /** Injectable for tests; defaults to the real `provisionAndPair`. */
  provisionAndPairImpl?: typeof provisionAndPair;
  /** Injectable for tests; defaults to the real `discoverSshTargets`. */
  discoverSshTargetsImpl?: typeof discoverSshTargets;
}

/**
 * Resolves a wizard-supplied host descriptor (SPEC §7.23 step 1: pick or
 * type a host) into a concrete `SshTargetConfig` this node's own `provision
 * ()`/`Ssh2Transport` machinery can connect with. `alias` matches an
 * autodetected `~/.ssh/config` entry (`host-candidates.ts`'s
 * `SshHostCandidate`) — its own `hostName`/`user`/`port`/first identity file
 * fill in anything the request didn't explicitly override; no alias (or no
 * match) falls back to a fully manual host, exactly like SPEC §7.23's "falls
 * back to manual entry when nothing is discoverable" — auth then relies on
 * `Ssh2Transport`'s own ssh-agent autodetection, never a password typed into
 * this wizard.
 */
export function resolveTargetConfig(
  targetId: string,
  host: ProvisionTargetRequest['host'],
  candidates: Awaited<ReturnType<typeof discoverSshTargets>>['candidates'],
): SshTargetConfig {
  const matched = host.alias ? candidates.find((c) => c.alias === host.alias) : undefined;
  return {
    id: targetId,
    label: host.label ?? matched?.alias ?? host.host,
    host: host.host || matched?.hostName || host.alias || '',
    user: host.user ?? matched?.user,
    port: host.port ?? matched?.port,
    privateKeyPath: matched?.identityFiles[0],
  };
}

/**
 * Subscribes `node` to its own `'provision_target_request'` event (emitted
 * by `NodeDaemon.handleInbound`) and drives the full zero-touch sequence:
 * resolves the host, runs `provisionAndPair`, and reports every step plus
 * the final outcome back over the relay. Returns an unsubscribe function.
 *
 * A request already in flight for the same `requestId` is ignored (a
 * duplicate/retried request never runs the sequence twice concurrently);
 * an error thrown by `provisionAndPair` itself (as opposed to a reported
 * failed step) is caught and reported as a `provision_target_result` with
 * `ok: false` rather than crashing this node.
 */
export function wireProvisionAndPair(
  node: NodeDaemon,
  options: WireProvisionAndPairOptions,
): () => void {
  const provisionAndPairImpl = options.provisionAndPairImpl ?? provisionAndPair;
  const discoverSshTargetsImpl = options.discoverSshTargetsImpl ?? discoverSshTargets;
  const inFlight = new Set<string>();

  const listener = (request: ProvisionTargetRequest): void => {
    if (inFlight.has(request.requestId)) return;
    inFlight.add(request.requestId);

    void (async () => {
      try {
        const { candidates } = await discoverSshTargetsImpl(options.discoverOptions);
        const target = resolveTargetConfig(request.targetId, request.host, candidates);

        const result = await provisionAndPairImpl(target, {
          relayUrl: options.relayUrl,
          accountId: options.accountId,
          actingAuthToken: options.authToken,
          amk: node.currentAmk,
          amkEpoch: node.currentAmkEpoch,
          actingIdentity: options.actingIdentity,
          claudeCodeOAuthToken: options.claudeCodeOAuthToken,
          supervisor: options.supervisor,
          onProgress: (progress: ProvisionAndPairProgress) => {
            node.sendProvisionProgress({
              requestId: request.requestId,
              nodeId: request.nodeId,
              targetId: request.targetId,
              step: progress.step,
              status: progress.status,
              message: progress.message,
            });
          },
        });

        node.sendProvisionResult({
          requestId: request.requestId,
          nodeId: request.nodeId,
          targetId: request.targetId,
          ok: result.ok,
          failedStep: result.failedStep,
          message: result.ok
            ? `"${request.targetId}" provisioned and paired`
            : `provisioning "${request.targetId}" failed at ${result.failedStep}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        node.sendProvisionResult({
          requestId: request.requestId,
          nodeId: request.nodeId,
          targetId: request.targetId,
          ok: false,
          message: `provisioning "${request.targetId}" failed: ${message}`,
        });
      } finally {
        inFlight.delete(request.requestId);
      }
    })();
  };

  node.on('provision_target_request', listener);
  return () => {
    node.off('provision_target_request', listener);
  };
}
