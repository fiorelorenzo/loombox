import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a subsequence, not just a substring', () => {
    expect(fuzzyMatch('sn', 'session').matched).toBe(true);
    expect(fuzzyMatch('son', 'session').matched).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('SESN', 'my session').matched).toBe(true);
  });

  it('does not match when the query characters are out of order', () => {
    expect(fuzzyMatch('nos', 'session').matched).toBe(false);
  });

  it('does not match when a query character is entirely absent', () => {
    expect(fuzzyMatch('sessionz', 'session').matched).toBe(false);
  });

  it('an empty query matches everything with a zero score', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ matched: true, score: 0 });
  });

  it('scores a contiguous/prefix match higher than a scattered one', () => {
    const contiguous = fuzzyMatch('ses', 'session one');
    const scattered = fuzzyMatch('sno', 'session one');
    expect(contiguous.matched).toBe(true);
    expect(scattered.matched).toBe(true);
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });
});

describe('fuzzyFilter', () => {
  const items = ['loombox web app', 'relay deploy fix', 'session cleanup', 'sencare api'];

  it('filters to only matching items', () => {
    expect(fuzzyFilter(items, 'relay', (s) => s)).toEqual(['relay deploy fix']);
  });

  it('sorts best match first', () => {
    const results = fuzzyFilter(items, 'se', (s) => s);
    expect(results[0]).toBe('session cleanup');
  });

  it('an empty/whitespace query returns every item, unfiltered, in original order', () => {
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(items);
    expect(fuzzyFilter(items, '   ', (s) => s)).toEqual(items);
  });

  it('returns nothing when nothing matches', () => {
    expect(fuzzyFilter(items, 'zzzqqq', (s) => s)).toEqual([]);
  });
});
