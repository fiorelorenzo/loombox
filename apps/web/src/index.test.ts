import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@loombox/web', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@loombox/web');
  });
});
