import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_TAGLINE } from './constants';

describe('app constants', () => {
  it('names the app loombox', () => {
    expect(APP_NAME).toBe('loombox');
  });

  it('has a non-empty tagline', () => {
    expect(APP_TAGLINE.length).toBeGreaterThan(0);
  });
});
