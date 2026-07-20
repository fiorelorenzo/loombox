// The node tests must never touch the ambient OS keyring: it is a global,
// shared, persistent system store, so it isolates poorly across parallel
// vitest workers and is present on a CI runner but absent on the headless
// devbox. Forcing the deterministic 0600-file fallback here (via keyring.ts's
// LOOMBOX_KEYRING_DISABLE_OS escape hatch) keeps identity/keyring/MCP-secret
// tests hermetic and identical everywhere. NodeKeyring's OS-backend-preference
// tests inject a fake backend directly, so they are unaffected by this.
process.env.LOOMBOX_KEYRING_DISABLE_OS = '1';
