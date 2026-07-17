// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptMessageItem } from '@loombox/providers-core';
import MessageItem from './MessageItem.svelte';

afterEach(() => cleanup());

function messageItem(extra: Partial<TranscriptMessageItem> = {}): TranscriptMessageItem {
  return {
    type: 'message',
    id: 't1::agent_message_chunk::m1',
    kind: 'agent_message_chunk',
    turnId: 't1',
    messageId: 'm1',
    text: 'Hello there',
    ...extra,
  };
}

describe('MessageItem', () => {
  it('renders an agent message with its text visible', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it('renders a user message distinctly', () => {
    render(MessageItem, { props: { item: messageItem({ kind: 'user_message_chunk' }) } });
    expect(screen.getByText('user')).toBeTruthy();
  });

  it('collapses a thought by default, expandable on tap', async () => {
    render(MessageItem, {
      props: { item: messageItem({ kind: 'agent_thought_chunk', text: 'secret reasoning' }) },
    });
    expect(screen.getByText('thought')).toBeTruthy();
    expect(screen.queryByText('secret reasoning')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Show thought' }));
    expect(screen.getByText('secret reasoning')).toBeTruthy();
  });

  it('has a working copy affordance', () => {
    render(MessageItem, { props: { item: messageItem() } });
    expect(screen.getByRole('button', { name: 'Copy agent message' })).toBeTruthy();
  });
});
