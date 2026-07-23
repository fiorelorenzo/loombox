import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const DEVICE_TOKEN_FILE_NAME = 'device-token.json';

interface PersistedDeviceTokenFileV1 {
  v: 1;
  accessToken: string;
}

export interface DeviceTokenFileStoreOptions {
  /** Injectable for tests; defaults to `defaultNodeStateDir()` (this package's existing `~/.loombox/node` convention, same as `NodeIdentityStore`/`SshTargetStore`). */
  stateDir?: string;
}

/**
 * Persists this node's relay-native device token (issue #387's
 * device-authorization grant) across restarts, so a node that has already
 * completed the operator-approval flow once never repeats it. A plain JSON
 * file at **0600** — owner read/write only — mirroring `identity.ts`'s
 * `NodeIdentityStore` file-fallback discipline (the closest real analog:
 * SSH's own `~/.ssh/id_rsa` permission convention). Deliberately simpler
 * than `NodeIdentityStore` (no OS-keyring attempt): a device token is a
 * long-lived-but-revocable relay-issued bearer, not this node's own
 * cryptographic identity — losing it just means running the device-login
 * flow again, not losing access to anything already encrypted.
 */
export class DeviceTokenFileStore {
  private readonly stateDir: string;
  private readonly filePath: string;

  constructor(options: DeviceTokenFileStoreOptions = {}) {
    this.stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(this.stateDir, DEVICE_TOKEN_FILE_NAME);
  }

  /** Returns the persisted access token, or `undefined` if none is stored yet (or the file is missing/corrupt — treated as "no token yet" rather than crashing). */
  load(): string | undefined {
    if (!existsSync(this.filePath)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedDeviceTokenFileV1 | null;
      if (parsed === null || typeof parsed !== 'object') return undefined;
      return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0
        ? parsed.accessToken
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persists `accessToken`, overwriting anything already stored, at 0600. */
  save(accessToken: string): void {
    const file: PersistedDeviceTokenFileV1 = { v: 1, accessToken };
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file), { mode: 0o600 });
    // Same belt-and-suspenders re-chmod `identity.ts`'s `persist` does:
    // `writeFileSync`'s `mode` only applies on a fresh create and is still
    // subject to umask, so an overwrite could otherwise end up looser than
    // 0600.
    chmodSync(this.filePath, 0o600);
  }
}
