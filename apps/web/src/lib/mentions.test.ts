import { describe, expect, it } from 'vitest';
import {
  directoryMention,
  fileMention,
  mentionKey,
  resolveMentionsForSend,
  sessionMention,
  trackerMention,
  type SessionMention,
  type TrackerMention,
} from './mentions';

describe('mention constructors (issue #742): resourceLink is ACP\u2019s own resource_link, disambiguated by uri scheme', () => {
  it('fileMention names the basename but keys the full relative path', () => {
    const mention = fileMention('apps/web/src/lib/relay-client.ts');
    expect(mention).toEqual({
      kind: 'file',
      path: 'apps/web/src/lib/relay-client.ts',
      resourceLink: {
        type: 'resource_link',
        uri: 'file:apps/web/src/lib/relay-client.ts',
        name: 'relay-client.ts',
      },
    });
  });

  it('directoryMention names the full relative path, uri trailing-slashed to distinguish it from a file', () => {
    const mention = directoryMention('packages/providers/core/src');
    expect(mention.resourceLink).toEqual({
      type: 'resource_link',
      uri: 'file:packages/providers/core/src/',
      name: 'packages/providers/core/src',
    });
  });

  it('sessionMention uris by session id, names by title', () => {
    const mention = sessionMention('sess_abc123', 'Fix login bug');
    expect(mention.resourceLink).toEqual({
      type: 'resource_link',
      uri: 'loombox-session:sess_abc123',
      name: 'Fix login bug',
    });
  });

  it('trackerMention uris by node/project/record, percent-encoding the project path', () => {
    const mention = trackerMention('node-1', '/home/dev/proj a', 'rec_99', '#142 Fix login bug');
    expect(mention.resourceLink).toEqual({
      type: 'resource_link',
      uri: 'loombox-tracker:node-1/%2Fhome%2Fdev%2Fproj%20a/rec_99',
      name: '#142 Fix login bug',
    });
  });

  it('mentionKey is the resourceLink uri \u2014 two mentions of the same target key identically', () => {
    expect(mentionKey(fileMention('a.ts'))).toBe('file:a.ts');
    expect(mentionKey(sessionMention('s1', 'title'))).toBe('loombox-session:s1');
  });
});

describe('resolveMentionsForSend (issue #742: a deleted session/tracker referent degrades to text, never breaks the send)', () => {
  it('passes every mention through untouched when nothing is stale', () => {
    const file = fileMention('a.ts');
    const session = sessionMention('s1', 'Fix login bug');
    const result = resolveMentionsForSend('check this out', [file, session], () => true);
    expect(result).toEqual({ text: 'check this out', liveMentions: [file, session] });
  });

  it('never checks liveness for a file or directory mention \u2014 always treated as live', () => {
    const file = fileMention('a.ts');
    const dir = directoryMention('src');
    const isLive = () => {
      throw new Error('must not be called for file/directory mentions');
    };
    const result = resolveMentionsForSend('prose', [file, dir], isLive);
    expect(result).toEqual({ text: 'prose', liveMentions: [file, dir] });
  });

  it('a deleted session mention drops out of liveMentions and its name is folded back into the text as @name', () => {
    const session = sessionMention('s1', 'Fix login bug');
    const isLive = (mention: SessionMention | TrackerMention) => mention.kind !== 'session';
    const result = resolveMentionsForSend('does the same backoff apply to', [session], isLive);
    expect(result).toEqual({
      text: 'does the same backoff apply to @Fix login bug',
      liveMentions: [],
    });
  });

  it('a deleted tracker mention degrades the same way, and an empty prose gets exactly the @name with no leading space', () => {
    const tracker = trackerMention('node-1', '/proj', 'rec_99', 'LBX-142');
    const result = resolveMentionsForSend('', [tracker], () => false);
    expect(result).toEqual({ text: '@LBX-142', liveMentions: [] });
  });

  it('mixes live and stale mentions independently, preserving stale order in the appended suffix', () => {
    const liveFile = fileMention('a.ts');
    const staleSession = sessionMention('s1', 'Old session');
    const liveTracker = trackerMention('node-1', '/proj', 'rec_1', 'LBX-1');
    const staleTracker = trackerMention('node-1', '/proj', 'rec_2', 'LBX-2');
    const isLive = (mention: SessionMention | TrackerMention) =>
      mention.kind === 'tracker' && mention.recordId === 'rec_1';
    const result = resolveMentionsForSend(
      'compare these',
      [liveFile, staleSession, liveTracker, staleTracker],
      isLive,
    );
    expect(result).toEqual({
      text: 'compare these @Old session @LBX-2',
      liveMentions: [liveFile, liveTracker],
    });
  });
});
