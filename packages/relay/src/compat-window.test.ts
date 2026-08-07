import { describe, expect, it } from 'vitest';

import { readRelayCompatWindow } from './compat-window';

describe('readRelayCompatWindow', () => {
  it('returns an empty window when neither env var is set — every relay running today, nothing enforced', () => {
    expect(readRelayCompatWindow({ env: {} })).toEqual({});
  });

  it('reads LOOMBOX_MIN_NODE_VERSION alone', () => {
    expect(readRelayCompatWindow({ env: { LOOMBOX_MIN_NODE_VERSION: '0.5.0' } })).toEqual({
      minNodeVersion: '0.5.0',
    });
  });

  it('reads LOOMBOX_MIN_CLIENT_VERSION alone', () => {
    expect(readRelayCompatWindow({ env: { LOOMBOX_MIN_CLIENT_VERSION: '0.4.0' } })).toEqual({
      minClientVersion: '0.4.0',
    });
  });

  it('reads both together', () => {
    expect(
      readRelayCompatWindow({
        env: { LOOMBOX_MIN_NODE_VERSION: '0.5.0', LOOMBOX_MIN_CLIENT_VERSION: '0.4.0' },
      }),
    ).toEqual({ minNodeVersion: '0.5.0', minClientVersion: '0.4.0' });
  });

  it('trims whitespace off either value', () => {
    expect(readRelayCompatWindow({ env: { LOOMBOX_MIN_NODE_VERSION: '  0.5.0\n' } })).toEqual({
      minNodeVersion: '0.5.0',
    });
  });

  it('treats an empty string the same as unset, not as a literal empty floor', () => {
    expect(readRelayCompatWindow({ env: { LOOMBOX_MIN_NODE_VERSION: '' } })).toEqual({});
  });

  it('defaults to process.env when no env is injected', () => {
    // Doesn't assert a specific value (this process's real env is
    // unconstrained) — only that it doesn't throw and returns the shape.
    expect(readRelayCompatWindow()).toEqual(expect.any(Object));
  });
});
