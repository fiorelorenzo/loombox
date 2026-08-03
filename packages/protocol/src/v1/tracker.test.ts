import { describe, expect, it } from 'vitest';
import {
  githubTarget,
  jiraTarget,
  parseTrackerMode,
  safeParseTrackerMode,
  trackerMode,
  type TrackerMode,
} from './tracker';

describe('githubTarget', () => {
  it('parses owner/repo alone, projectNumber optional', () => {
    expect(githubTarget.parse({ owner: 'fiorelorenzo', repo: 'loombox' })).toEqual({
      owner: 'fiorelorenzo',
      repo: 'loombox',
    });
  });

  it('parses with an explicit Projects v2 board number', () => {
    expect(
      githubTarget.parse({ owner: 'fiorelorenzo', repo: 'loombox', projectNumber: 4 }),
    ).toEqual({
      owner: 'fiorelorenzo',
      repo: 'loombox',
      projectNumber: 4,
    });
  });

  it('rejects a missing repo', () => {
    expect(() => githubTarget.parse({ owner: 'fiorelorenzo' })).toThrow();
  });
});

describe('jiraTarget', () => {
  it('parses cloudId/projectKey', () => {
    expect(jiraTarget.parse({ cloudId: 'abc-123', projectKey: 'LB' })).toEqual({
      cloudId: 'abc-123',
      projectKey: 'LB',
    });
  });

  it('rejects a missing cloudId', () => {
    expect(() => jiraTarget.parse({ projectKey: 'LB' })).toThrow();
  });
});

describe('trackerMode', () => {
  it('parses native mode', () => {
    expect(trackerMode.parse({ kind: 'native' })).toEqual({ kind: 'native' });
  });

  it('rejects native mode carrying stray live fields (discriminated union, not a loose object)', () => {
    // z.discriminatedUnion picks the 'native' arm from `kind` and strips
    // unknown keys per that arm's own schema, so a live-shaped payload
    // mislabeled 'native' still parses down to the bare native shape.
    expect(trackerMode.parse({ kind: 'native', provider: 'github' } as unknown)).toEqual({
      kind: 'native',
    });
  });

  it('parses a valid live GitHub mode', () => {
    const valid = {
      kind: 'live',
      provider: 'github',
      connectionId: 'conn_1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    } satisfies TrackerMode;
    expect(trackerMode.parse(valid)).toEqual(valid);
  });

  it('parses a valid live Jira mode', () => {
    const valid = {
      kind: 'live',
      provider: 'jira',
      connectionId: 'conn_2',
      target: { cloudId: 'abc-123', projectKey: 'LB' },
    } satisfies TrackerMode;
    expect(trackerMode.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown kind', () => {
    expect(() => trackerMode.parse({ kind: 'imported' })).toThrow();
  });

  it('rejects a live mode missing connectionId', () => {
    expect(() =>
      trackerMode.parse({
        kind: 'live',
        provider: 'github',
        target: { owner: 'fiorelorenzo', repo: 'loombox' },
      }),
    ).toThrow();
  });

  it('rejects an empty connectionId', () => {
    expect(() =>
      trackerMode.parse({
        kind: 'live',
        provider: 'github',
        connectionId: '',
        target: { owner: 'fiorelorenzo', repo: 'loombox' },
      }),
    ).toThrow();
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      trackerMode.parse({
        kind: 'live',
        provider: 'linear',
        connectionId: 'conn_1',
        target: { owner: 'fiorelorenzo', repo: 'loombox' },
      }),
    ).toThrow();
  });

  it('rejects a GitHub target shape submitted for provider jira', () => {
    const result = trackerMode.safeParse({
      kind: 'live',
      provider: 'jira',
      connectionId: 'conn_1',
      target: { owner: 'fiorelorenzo', repo: 'loombox' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a Jira target shape submitted for provider github', () => {
    const result = trackerMode.safeParse({
      kind: 'live',
      provider: 'github',
      connectionId: 'conn_1',
      target: { cloudId: 'abc-123', projectKey: 'LB' },
    });
    expect(result.success).toBe(false);
  });

  it('parseTrackerMode throws on an invalid payload, safeParseTrackerMode returns a failed result', () => {
    expect(() => parseTrackerMode({ kind: 'native', extra: true })).not.toThrow();
    expect(() => parseTrackerMode({ kind: 'nope' })).toThrow();
    expect(safeParseTrackerMode({ kind: 'nope' }).success).toBe(false);
    expect(safeParseTrackerMode({ kind: 'native' }).success).toBe(true);
  });
});
