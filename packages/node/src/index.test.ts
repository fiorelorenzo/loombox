import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@loombox/node', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@loombox/node');
  });
});
