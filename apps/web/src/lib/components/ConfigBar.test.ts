// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOption, UsageRecord } from '@loombox/providers-core/browser';
import ConfigBar from './ConfigBar.svelte';

afterEach(() => cleanup());

const options: AcpConfigOption[] = [
  {
    category: 'model',
    current: 'sonnet',
    choices: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ],
  },
  {
    category: 'mode',
    current: 'default',
    choices: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
  },
  {
    category: 'thought_level',
    current: 'medium',
    choices: [{ id: 'medium', name: 'Medium' }],
  },
];

describe('ConfigBar: rendering the negotiated option set', () => {
  it('renders model and thought_level as selectors, and mode as a segmented control, from the session options — not hardcoded', () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('config-option-model')).toBeTruthy();
    expect(screen.getByTestId('config-option-thought_level')).toBeTruthy();
    expect(screen.getByTestId('config-option-mode')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Default' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
  });

  it('renders an unrecognized/future category generically rather than dropping it', () => {
    const withUnknown: AcpConfigOption[] = [
      ...options,
      { category: 'reasoning_budget', current: 'high', choices: [{ id: 'high', name: 'High' }] },
    ];
    render(ConfigBar, {
      props: { options: withUnknown, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('config-option-reasoning_budget')).toBeTruthy();
    expect(screen.getByText('Reasoning Budget')).toBeTruthy();
  });

  it('a user change calls onChange with the category and chosen option id (Select control)', async () => {
    const onChange = vi.fn();
    render(ConfigBar, { props: { options, usage: undefined, cumulativeCostUsd: 0, onChange } });
    const trigger = within(screen.getByTestId('config-option-model')).getByRole('combobox');
    await fireEvent.click(trigger);
    await fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
    expect(onChange).toHaveBeenCalledWith('model', 'opus');
  });

  it('a user change calls onChange for the mode segmented control', async () => {
    const onChange = vi.fn();
    render(ConfigBar, { props: { options, usage: undefined, cumulativeCostUsd: 0, onChange } });
    await fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
    expect(onChange).toHaveBeenCalledWith('mode', 'plan');
  });

  it('re-renders the full control set (not a single patched control) when the options prop is wholesale replaced', async () => {
    const { rerender } = render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('config-option-model').textContent).toContain('Sonnet');

    // Simulates an unprompted config_option_update: the whole option list is
    // replaced (a cheaper-model automatic fallback), never a single field patch.
    const fallenBack: AcpConfigOption[] = [
      { category: 'model', current: 'haiku', choices: [{ id: 'haiku', name: 'Haiku' }] },
    ];
    await rerender({
      options: fallenBack,
      usage: undefined,
      cumulativeCostUsd: 0,
      onChange: vi.fn(),
    });

    expect(screen.queryByTestId('config-option-mode')).toBeNull();
    expect(screen.getByTestId('config-option-model').textContent).toContain('Haiku');
  });
});

describe('ConfigBar: context/cost meter', () => {
  const usageAt = (tokensUsed: number, attributedToSubagent = false): UsageRecord => ({
    sessionId: 's1',
    tokensUsed,
    contextWindow: 200_000,
    costUsd: 0.5,
    attributedToSubagent,
  });

  it('reports the context in use against its maximum, not a bare percentage', () => {
    render(ConfigBar, {
      props: { options: [], usage: usageAt(50_000), cumulativeCostUsd: 1.23, onChange: vi.fn() },
    });
    expect(screen.getByText('50k')).toBeTruthy();
    expect(screen.getByText('200k')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
    // The percentage is the track's job visually; in words it lives on the
    // title, which is also the only place a screen reader gets it.
    expect(screen.getByTestId('context-meter').getAttribute('title')).toBe(
      '25% of the context window used this turn (50,000 of 200,000 tokens) · $1.23 spent this session',
    );
  });

  it('fills the track to the percentage used', () => {
    render(ConfigBar, {
      props: { options: [], usage: usageAt(50_000), cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    const track = screen.getByTestId('context-track');
    expect(track.dataset.fill).toBe('25');
    expect((track.firstElementChild as HTMLElement).style.width).toBe('25%');
  });

  // The two points where what a user does next changes, so each earns a
  // colour of its own rather than one undifferentiated "getting full".
  it('warns at 80% of the window and escalates at 95%', () => {
    const { rerender } = render(ConfigBar, {
      props: { options: [], usage: usageAt(100_000), cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('context-track').className).not.toContain('high');

    rerender({ options: [], usage: usageAt(170_000), cumulativeCostUsd: 0, onChange: vi.fn() });
    expect(screen.getByTestId('context-track').className).toContain('high');
    expect(screen.getByTestId('context-track').className).not.toContain('full');

    rerender({ options: [], usage: usageAt(195_000), cumulativeCostUsd: 0, onChange: vi.fn() });
    expect(screen.getByTestId('context-track').className).toContain('full');
  });

  it('excludes usage attributable to a subagent tool call from the context figures', () => {
    render(ConfigBar, {
      props: {
        options: [],
        usage: usageAt(50_000, true),
        cumulativeCostUsd: 1.23,
        onChange: vi.fn(),
      },
    });
    expect(screen.queryByTestId('context-track')).toBeNull();
    expect(screen.queryByText('200k')).toBeNull();
    // The cumulative cost figure still includes it (SPEC.md §7.9).
    expect(screen.getByText('$1.23')).toBeTruthy();
  });

  it('says nothing about the context when the agent reported a used count with no window to measure it against', () => {
    render(ConfigBar, {
      props: {
        options: [],
        usage: {
          sessionId: 's1',
          tokensUsed: 50_000,
          contextWindow: undefined,
          costUsd: 0.5,
          attributedToSubagent: false,
        },
        cumulativeCostUsd: 1.23,
        onChange: vi.fn(),
      },
    });
    expect(screen.queryByTestId('context-track')).toBeNull();
    expect(screen.queryByText('50k')).toBeNull();
    expect(screen.getByText('$1.23')).toBeTruthy();
  });
});

describe('ConfigBar: the agent answering', () => {
  it('names the agent in front of the model picker, so the row says who is answering', () => {
    render(ConfigBar, {
      props: {
        options,
        usage: undefined,
        cumulativeCostUsd: 0,
        onChange: vi.fn(),
        providerId: 'claude',
      },
    });
    expect(screen.getByTestId('config-agent').textContent).toBe('Claude Code');
    // The word the agent name replaced: the picker's value already reads as a
    // model name, so a visible "Model" label spent a word saying nothing.
    expect(screen.getByTestId('config-option-model').textContent).not.toContain('Model');
    // ...while the control keeps that word in its accessible name (`Select`
    // composes it with the current selection: "Model: Sonnet").
    expect(
      within(screen.getByTestId('config-option-model')).getByRole('combobox', {
        name: 'Model: Sonnet',
      }),
    ).toBeTruthy();
  });

  it('falls back to the raw provider id rather than dropping the fact', () => {
    render(ConfigBar, {
      props: {
        options: [],
        usage: undefined,
        cumulativeCostUsd: 0,
        onChange: vi.fn(),
        providerId: 'some-future-agent',
      },
    });
    expect(screen.getByTestId('config-agent').textContent).toBe('some-future-agent');
  });

  it('keeps the figures a user watches when the caller has no room, and only the denominator goes', () => {
    render(ConfigBar, {
      props: {
        options,
        usage: usage200k(120_000),
        cumulativeCostUsd: 2,
        onChange: vi.fn(),
        providerId: 'claude',
        compact: true,
      },
    });
    expect(screen.queryByTestId('config-option-model')).toBeNull();
    expect(screen.queryByTestId('config-option-mode')).toBeNull();
    expect(screen.queryByTestId('config-agent')).toBeNull();
    // What a phone must NOT lose: the used count, the cost, and the track that
    // carries the ratio the dropped denominator used to spell out.
    expect(screen.getByText('120k')).toBeTruthy();
    expect(screen.getByText('$2.00')).toBeTruthy();
    expect(screen.getByTestId('context-track').dataset.fill).toBe('60');
    expect(screen.queryByText('200k')).toBeNull();
    // ...and the figure it dropped is still readable on the meter itself.
    expect(screen.getByTestId('context-meter').getAttribute('title')).toContain(
      'of 200,000 tokens',
    );
  });
});

/** The same 200k-window record the meter suite uses, for the collapse test above. */
function usage200k(tokensUsed: number): UsageRecord {
  return {
    sessionId: 's1',
    tokensUsed,
    contextWindow: 200_000,
    costUsd: 0.5,
    attributedToSubagent: false,
  };
}
