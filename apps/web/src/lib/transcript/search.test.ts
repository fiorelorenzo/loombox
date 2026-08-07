import { describe, expect, it } from 'vitest';
import type { TranscriptGapItem, TranscriptItem } from '@loombox/providers-core/browser';
import { searchTranscript } from './search';

function message(
  id: string,
  kind: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
): TranscriptItem {
  return { type: 'message', id, kind, turnId: 't1', messageId: id, text };
}

function toolCall(
  id: string,
  title: string | undefined,
  diff?: { path: string; oldText: string | null; newText: string },
): TranscriptItem {
  return {
    type: 'tool_call',
    id,
    turnId: 't1',
    title,
    toolKind: undefined,
    status: 'completed',
    diff,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  };
}

describe('searchTranscript (SPEC.md §7.19; issues #262/#263)', () => {
  it('returns [] for an empty transcript', () => {
    expect(searchTranscript([], 'anything')).toEqual([]);
  });

  it('returns [] for an empty or whitespace-only query, never "everything matches"', () => {
    const items = [message('m1', 'user_message_chunk', 'hello world')];
    expect(searchTranscript(items, '')).toEqual([]);
    expect(searchTranscript(items, '   ')).toEqual([]);
  });

  it('finds a case-insensitive substring match inside a message', () => {
    const items = [message('m1', 'agent_message_chunk', 'The Quick Brown Fox')];
    expect(searchTranscript(items, 'quick')).toEqual([
      { itemId: 'm1', itemIndex: 0, field: 'message' },
    ]);
  });

  it('matches user, agent, and thought chunks alike — thought content is searchable even while its body is collapsed in the UI (see search-highlight.ts)', () => {
    const items = [
      message('m1', 'user_message_chunk', 'find the bug'),
      message('m2', 'agent_thought_chunk', 'the bug is a race condition'),
      message('m3', 'agent_message_chunk', 'fixed the bug'),
    ];
    expect(searchTranscript(items, 'bug').map((m) => m.itemId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('matches a tool call by its title', () => {
    const items = [toolCall('tc1', 'Run pytest suite')];
    expect(searchTranscript(items, 'pytest')).toEqual([
      { itemId: 'tc1', itemIndex: 0, field: 'tool_title' },
    ]);
  });

  it('an untitled tool call contributes no title match', () => {
    const items = [toolCall('tc1', undefined)];
    expect(searchTranscript(items, 'anything')).toEqual([]);
  });

  it('matches a tool call diff by its file path, but never by the diff body text', () => {
    const items = [
      toolCall('tc1', 'Edit file', {
        path: 'src/auth/session.ts',
        oldText: 'const secretPhraseNeedle = 1;',
        newText: 'const secretPhraseNeedle = 2;',
      }),
    ];
    expect(searchTranscript(items, 'session.ts')).toEqual([
      { itemId: 'tc1', itemIndex: 0, field: 'diff_path' },
    ]);
    // Deliberately excluded field — see search.ts's own doc comment.
    expect(searchTranscript(items, 'secretPhraseNeedle')).toEqual([]);
  });

  it('a gap item is never searched — it carries no text of its own', () => {
    const gap: TranscriptGapItem = { type: 'gap', id: 'gap::1::2', fromSeq: 1, toSeq: 2 };
    expect(searchTranscript([gap], 'gap')).toEqual([]);
  });

  it('a tool call rawInput/content payload is never searched, even if it contains the query as a string', () => {
    const items: TranscriptItem[] = [
      {
        ...(toolCall('tc1', 'Run command') as Extract<TranscriptItem, { type: 'tool_call' }>),
        rawInput: { command: 'echo needle' },
        content: 'needle found in stdout',
      },
    ];
    expect(searchTranscript(items, 'needle')).toEqual([]);
  });

  it('counts every occurrence inside one long message, not just one match per row', () => {
    const items = [message('m1', 'agent_message_chunk', 'cat sat on the cat mat, said the cat')];
    expect(searchTranscript(items, 'cat')).toHaveLength(3);
  });

  it('preserves transcript order across items, and occurrence order within one item', () => {
    const items = [
      message('m1', 'user_message_chunk', 'zebra'),
      toolCall('tc1', 'zebra crossing'),
      message('m2', 'agent_message_chunk', 'a zebra and another zebra'),
    ];
    const matches = searchTranscript(items, 'zebra');
    expect(matches.map((m) => m.itemId)).toEqual(['m1', 'tc1', 'm2', 'm2']);
    expect(matches.map((m) => m.itemIndex)).toEqual([0, 1, 2, 2]);
  });

  it('never matches across item boundaries — each item is searched independently', () => {
    const items = [
      message('m1', 'user_message_chunk', 'foo'),
      message('m2', 'agent_message_chunk', 'bar'),
    ];
    expect(searchTranscript(items, 'foobar')).toEqual([]);
  });

  it('a query longer than every field never crashes and simply finds nothing', () => {
    const items = [message('m1', 'user_message_chunk', 'short')];
    expect(searchTranscript(items, 'this query is much longer than the message text')).toEqual([]);
  });
});

describe('searchTranscript performance (issue #262/#263 acceptance: "performance does not collapse on a long session")', () => {
  /**
   * A synthetic 20,000-item transcript — roughly the scale of a very long,
   * hours-deep session with heavy tool use (a "normal" session is a few
   * hundred items; this is deliberately an order of magnitude past that).
   * Every 7th message plants the needle so a real query returns a
   * realistic, non-trivial number of matches rather than either zero or
   * "matches every item".
   */
  function buildLargeTranscript(count: number): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        const text =
          i % 7 === 0
            ? `Turn ${i}: investigating the flaky-retry-needle regression in the payment worker, again.`
            : `Turn ${i}: read the file, applied a small edit, and reported back with a short summary of what changed.`;
        items.push(
          message(`m${i}`, i % 3 === 0 ? 'agent_thought_chunk' : 'agent_message_chunk', text),
        );
      } else {
        items.push(toolCall(`tc${i}`, i % 7 === 0 ? 'Search for flaky-retry-needle' : 'Read file'));
      }
    }
    return items;
  }

  it('searches a 20,000-item transcript well within a single frame budget, and finds every planted match', () => {
    const items = buildLargeTranscript(20_000);
    const start = performance.now();
    const matches = searchTranscript(items, 'flaky-retry-needle');
    const elapsedMs = performance.now() - start;

    // Every 7th item (of both message and tool-call items) plants the
    // needle exactly once — see buildLargeTranscript above.
    const expectedCount = items.filter((_, i) => i % 7 === 0).length;
    expect(matches).toHaveLength(expectedCount);
    // Generous regression guard, not a tight benchmark assertion: a plain
    // linear scan over this repo's dev container measured (best-of-5)
    // 0.46ms at 5,000 items, 2.45ms at 20,000, and 7.2ms at 100,000 — see
    // this PR's description for the full numbers. 200ms leaves well over
    // an order of magnitude of headroom for CI machine variance before
    // this could ever flake.
    expect(elapsedMs).toBeLessThan(200);
  });
});
