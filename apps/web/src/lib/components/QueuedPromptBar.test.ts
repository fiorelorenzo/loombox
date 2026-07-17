// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueuedPrompt } from '../outbox';
import QueuedPromptBar from './QueuedPromptBar.svelte';

afterEach(() => cleanup());

function queuedPrompt(overrides: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    id: 'prompt_1',
    sessionId: 'sess_1',
    text: 'a follow-up prompt',
    attachments: [],
    queuedAt: 1,
    ...overrides,
  };
}

describe('QueuedPromptBar (SPEC §7.24 mid-turn composer state; §7.3 offline outbox; issues #128/#130)', () => {
  it('renders nothing when there are no queued prompts', () => {
    render(QueuedPromptBar, { props: { prompts: [] } });
    expect(screen.queryByTestId('queued-prompt-bar')).toBeNull();
  });

  it('renders one row per queued prompt, oldest first, each badged "Queued"', () => {
    render(QueuedPromptBar, {
      props: {
        prompts: [
          queuedPrompt({ id: 'p1', text: 'first queued', queuedAt: 1 }),
          queuedPrompt({ id: 'p2', text: 'second queued', queuedAt: 2 }),
        ],
      },
    });
    const rows = screen.getAllByTestId('queued-prompt');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('first queued');
    expect(rows[1].textContent).toContain('second queued');
    expect(screen.getAllByText('Queued')).toHaveLength(2);
  });

  it('renders the prompt text verbatim', () => {
    render(QueuedPromptBar, {
      props: { prompts: [queuedPrompt({ text: 'do the thing while the agent is busy' })] },
    });
    expect(screen.getByText('do the thing while the agent is busy')).toBeTruthy();
  });
});
