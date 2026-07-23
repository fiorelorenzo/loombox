import { readFileSync } from 'node:fs';

import type { TargetDescriptor } from '@loombox/protocol';

import type { SshTargetConfig } from './target';

/** Raised for any config problem (missing required field, malformed file, an invalid AMK, ...) so `main.ts` can log a clear message and exit non-zero rather than let a cryptic downstream error surface first. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`loombox node config: ${message}`);
    this.name = 'ConfigError';
  }
}

/**
 * The fully-resolved config a running node needs (issue #63). Loaded from
 * environment variables and/or an optional JSON config file — see
 * {@link loadNodeConfig}'s doc comment for precedence and the exact
 * env var names.
 */
export interface NodeCliConfig {
  /** The relay's ws:// (or wss://) URL to connect to. */
  relayUrl: string;
  /** This node's stable identity (`NodeDaemonOptions.nodeId`). */
  nodeId: string;
  /** This device's stable id sent in the `initialize` handshake; defaults to `nodeId` (a CLI-run node is a single device). */
  deviceId: string;
  /**
   * Opaque bearer token used as this node's WS `authToken` — a Better Auth
   * session bearer (`LOOMBOX_AUTH_TOKEN`, the legacy/advanced path) or a
   * relay-native device token obtained via the device-authorization grant
   * (issue #387). `undefined` when neither `LOOMBOX_AUTH_TOKEN` nor
   * `LOOMBOX_DEVICE_TOKEN` is set — the caller (`main.ts`'s `start()`) then
   * either reuses a previously-persisted device token or runs the
   * device-login flow to obtain and persist a fresh one, exactly like
   * `recoveryCode` below drives the AMK bootstrap. `LOOMBOX_AUTH_TOKEN`
   * always wins over `LOOMBOX_DEVICE_TOKEN` when both are set, mirroring
   * `amk`'s precedence over `recoveryCode`.
   */
  authToken?: string;
  /**
   * A relay-native device token (`LOOMBOX_DEVICE_TOKEN`/the config file's
   * `deviceToken`, issue #387) supplied directly — e.g. copied from another
   * node, or provisioned out of band — skipping the interactive device-login
   * flow entirely. `undefined` when `authToken` is set instead (`authToken`
   * wins — see its own doc comment) or when neither is configured.
   */
  deviceToken?: string;
  /**
   * The account this node's sessions are scoped under
   * (`NodeDaemonOptions.accountId`). `undefined` when not explicitly set via
   * `LOOMBOX_ACCOUNT_ID`/the config file's `accountId` — this function
   * deliberately no longer defaults it to `authToken` (issue #380: that
   * stale stand-in from before Better Auth landed made a real node's
   * sessions get silently dropped by a live relay, which resolves the
   * *real* accountId from the bearer token itself and only accepts sessions
   * whose claimed accountId matches). The caller (`main.ts`'s `start()`)
   * is responsible for resolving the real accountId from `authToken` (the
   * same Better Auth `getSession` resolution the relay and the web client
   * use) whenever this is left unset.
   */
  accountId?: string;
  /**
   * This account's 256-bit Account Master Key, decoded from base64 — an
   * explicit raw-AMK override (`LOOMBOX_AMK`/the config file's `amk`).
   * `undefined` when not set, which is the intended path (issue #386): the
   * caller (`main.ts`'s `start()`) then obtains the AMK from `recoveryCode`
   * below via the recovery-code bootstrap instead. Exactly one of `amk` /
   * `recoveryCode` is guaranteed set by {@link loadNodeConfig} — never both
   * unset, and when both ARE set, `amk` wins (the override, meant for
   * tests/advanced use, always takes precedence over bootstrapping).
   */
  amk?: Uint8Array;
  /**
   * Path to a one-shot wrapped-AMK handoff file (`LOOMBOX_WRAPPED_AMK_FILE`/
   * the config file's `wrappedAmkFilePath`, issue #399): the non-interactive
   * SSH-provisioning AMK handoff. A provisioner that already holds the
   * unlocked AMK wraps it for this node's freshly-generated device pubkey
   * (`packages/node/src/ssh/amk-handoff-provision.ts`) and writes it here
   * over the already-open, already-encrypted SSH channel; on first start,
   * `main.ts`'s `start()` reads it, unwraps it with this node's own device
   * private key (`amk-handoff-file.ts`), adopts the AMK, and deletes the
   * file — consumed exactly once. `undefined` when `amk` is set directly
   * instead (that always wins — see `amk`'s doc comment).
   */
  wrappedAmkFilePath?: string;
  /**
   * The account's Recovery Code (`LOOMBOX_RECOVERY_CODE`/the config file's
   * `recoveryCode`), driving the recovery-code AMK bootstrap (SPEC §8 path 2,
   * issue #386): `main.ts`'s `start()` uses this to fetch this account's
   * escrowed wrapped-AMK blob from the relay and unwrap it locally, the same
   * crypto path `apps/web`'s `bootstrapAmkFromRecoveryCode` drives. This is
   * the fallback way a resident node obtains its AMK when it wasn't handed
   * off during provisioning — `amk` is a raw escape hatch, `wrappedAmkFilePath`
   * is the zero-touch SSH-provisioning path (issue #399), and this is what's
   * left when neither applies. `undefined` when `amk` or `wrappedAmkFilePath`
   * is set instead.
   */
  recoveryCode?: string;
  /** Execution targets this node exposes, beyond the always-available `local` one; `undefined` lets `NodeDaemon` fall back to its own `[DEFAULT_LOCAL_TARGET]` default. */
  targets?: TargetDescriptor[];
  /** Connection recipes for this node's `ssh:` targets, file-only (see {@link loadNodeConfig}). */
  sshTargets?: SshTargetConfig[];
  /** Overrides where this node's persisted identity keypair (`identity.ts`'s `NodeIdentityStore`) and other on-disk state lives; `undefined` uses that store's own default (`~/.loombox/node`). */
  stateDir?: string;
}

/** The JSON shape a config file may provide (all fields optional — env vars can fill in the rest, or override a value the file also sets). Field names match {@link NodeCliConfig} exactly, except `amk`, which is base64 text here (decoded by {@link loadNodeConfig}). */
interface NodeConfigFile {
  relayUrl?: string;
  nodeId?: string;
  deviceId?: string;
  authToken?: string;
  /** See {@link NodeCliConfig.deviceToken}. */
  deviceToken?: string;
  /** See {@link NodeCliConfig.accountId} — an explicit override; when absent the caller must resolve it from `authToken` instead. */
  accountId?: string;
  amk?: string;
  /** See {@link NodeCliConfig.wrappedAmkFilePath}. */
  wrappedAmkFilePath?: string;
  /** See {@link NodeCliConfig.recoveryCode}. */
  recoveryCode?: string;
  targets?: TargetDescriptor[];
  sshTargets?: SshTargetConfig[];
  stateDir?: string;
}

const AMK_BYTES = 32;

function readConfigFile(filePath: string): NodeConfigFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`could not read config file "${filePath}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`config file "${filePath}" is not valid JSON: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config file "${filePath}" must contain a JSON object`);
  }
  return parsed as NodeConfigFile;
}

/** `--config <path>` (or `--config=<path>`), the CLI-argument way to point at a config file; `LOOMBOX_NODE_CONFIG` (below) is the env-var equivalent. */
function parseConfigPathArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') return argv[i + 1];
    if (arg?.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return undefined;
}

function decodeAmk(base64: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new ConfigError('amk (LOOMBOX_AMK) is not valid base64');
  }
  // Buffer.from(..., 'base64') never throws on malformed input (it just
  // drops invalid characters), so the only reliable validation is the
  // decoded length: a 256-bit AMK (SPEC §8, @loombox/crypto's AMK_BYTES)
  // must decode to exactly 32 bytes.
  if (bytes.length !== AMK_BYTES) {
    throw new ConfigError(
      `amk (LOOMBOX_AMK) must decode to ${AMK_BYTES} bytes (a 256-bit key); got ${bytes.length}`,
    );
  }
  return new Uint8Array(bytes);
}

function parseTargetsEnv(json: string): TargetDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`targets (LOOMBOX_TARGETS) is not valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError('targets (LOOMBOX_TARGETS) must be a JSON array');
  }
  return parsed as TargetDescriptor[];
}

export interface LoadNodeConfigOptions {
  /** Defaults to `process.env`; tests inject a plain object instead. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.argv.slice(2)`; tests inject their own argv. */
  argv?: string[];
}

/**
 * Loads this node's config from environment variables and, optionally, a
 * JSON config file (issue #63's "loads config from file/env"). Precedence:
 * an env var always wins over the same field in the config file, so a
 * self-hoster can commit a base config file and override single fields
 * (e.g. the auth token) per environment without editing it.
 *
 * The config file's path comes from `--config <path>` / `--config=<path>`
 * (see {@link parseConfigPathArg}) or, equivalently, `LOOMBOX_NODE_CONFIG`;
 * neither is required — a purely env-driven node needs no file at all.
 *
 * Env vars (all `LOOMBOX_`-prefixed):
 * - `LOOMBOX_RELAY_URL` (required)
 * - `LOOMBOX_NODE_ID` (required)
 * - `LOOMBOX_DEVICE_ID` (optional, defaults to `nodeId`)
 * - `LOOMBOX_AUTH_TOKEN` (optional; a Better Auth session bearer, the
 *   legacy/advanced path) / `LOOMBOX_DEVICE_TOKEN` (optional; a relay-native
 *   device token supplied directly, issue #387). Neither is required here:
 *   left both unset, `main.ts`'s `start()` reuses a previously-persisted
 *   device token or runs the device-login flow to obtain one. `authToken`
 *   wins if both are set — see {@link NodeCliConfig.authToken}'s doc comment.
 * - `LOOMBOX_ACCOUNT_ID` (optional; explicit override. Left unset, the
 *   returned config's `accountId` is `undefined` and the caller must resolve
 *   the real one from `authToken` — issue #380, see {@link NodeCliConfig.accountId})
 * - `LOOMBOX_AMK` (base64, must decode to 32 bytes) / `LOOMBOX_WRAPPED_AMK_FILE`
 *   / `LOOMBOX_RECOVERY_CODE` — at least one of these three is required
 *   (issues #386, #399). `LOOMBOX_WRAPPED_AMK_FILE` (a path) is the zero-touch
 *   SSH-provisioning handoff (issue #399): `main.ts`'s `start()` reads,
 *   unwraps, adopts, and deletes it. `LOOMBOX_RECOVERY_CODE` is the
 *   Recovery-Code bootstrap fallback (issue #386): `start()` uses it to
 *   fetch this account's escrowed wrapped-AMK blob from the relay, the same
 *   crypto `apps/web` drives. `LOOMBOX_AMK` is a raw override for
 *   tests/advanced use. Precedence when more than one is set: `LOOMBOX_AMK`
 *   wins outright, then `LOOMBOX_WRAPPED_AMK_FILE`, then
 *   `LOOMBOX_RECOVERY_CODE` — see {@link NodeCliConfig.amk}'s doc comment.
 * - `LOOMBOX_TARGETS` (optional; a JSON array of `TargetDescriptor`)
 * - `LOOMBOX_NODE_STATE_DIR` (optional; overrides where node state — the
 *   persisted identity keypair — lives on disk)
 * - `LOOMBOX_NODE_CONFIG` (optional; path to a JSON config file, same as
 *   `--config`)
 *
 * `sshTargets` (each `ssh:` target's connection recipe) is deliberately
 * file-only: it's structured enough (host/user/port/key path/...) that
 * cramming it into one env var would be unreadable, and it holds
 * credentials better kept in a 0600 file than a process's env (visible via
 * `/proc/<pid>/environ` to anyone who can already read that file, but env
 * vars are more commonly leaked into logs/process listings by accident).
 *
 * Throws {@link ConfigError} for any missing required field, unreadable or
 * malformed config file, or malformed `LOOMBOX_AMK`/`LOOMBOX_TARGETS` —
 * never returns a partially-valid config.
 */
export function loadNodeConfig(options: LoadNodeConfigOptions = {}): NodeCliConfig {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);

  const configPath = parseConfigPathArg(argv) ?? env.LOOMBOX_NODE_CONFIG;
  const file = configPath ? readConfigFile(configPath) : {};

  const relayUrl = env.LOOMBOX_RELAY_URL ?? file.relayUrl;
  const nodeId = env.LOOMBOX_NODE_ID ?? file.nodeId;
  // #387: neither is required at this layer — see NodeCliConfig.authToken's
  // doc comment for why (main.ts's start() resolves a concrete bearer, via
  // the device-login flow if genuinely neither is configured).
  const authToken = env.LOOMBOX_AUTH_TOKEN ?? file.authToken;
  const deviceToken = env.LOOMBOX_DEVICE_TOKEN ?? file.deviceToken;
  const amkText = env.LOOMBOX_AMK ?? file.amk;
  const wrappedAmkFilePathRaw = env.LOOMBOX_WRAPPED_AMK_FILE ?? file.wrappedAmkFilePath;
  const recoveryCode = env.LOOMBOX_RECOVERY_CODE ?? file.recoveryCode;

  const missing: string[] = [];
  if (!relayUrl) missing.push('relayUrl (LOOMBOX_RELAY_URL)');
  if (!nodeId) missing.push('nodeId (LOOMBOX_NODE_ID)');
  // #386/#399: at least one of amk / wrappedAmkFilePath / recoveryCode is
  // required — recoveryCode is the fallback bootstrap path, wrappedAmkFilePath
  // the zero-touch SSH-provisioning handoff, amk a raw override. Only missing
  // when NONE of the three is set; see NodeCliConfig.amk's doc comment for
  // the precedence when more than one is.
  if (!amkText && !wrappedAmkFilePathRaw && !recoveryCode) {
    missing.push(
      'amk (LOOMBOX_AMK), wrappedAmkFilePath (LOOMBOX_WRAPPED_AMK_FILE), or recoveryCode (LOOMBOX_RECOVERY_CODE)',
    );
  }
  if (missing.length > 0) {
    throw new ConfigError(`missing required config: ${missing.join(', ')}`);
  }

  const accountId = env.LOOMBOX_ACCOUNT_ID ?? file.accountId;
  const deviceId = env.LOOMBOX_DEVICE_ID ?? file.deviceId ?? nodeId!;
  const amk = amkText ? decodeAmk(amkText) : undefined;
  // #399: wrappedAmkFilePath only applies when amk isn't set (amk wins
  // outright); recoveryCode only applies when neither amk nor
  // wrappedAmkFilePath is set — see NodeCliConfig.amk's doc comment.
  const wrappedAmkFilePath = amk ? undefined : wrappedAmkFilePathRaw;
  const targets = env.LOOMBOX_TARGETS ? parseTargetsEnv(env.LOOMBOX_TARGETS) : file.targets;
  const stateDir = env.LOOMBOX_NODE_STATE_DIR ?? file.stateDir;

  return {
    relayUrl: relayUrl!,
    nodeId: nodeId!,
    deviceId,
    authToken,
    // #387: authToken wins if both are set, mirroring amk's precedence over
    // recoveryCode above.
    deviceToken: authToken ? undefined : deviceToken,
    accountId,
    amk,
    wrappedAmkFilePath,
    recoveryCode: amk || wrappedAmkFilePath ? undefined : recoveryCode,
    targets,
    sshTargets: file.sshTargets,
    stateDir,
  };
}
