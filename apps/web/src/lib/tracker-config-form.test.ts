import { describe, expect, it } from 'vitest';
import {
  buildTrackerMode,
  describeTrackerMode,
  emptyLiveTrackerDraft,
  liveTrackerDraftFrom,
  type LiveTrackerDraft,
} from './tracker-config-form';

describe('buildTrackerMode (issue #220)', () => {
  it('native always succeeds, regardless of whatever the live draft happens to hold', () => {
    const result = buildTrackerMode('native', emptyLiveTrackerDraft());
    expect(result.error).toBeUndefined();
    expect(result.mode).toEqual({ kind: 'native' });
  });

  it('live/github succeeds with owner+repo and no project number', () => {
    const draft: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('github'),
      connectionId: 'github:github.com:123',
      owner: 'loombox',
      repo: 'loombox',
    };
    const result = buildTrackerMode('live', draft);
    expect(result.error).toBeUndefined();
    expect(result.mode).toEqual({
      kind: 'live',
      provider: 'github',
      connectionId: 'github:github.com:123',
      target: { owner: 'loombox', repo: 'loombox' },
    });
  });

  it('live/github carries an optional projectNumber through when set', () => {
    const draft: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('github'),
      connectionId: 'github:github.com:123',
      owner: 'loombox',
      repo: 'loombox',
      projectNumber: '4',
    };
    const result = buildTrackerMode('live', draft);
    expect(result.error).toBeUndefined();
    expect(result.mode).toEqual({
      kind: 'live',
      provider: 'github',
      connectionId: 'github:github.com:123',
      target: { owner: 'loombox', repo: 'loombox', projectNumber: 4 },
    });
  });

  it('live/github rejects a non-integer or non-positive project number with a real message, not a silent drop', () => {
    const base: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('github'),
      connectionId: 'github:github.com:123',
      owner: 'loombox',
      repo: 'loombox',
    };
    expect(buildTrackerMode('live', { ...base, projectNumber: 'abc' }).error).toBe(
      'Project number must be a positive whole number.',
    );
    expect(buildTrackerMode('live', { ...base, projectNumber: '0' }).error).toBe(
      'Project number must be a positive whole number.',
    );
    expect(buildTrackerMode('live', { ...base, projectNumber: '-1' }).error).toBe(
      'Project number must be a positive whole number.',
    );
  });

  it('live/github rejects a missing owner or repo', () => {
    const draft: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('github'),
      connectionId: 'github:github.com:123',
      owner: '',
      repo: 'loombox',
    };
    expect(buildTrackerMode('live', draft).mode).toBeUndefined();
    expect(buildTrackerMode('live', draft).error).toBeTruthy();
  });

  it('live/jira succeeds with cloudId+projectKey', () => {
    const draft: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('jira'),
      connectionId: 'jira:myteam.atlassian.net:acc_1',
      cloudId: 'cloud-1',
      projectKey: 'LOOM',
    };
    const result = buildTrackerMode('live', draft);
    expect(result.error).toBeUndefined();
    expect(result.mode).toEqual({
      kind: 'live',
      provider: 'jira',
      connectionId: 'jira:myteam.atlassian.net:acc_1',
      target: { cloudId: 'cloud-1', projectKey: 'LOOM' },
    });
  });

  it('live/jira rejects a missing cloudId or projectKey', () => {
    const draft: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('jira'),
      connectionId: 'jira:myteam.atlassian.net:acc_1',
      cloudId: '',
      projectKey: 'LOOM',
    };
    expect(buildTrackerMode('live', draft).error).toBeTruthy();
  });

  it('rejects live mode with no connected account picked, before even looking at the target fields', () => {
    const draft: LiveTrackerDraft = {
      ...emptyLiveTrackerDraft('github'),
      connectionId: '',
      owner: 'loombox',
      repo: 'loombox',
    };
    expect(buildTrackerMode('live', draft).error).toBe('Pick a connected account before saving.');
  });
});

describe('liveTrackerDraftFrom (issue #220)', () => {
  it('recovers a github draft from a saved live TrackerMode, so re-opening the editor is pre-filled, not blank', () => {
    const draft = liveTrackerDraftFrom({
      kind: 'live',
      provider: 'github',
      connectionId: 'github:github.com:123',
      target: { owner: 'loombox', repo: 'loombox', projectNumber: 4 },
    });
    expect(draft).toEqual({
      provider: 'github',
      connectionId: 'github:github.com:123',
      owner: 'loombox',
      repo: 'loombox',
      projectNumber: '4',
      cloudId: '',
      projectKey: '',
    });
  });

  it('recovers a jira draft from a saved live TrackerMode', () => {
    const draft = liveTrackerDraftFrom({
      kind: 'live',
      provider: 'jira',
      connectionId: 'jira:myteam.atlassian.net:acc_1',
      target: { cloudId: 'cloud-1', projectKey: 'LOOM' },
    });
    expect(draft.provider).toBe('jira');
    expect(draft.cloudId).toBe('cloud-1');
    expect(draft.projectKey).toBe('LOOM');
    expect(draft.connectionId).toBe('jira:myteam.atlassian.net:acc_1');
  });

  it('returns a blank draft for a native mode (nothing live to recover)', () => {
    expect(liveTrackerDraftFrom({ kind: 'native' })).toEqual(emptyLiveTrackerDraft());
  });
});

describe('describeTrackerMode (issue #220)', () => {
  it('describes native mode', () => {
    expect(describeTrackerMode({ kind: 'native' })).toBe("Native — loombox's own local tracker");
  });

  it('describes a github live mode, including the optional board number when set', () => {
    expect(
      describeTrackerMode({
        kind: 'live',
        provider: 'github',
        connectionId: 'github:github.com:1',
        target: { owner: 'loombox', repo: 'loombox' },
      }),
    ).toBe('Live — GitHub: loombox/loombox');
    expect(
      describeTrackerMode({
        kind: 'live',
        provider: 'github',
        connectionId: 'github:github.com:1',
        target: { owner: 'loombox', repo: 'loombox', projectNumber: 4 },
      }),
    ).toBe('Live — GitHub: loombox/loombox, board #4');
  });

  it('describes a jira live mode', () => {
    expect(
      describeTrackerMode({
        kind: 'live',
        provider: 'jira',
        connectionId: 'jira:myteam.atlassian.net:acc_1',
        target: { cloudId: 'cloud-1', projectKey: 'LOOM' },
      }),
    ).toBe('Live — Jira: LOOM (cloud-1)');
  });
});
