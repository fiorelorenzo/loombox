// @vitest-environment jsdom
import {
  createTranscriptState,
  reduceTranscript,
  type TranscriptState,
} from '@loombox/providers-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard, exportTranscriptText, itemCopyText } from './copy';

describe('copyToClipboard', () => {
  afterEach(() => {
    // Restore navigator.clipboard between tests (jsdom doesn't implement it by default).
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await copyToClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to a hidden textarea + execCommand when Clipboard is unavailable', async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    await copyToClipboard('fallback text');

    expect(execCommand).toHaveBeenCalledWith('copy');
    // The scratch textarea is cleaned up, not left in the DOM.
    expect(document.querySelector('textarea')).toBeNull();
  });
});

function seedState(): TranscriptState {
  let state = createTranscriptState();
  state = reduceTranscript(state, {
    kind: 'agent_message_chunk',
    turnId: 't1',
    messageId: 'm1',
    text: 'Hello there',
  });
  state = reduceTranscript(state, {
    kind: 'tool_call',
    id: 'tc1',
    title: 'Edit src/foo.ts',
    toolKind: 'edit',
    status: 'completed',
    diff: { path: 'src/foo.ts', oldText: 'a', newText: 'b' },
  });
  return state;
}

describe('itemCopyText', () => {
  it('renders a message item with its role label', () => {
    const state = seedState();
    const message = state.items[0];
    expect(itemCopyText(message)).toBe('Agent: Hello there');
  });

  it('renders a diff-bearing tool call with its path and new text', () => {
    const state = seedState();
    const toolCall = state.items[1];
    const text = itemCopyText(toolCall);
    expect(text).toContain('Tool: Edit src/foo.ts');
    expect(text).toContain('Status: completed');
    expect(text).toContain('--- src/foo.ts');
    expect(text).toContain('b');
  });
});

describe('exportTranscriptText', () => {
  it('joins every item, in order, separated by a blank line', () => {
    const state = seedState();
    const text = exportTranscriptText(state);
    const blocks = text.split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('Agent: Hello there');
    expect(blocks[1]).toContain('Tool: Edit src/foo.ts');
  });
});
