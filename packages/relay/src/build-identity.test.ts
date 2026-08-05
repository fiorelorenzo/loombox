import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRelayBuildIdentity } from './build-identity';

function hasNonEmptyStringVersion(value: unknown): value is { version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    value.version.length > 0
  );
}

function ownVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  if (!hasNonEmptyStringVersion(parsed)) {
    throw new Error('test fixture: package.json has no valid "version" field');
  }
  return parsed.version;
}
const OWN_VERSION = ownVersion();

describe('readRelayBuildIdentity', () => {
  it("reads this package.json's own version", async () => {
    const identity = await readRelayBuildIdentity({
      env: {},
      gitRevParse: () => Promise.reject(new Error('no git here')),
    });
    // Compared against the real package.json rather than hardcoded, so a
    // real version bump never makes this test lie.
    expect(identity.version).toBe(OWN_VERSION);
  });

  it('prefers LOOMBOX_BUILD_COMMIT over git — the production/Docker path, where .git genuinely is not present', async () => {
    const gitRevParse = () => Promise.reject(new Error('should never be called'));
    const identity = await readRelayBuildIdentity({
      env: { LOOMBOX_BUILD_COMMIT: 'deadbeef' },
      gitRevParse,
    });
    expect(identity.commit).toBe('deadbeef');
  });

  it('trims whitespace off LOOMBOX_BUILD_COMMIT', async () => {
    const identity = await readRelayBuildIdentity({
      env: { LOOMBOX_BUILD_COMMIT: '  deadbeef\n' },
    });
    expect(identity.commit).toBe('deadbeef');
  });

  it('falls back to git rev-parse when LOOMBOX_BUILD_COMMIT is unset — the scripts/dev.sh path, a real git checkout', async () => {
    const identity = await readRelayBuildIdentity({
      env: {},
      gitRevParse: () => Promise.resolve('cafef00d'),
    });
    expect(identity.commit).toBe('cafef00d');
  });

  it('degrades to version-only when neither the env override nor git is available — honest, never invented', async () => {
    const identity = await readRelayBuildIdentity({
      env: {},
      gitRevParse: () => Promise.reject(new Error('fatal: not a git repository')),
    });
    expect(identity.commit).toBeUndefined();
    expect(identity.version.length).toBeGreaterThan(0);
  });

  it('ignores an empty LOOMBOX_BUILD_COMMIT and falls through to git', async () => {
    const identity = await readRelayBuildIdentity({
      env: { LOOMBOX_BUILD_COMMIT: '' },
      gitRevParse: () => Promise.resolve('cafef00d'),
    });
    expect(identity.commit).toBe('cafef00d');
  });
});
