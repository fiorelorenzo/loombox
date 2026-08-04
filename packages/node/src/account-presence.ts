/* ---------------------------------------------------------------------
 * SPEC §7.26's "Node-locality" gap, computed the way that section
 * prescribes — "lazily, at the point of use", never as a synced map
 * (issue #228; explicitly out of `@loombox/protocol`'s `ConnectedAccount`
 * type and out of `account-pin.ts`'s resolvers, both of which say so in
 * their own doc comments).
 *
 * **What this answers.** Connecting a GitHub/Jira account on one node
 * writes its credential into that node's own OS keyring
 * (`connected-account-keyring.ts`'s shared binding); a second node, or a
 * second device rendering the same synced `ConnectedAccount` metadata row,
 * has no copy. `NodeAccountPresence.isPresent(account)` answers "does THIS
 * node's keyring currently hold `account`'s credential" — nothing else. It
 * is not a remote/cross-node query (SPEC §7.26 frames the multi-node "ask
 * that node" flow as reusing §7.21's node-health reachability channel; the
 * wire/UI plumbing that would carry this local answer to a client
 * targeting a *different* node is a separate concern, not implemented
 * here).
 *
 * **Never leaks the credential.** `isPresent` returns a `boolean`,
 * derived from whether `KeyringBackend.get` resolved to a defined value —
 * the value itself is discarded, never returned, logged, or attached to
 * any object this class produces (`account-presence.test.ts` asserts
 * this directly: a keyring stubbed to hold a real-looking token still
 * yields nothing but `true`/`false`).
 *
 * **Caching and invalidation.** One in-memory `Promise<boolean>` per
 * `secretRef`, populated on first `isPresent` call for that account
 * (never eagerly — constructing this class does no I/O, and neither does
 * probing an account nobody has asked about) and reused for every
 * subsequent call. Exactly three things invalidate an entry:
 *
 *   1. `invalidate(secretRef)` — call this after a LOCAL keyring mutation
 *      for that `secretRef`. `GithubConnectService`/`JiraConnectService`
 *      both take an `onCredentialChanged` hook (their own doc comments)
 *      that a caller wires straight to this method, so a connect or
 *      disconnect run on this node is never followed by a stale answer —
 *      `onConnectOrDisconnect` below is that binding, ready to pass as
 *      that hook.
 *   2. `invalidateAll()` — clears every cached entry (tests; a caller
 *      that doesn't track individual `secretRef`s).
 *   3. A failed probe is never cached as a value — if the keyring itself
 *      throws (a corrupt file, an OS-keyring session that dropped
 *      mid-process), the rejection propagates to that caller and the next
 *      `isPresent` call retries from scratch, rather than remembering the
 *      failure as a permanent "absent".
 *
 * A stale-`false` window is otherwise impossible by construction: nothing
 * outside `invalidate`/`invalidateAll` ever removes or overwrites a cache
 * entry, and every write path in this package that changes local keyring
 * state is required to call one of them.
 * --------------------------------------------------------------------- */

import type { ConnectedAccount } from '@loombox/protocol';

import {
  CONNECTED_ACCOUNT_KEYRING_SERVICE,
  createConnectedAccountKeyring,
  type ConnectedAccountKeyringOptions,
} from './connected-account-keyring';
import type { KeyringBackend } from './keyring';

export type NodeAccountPresenceOptions = ConnectedAccountKeyringOptions;

/**
 * This node's lazy, cached answer to "do I hold `account`'s credential
 * right now" (SPEC §7.26, issue #228). See this module's top comment for
 * the full caching/invalidation contract.
 */
export class NodeAccountPresence {
  private readonly keyring: KeyringBackend;
  private readonly cache = new Map<string, Promise<boolean>>();

  constructor(options: NodeAccountPresenceOptions = {}) {
    this.keyring = createConnectedAccountKeyring(options);
  }

  /**
   * `true` iff this node's keyring currently holds a credential for
   * `account.secretRef`. Lazy (only probes the keyring the first time a
   * given `secretRef` is asked about) and cached thereafter until
   * {@link invalidate}/{@link invalidateAll} runs. Never returns, logs, or
   * otherwise exposes the credential value itself.
   */
  isPresent(account: Pick<ConnectedAccount, 'secretRef'>): Promise<boolean> {
    const cached = this.cache.get(account.secretRef);
    if (cached) return cached;
    const probe = this.probe(account.secretRef);
    this.cache.set(account.secretRef, probe);
    return probe;
  }

  /** Forgets `secretRef`'s cached answer — call after a local connect or disconnect changes what this node's keyring holds for it. The next {@link isPresent} call for that account re-probes the keyring. */
  invalidate(secretRef: string): void {
    this.cache.delete(secretRef);
  }

  /** Forgets every cached answer. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Ready to pass as `GithubConnectServiceOptions`/`JiraConnectServiceOptions`'s
   * `onCredentialChanged` hook — `new GithubConnectService({
   * onCredentialChanged: presence.onConnectOrDisconnect })` keeps a
   * connect/disconnect on this node from leaving a stale cached answer,
   * without either connect service needing to import this class.
   */
  readonly onConnectOrDisconnect = (secretRef: string): void => {
    this.invalidate(secretRef);
  };

  private async probe(secretRef: string): Promise<boolean> {
    try {
      return (await this.keyring.get(CONNECTED_ACCOUNT_KEYRING_SERVICE, secretRef)) !== undefined;
    } catch (error) {
      // A transient keyring failure is never remembered as "absent" — drop
      // the cache entry so the next call retries instead of parroting a
      // wrong answer for this class instance's lifetime.
      this.cache.delete(secretRef);
      throw error;
    }
  }
}
