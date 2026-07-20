# @loombox/node

The orchestrator node daemon (SPEC §5.1, §5.2, §5.6): connects outbound to the
relay, spawns/owns agent sessions via `@loombox/supervisor`, and E2E-encrypts
every session update before it leaves this host.

## Secrets at rest: OS-native keyring, with a documented fallback (issue #118)

SPEC §8/§16 asks for secrets at rest (this node's own identity keypair, SSH
keys, provider tokens, per-project secrets) to live behind OS-native secure
storage on a real desktop/laptop — macOS Keychain, libsecret/Secret Service on
Linux — via a headless-Node-safe binding (`@napi-rs/keyring`), "decide
fail-closed vs 0600-file fallback" for a box with no keyring session.

**Decision: fail-soft, not fail-closed.** `keyring.ts`'s `NodeKeyring` always
tries the OS-native backend first and, the moment a live probe against it
fails, falls back to a file-backed store rather than refusing to start. A
headless build/CI/devbox with no keyring session is a real, supported
deployment target for this daemon (it's how loombox's own CI and this
project's dev box run), not an error condition — fail-closed would make the
node simply unusable there. The fallback choice is never silent: `NodeKeyring`
logs it once via `console.warn` the first time it's touched.

**What the fallback actually stores, and how:**

- **This node's own identity keypair** (`identity.ts`'s `NodeIdentityStore`,
  issue #64) is the bootstrap root of trust: on the OS-native path it's stored
  as a real keyring secret; on the fallback path it's a single JSON file at
  `<stateDir>/identity.json`, written at **0600** (owner read/write only,
  mirroring the discipline SSH itself applies to `~/.ssh/id_rsa`) —
  **unencrypted** beyond that file permission. This is a deliberate, narrow
  exception: every other secret's fallback encryption key (below) derives
  from this keypair, so the keypair itself has nothing left to derive its own
  wrapping key from. `NodeIdentityStore`'s public API
  (`exists`/`load`/`create`/`loadOrCreate`) is unchanged by any of this — the
  OS-vs-fallback choice is entirely an internal storage-backend swap.
- **Everything else** (this issue's "SSH keys, provider tokens, and
  per-project secrets" — concretely, so far, `mcp-secrets.ts`'s per-project
  MCP secret values, issue #189) goes through `keyring.ts`'s
  `FileKeyringBackend` on the fallback path with an `encryptionKey` provider
  configured: each value is **AES-256-GCM-encrypted**, AAD-bound to its own
  `(service, account)` address (so one entry's ciphertext can never be
  swapped onto another's address undetected), under a key derived via
  self-ECDH (`@loombox/crypto`'s `deriveSharedSecretBits(privateKey,
publicKey)` called with this node's own identity keypair on both sides —
  deterministic, so the same key is derivable again on every reload without
  storing it anywhere separately) over the identity keypair above. This is
  the "permission-scoped encryption tied to the node's own keypair" SPEC §8
  calls for: even a bare copy of the fallback secrets file, without the
  identity file alongside it, decrypts to nothing.

**Verified, not just designed:** `keyring.test.ts`'s `createOsKeyringBackend`
test asserts the OS-native probe actually returns `undefined` on this
project's own dev box (headless Linux, no D-Bus Secret Service session and no
usable kernel keyring either — `@napi-rs/keyring` throws `KeyRevoked` the
instant it's touched), so the fallback path other tests exercise via an
injected `osKeyringBackendFactory` isn't a hypothetical.

See `keyring.ts`'s module doc comment for the concrete backend
implementations (`OsKeyringBackend`/`FileKeyringBackend`/`NodeKeyring`), and
`identity.ts` / `mcp-secrets.ts` for the two call sites above.
