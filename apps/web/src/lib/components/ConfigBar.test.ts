// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOption, UsageRecord } from '@loombox/providers-core';
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

  it('a user change calls onChange with the category and chosen option id (select control)', async () => {
    const onChange = vi.fn();
    render(ConfigBar, { props: { options, usage: undefined, cumulativeCostUsd: 0, onChange } });
    const select = screen.getByTestId('config-option-model').querySelector('select')!;
    await fireEvent.change(select, { target: { value: 'opus' } });
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
    expect(screen.getByTestId('config-option-model').textContent).toContain('Model');

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
  it('renders the context-fill percentage and cumulative cost', () => {
    const usage: UsageRecord = {
      sessionId: 's1',
      tokensUsed: 50_000,
      contextWindow: 200_000,
      costUsd: 0.5,
      attributedToSubagent: false,
    };
    render(ConfigBar, {
      props: { options: [], usage, cumulativeCostUsd: 1.23, onChange: vi.fn() },
    });
    expect(screen.getByText('25% context')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
  });

  it('excludes usage attributable to a subagent tool call from the percentage meter', () => {
    const usage: UsageRecord = {
      sessionId: 's1',
      tokensUsed: 50_000,
      contextWindow: 200_000,
      costUsd: 0.5,
      attributedToSubagent: true,
    };
    render(ConfigBar, {
      props: { options: [], usage, cumulativeCostUsd: 1.23, onChange: vi.fn() },
    });
    expect(screen.queryByText('25% context')).toBeNull();
    // The cumulative cost figure still includes it (SPEC.md §7.9).
    expect(screen.getByText('$1.23')).toBeTruthy();
  });
});
