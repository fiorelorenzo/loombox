/**
 * The "control channel" a session's agent-supervisor uses to resolve an
 * attachment ref into decrypted plaintext bytes (SPEC §7.25 "Deliver to the
 * executing host"; issue #156). The agent-supervisor itself never talks to
 * the relay and never holds any E2E key material (the session key comes
 * from the account's Account Master Key, which only the node process
 * holds, SPEC §8) — it always asks whatever owns that, through this one
 * injected interface, rather than opening its own direct connection to the
 * relay's blob endpoint. In this v1 codebase the agent-supervisor and the
 * node are co-located in the same process for both a `local` and an `ssh:`
 * target (only the agent's own child process is remote for `ssh:` — see
 * `AgentSession`'s class doc comment), so the concrete implementation
 * `@loombox/node`'s `NodeDaemon` hands in here is, today, a same-process
 * method call; the shape stays a proper injected interface (rather than a
 * direct import of anything relay/crypto-shaped into this package) so a
 * test can fake it with no relay or crypto involved at all, and so a
 * genuinely separate remote supervisor process (a real future option, noted
 * in SPEC §7.25) could implement it over an actual wire later without this
 * interface changing.
 */
export interface AttachmentChannel {
  /**
   * Resolves one attachment blob's ref into its decrypted plaintext bytes.
   * Rejects if the blob can't be fetched (e.g. the relay has nothing under
   * that ref) or fails to decrypt (wrong/expired session key, or a ciphertext
   * relabeled onto the wrong session/ref — the AAD swap/spoof check, SPEC §8).
   */
  resolveAttachment(sessionId: string, ref: string): Promise<Uint8Array>;
}
