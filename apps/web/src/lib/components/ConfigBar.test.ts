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

async function openPopover(): Promise<void> {
  await fireEvent.click(screen.getByTestId('config-trigger'));
}

describe('ConfigBar: the consolidated trigger (cockpit v8 decision E1-2, issue #711)', () => {
  it('reads the current model and effort, dot-joined, without opening anything', () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('config-trigger').textContent).toContain('Sonnet · Medium');
    // Nothing else is in the DOM yet — the whole point of collapsing behind
    // one trigger is that model/thinking/mode stay hidden until it opens.
    expect(screen.queryByTestId('config-popover')).toBeNull();
    expect(screen.queryByTestId('config-option-model')).toBeNull();
    expect(screen.queryByTestId('config-option-mode')).toBeNull();
  });

  it('falls back to a category label when nothing is selected yet, rather than a blank trigger', () => {
    const unset: AcpConfigOption[] = [
      { category: 'model', current: undefined, choices: [{ id: 'opus', name: 'Opus' }] },
    ];
    render(ConfigBar, {
      props: { options: unset, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('config-trigger').textContent).toContain('Model');
  });

  it('renders no trigger at all when the catalog is still empty (issue #705 not yet landed for this session)', () => {
    render(ConfigBar, {
      props: { options: [], usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.queryByTestId('config-trigger')).toBeNull();
  });

  it('opens one popover holding model, thinking and mode together on click', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();
    expect(screen.getByTestId('config-popover')).toBeTruthy();
    expect(screen.getByTestId('config-option-model')).toBeTruthy();
    expect(screen.getByTestId('config-option-thought_level')).toBeTruthy();
    expect(screen.getByTestId('config-option-mode')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Default' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Plan' })).toBeTruthy();
  });

  it('renders an unrecognized/future category generically inside the popover rather than dropping it, and folds it into the trigger too', async () => {
    const withUnknown: AcpConfigOption[] = [
      ...options,
      { category: 'reasoning_budget', current: 'high', choices: [{ id: 'high', name: 'High' }] },
    ];
    render(ConfigBar, {
      props: { options: withUnknown, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    // Not hardcoded to "exactly three categories": a fourth joins the
    // trigger's own summary the same generic way the first two do.
    expect(screen.getByTestId('config-trigger').textContent).toContain('Sonnet · Medium · High');

    await openPopover();
    expect(screen.getByTestId('config-option-reasoning_budget')).toBeTruthy();
    expect(screen.getByText('Reasoning Budget')).toBeTruthy();
    // ...alongside the other three, not instead of them.
    expect(screen.getByTestId('config-option-model')).toBeTruthy();
    expect(screen.getByTestId('config-option-mode')).toBeTruthy();
    expect(screen.getByTestId('config-option-thought_level')).toBeTruthy();
  });

  it('a user change calls onChange with the category and chosen option id (Select control)', async () => {
    const onChange = vi.fn();
    render(ConfigBar, { props: { options, usage: undefined, cumulativeCostUsd: 0, onChange } });
    await openPopover();
    const trigger = within(screen.getByTestId('config-option-model')).getByRole('combobox');
    await fireEvent.click(trigger);
    await fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
    expect(onChange).toHaveBeenCalledWith('model', 'opus');
  });

  it('a user change calls onChange for the mode segmented control', async () => {
    const onChange = vi.fn();
    render(ConfigBar, { props: { options, usage: undefined, cumulativeCostUsd: 0, onChange } });
    await openPopover();
    await fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    expect(onChange).toHaveBeenCalledWith('mode', 'plan');
  });

  it('marks the current mode in the accessibility tree, not only with a class (issue #549)', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
    const defaultRadio = within(group).getByRole('radio', { name: 'Default', checked: true });
    const planRadio = within(group).getByRole('radio', { name: 'Plan', checked: false });
    // The visual tint is still there too — the a11y state and the tint are
    // driven off the same `modeOption.current === choice.id` check, not
    // asserted through the class alone (which is what let this ship unmarked).
    expect(defaultRadio.classList.contains('selected')).toBe(true);
    expect(planRadio.classList.contains('selected')).toBe(false);
  });

  it('roving tabindex: only the checked segment is a tab stop, and it moves with the selection', async () => {
    const { rerender } = render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();
    expect(screen.getByRole('radio', { name: 'Default' }).tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'Plan' }).tabIndex).toBe(-1);

    // Simulates the round trip that follows a pick: the caller replaces
    // `options` wholesale (this component keeps no selection state of its
    // own — see ConfigBar.svelte's header comment). The popover itself
    // stays open across it — an unprompted config_option_update landing
    // mid-interaction must not slam the panel shut.
    const planSelected: AcpConfigOption[] = options.map((option) =>
      option.category === 'mode' ? { ...option, current: 'plan' } : option,
    );
    await rerender({
      options: planSelected,
      usage: undefined,
      cumulativeCostUsd: 0,
      onChange: vi.fn(),
    });

    expect(screen.getByTestId('config-popover')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Default' }).tabIndex).toBe(-1);
    expect(screen.getByRole('radio', { name: 'Plan' }).tabIndex).toBe(0);
  });

  it('arrow keys move the mode selection and move focus onto the newly-selected segment', async () => {
    const onChange = vi.fn();
    const { rerender } = render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange },
    });
    await openPopover();
    const defaultRadio = screen.getByRole('radio', { name: 'Default' });

    defaultRadio.focus();
    await fireEvent.keyDown(defaultRadio, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('mode', 'plan');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Plan' })),
    );

    // Simulates the round trip landing (same one-way data flow the
    // roving-tabindex test above exercises): only once `options` itself
    // reflects the pick does `current` move — arrow-key focus does not
    // wait on it, but a second arrow press reasons from wherever
    // `modeOption.current` actually is.
    onChange.mockClear();
    const planSelected: AcpConfigOption[] = options.map((option) =>
      option.category === 'mode' ? { ...option, current: 'plan' } : option,
    );
    await rerender({ options: planSelected, usage: undefined, cumulativeCostUsd: 0, onChange });
    const planRadio = screen.getByRole('radio', { name: 'Plan' });
    planRadio.focus();
    await fireEvent.keyDown(planRadio, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('mode', 'default');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Default' })),
    );
  });

  it('re-renders the full control set (not a single patched control) when the options prop is wholesale replaced', async () => {
    const { rerender } = render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();
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

describe('ConfigBar: the popover is keyboard-operable end to end (issue #711 acceptance)', () => {
  it('ArrowDown and Enter both open the popover from the trigger', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    const trigger = screen.getByTestId('config-trigger');

    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByTestId('config-popover')).toBeTruthy();

    await fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByTestId('config-popover')).toBeNull();

    await fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByTestId('config-popover')).toBeTruthy();
  });

  it('opening moves focus onto the first control inside, and Escape returns it to the trigger', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    const trigger = screen.getByTestId('config-trigger');
    await openPopover();

    // The first popover section is `model`'s own `Select` trigger.
    const modelCombobox = within(screen.getByTestId('config-option-model')).getByRole('combobox');
    await vi.waitFor(() => expect(document.activeElement).toBe(modelCombobox));

    await fireEvent.keyDown(screen.getByTestId('config-popover'), { key: 'Escape' });
    expect(screen.queryByTestId('config-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('every control inside the popover is a real, reachable tab stop', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();

    // One combobox per non-mode category (model, thought_level)...
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(2);
    comboboxes.forEach((combobox) => expect(combobox.hasAttribute('disabled')).toBe(false));

    // ...plus exactly one reachable (tabIndex 0) mode segment — the rest of
    // the radiogroup is off the tab order by design (roving tabindex).
    const radios = screen.getAllByRole('radio');
    const reachable = radios.filter((radio) => radio.tabIndex === 0);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]).toBe(screen.getByRole('radio', { name: 'Default' }));
  });

  it('Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();
    const panel = screen.getByTestId('config-popover');
    const modelCombobox = within(screen.getByTestId('config-option-model')).getByRole('combobox');
    const defaultRadio = screen.getByRole('radio', { name: 'Default' });

    defaultRadio.focus();
    await fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(modelCombobox);

    modelCombobox.focus();
    await fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(defaultRadio);
  });

  it('a click outside the trigger/popover closes it', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    await openPopover();
    expect(screen.getByTestId('config-popover')).toBeTruthy();

    await fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('config-popover')).toBeNull();
  });

  it('clicking the trigger again while open closes it and returns focus to the trigger', async () => {
    render(ConfigBar, {
      props: { options, usage: undefined, cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    const trigger = screen.getByTestId('config-trigger');
    await openPopover();
    expect(screen.getByTestId('config-popover')).toBeTruthy();

    await fireEvent.click(trigger);

    expect(screen.queryByTestId('config-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
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

  it('the near-limit warning fires at exactly the threshold, and not one percentage point before (issue #248 acceptance boundary)', () => {
    const { rerender } = render(ConfigBar, {
      props: { options: [], usage: usageAt(158_000), cumulativeCostUsd: 0, onChange: vi.fn() },
    });
    expect(screen.getByTestId('context-track').dataset.fill).toBe('79');
    expect(screen.queryByTestId('context-warning')).toBeNull();

    rerender({ options: [], usage: usageAt(160_000), cumulativeCostUsd: 0, onChange: vi.fn() });
    expect(screen.getByTestId('context-track').dataset.fill).toBe('80');
    expect(screen.getByTestId('context-warning')).toBeTruthy();
    expect(screen.getByTestId('context-warning').textContent).toContain('80%');
  });

  it("renders the context figures regardless of attributedToSubagent — excluding a subagent update from the percentage is the reducer's job now, not this component's (issue #248)", () => {
    // By the time `usage` reaches this component, `tokensUsed`/
    // `contextWindow` are ALREADY the parent-only numbers regardless of
    // `attributedToSubagent` — `transcript.ts`'s `reduceUsage` freezes them
    // at the reducer, see that file's own test for the freeze logic. This
    // component intentionally does NOT re-check the flag: an earlier
    // version gated the percentage on it here too, which meant a subagent
    // update blanked the meter instead of bouncing it to the wrong number —
    // still a bounce. This is a regression guard against reintroducing that
    // guard.
    render(ConfigBar, {
      props: {
        options: [],
        usage: usageAt(50_000, true),
        cumulativeCostUsd: 1.23,
        onChange: vi.fn(),
      },
    });
    expect(screen.getByTestId('context-track').dataset.fill).toBe('25');
    expect(screen.getByText('50k')).toBeTruthy();
    expect(screen.getByText('200k')).toBeTruthy();
    // The cumulative cost figure includes it too (SPEC.md §7.9).
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
  it('names the agent in front of the trigger, so the row says who is answering', () => {
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
    expect(screen.getByTestId('config-trigger').textContent).toContain('Sonnet · Medium');
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
    expect(screen.queryByTestId('config-trigger')).toBeNull();
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
