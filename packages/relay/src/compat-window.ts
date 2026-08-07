import type { CompatibilityWindowV1 } from '@loombox/protocol';

export interface ReadCompatWindowOptions {
  /** Overrides `process.env`; only `LOOMBOX_MIN_NODE_VERSION`/`LOOMBOX_MIN_CLIENT_VERSION` are read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Reads this relay's declared compatibility window (issue #657) from its
 * environment — the operational-data counterpart to `build-identity.ts`'s
 * `readRelayBuildIdentity` right next to it, and the same
 * "an env var next to `DATABASE_URL`, not folklore" convention #655 already
 * set for `LOOMBOX_BUILD_COMMIT` (`deploy/relay/docker-compose.yml`).
 *
 * Both bounds are independently optional and both default to unset:
 * `LOOMBOX_MIN_NODE_VERSION`/`LOOMBOX_MIN_CLIENT_VERSION` absent (every
 * relay running today, since nothing sets them yet, and every existing
 * hermetic test) means this relay enforces no floor for that role — the
 * exact behavior before this issue, unchanged. Setting one is a deliberate
 * operator decision, made in `deploy/relay/.env`, not a value this function
 * ever invents a default for.
 */
export function readRelayCompatWindow(
  options: ReadCompatWindowOptions = {},
): CompatibilityWindowV1 {
  const env = options.env ?? process.env;
  const minNodeVersion = env.LOOMBOX_MIN_NODE_VERSION?.trim();
  const minClientVersion = env.LOOMBOX_MIN_CLIENT_VERSION?.trim();
  return {
    ...(minNodeVersion ? { minNodeVersion } : {}),
    ...(minClientVersion ? { minClientVersion } : {}),
  };
}
