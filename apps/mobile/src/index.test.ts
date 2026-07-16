import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@loombox/mobile', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@loombox/mobile');
  });
});
