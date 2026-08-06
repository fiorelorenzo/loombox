// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOption } from '@loombox/providers-core/browser';
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
      props: { options, onChange: vi.fn() },
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
      props: { options: unset, onChange: vi.fn() },
    });
    expect(screen.getByTestId('config-trigger').textContent).toContain('Model');
  });

  it('renders no trigger at all when the catalog is still empty (issue #705 not yet landed for this session)', () => {
    render(ConfigBar, {
      props: { options: [], onChange: vi.fn() },
    });
    expect(screen.queryByTestId('config-trigger')).toBeNull();
  });

  it('opens one popover holding model, thinking and mode together on click', async () => {
    render(ConfigBar, {
      props: { options, onChange: vi.fn() },
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
      props: { options: withUnknown, onChange: vi.fn() },
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
    render(ConfigBar, { props: { options, onChange } });
    await openPopover();
    const trigger = within(screen.getByTestId('config-option-model')).getByRole('combobox');
    await fireEvent.click(trigger);
    await fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
    expect(onChange).toHaveBeenCalledWith('model', 'opus');
  });

  it('a user change calls onChange for the mode segmented control', async () => {
    const onChange = vi.fn();
    render(ConfigBar, { props: { options, onChange } });
    await openPopover();
    await fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    expect(onChange).toHaveBeenCalledWith('mode', 'plan');
  });

  it('marks the current mode in the accessibility tree, not only with a class (issue #549)', async () => {
    render(ConfigBar, {
      props: { options, onChange: vi.fn() },
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
      props: { options, onChange: vi.fn() },
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
      onChange: vi.fn(),
    });

    expect(screen.getByTestId('config-popover')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Default' }).tabIndex).toBe(-1);
    expect(screen.getByRole('radio', { name: 'Plan' }).tabIndex).toBe(0);
  });

  it('arrow keys move the mode selection and move focus onto the newly-selected segment', async () => {
    const onChange = vi.fn();
    const { rerender } = render(ConfigBar, {
      props: { options, onChange },
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
    await rerender({ options: planSelected, onChange });
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
      props: { options, onChange: vi.fn() },
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
      onChange: vi.fn(),
    });

    expect(screen.queryByTestId('config-option-mode')).toBeNull();
    expect(screen.getByTestId('config-option-model').textContent).toContain('Haiku');
  });
});

describe('ConfigBar: the popover is keyboard-operable end to end (issue #711 acceptance)', () => {
  it('ArrowDown and Enter both open the popover from the trigger', async () => {
    render(ConfigBar, {
      props: { options, onChange: vi.fn() },
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
      props: { options, onChange: vi.fn() },
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
      props: { options, onChange: vi.fn() },
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
      props: { options, onChange: vi.fn() },
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
      props: { options, onChange: vi.fn() },
    });
    await openPopover();
    expect(screen.getByTestId('config-popover')).toBeTruthy();

    await fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('config-popover')).toBeNull();
  });

  it('clicking the trigger again while open closes it and returns focus to the trigger', async () => {
    render(ConfigBar, {
      props: { options, onChange: vi.fn() },
    });
    const trigger = screen.getByTestId('config-trigger');
    await openPopover();
    expect(screen.getByTestId('config-popover')).toBeTruthy();

    await fireEvent.click(trigger);

    expect(screen.queryByTestId('config-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});


describe('ConfigBar: the agent answering', () => {
  it('names the agent in front of the trigger, so the row says who is answering', () => {
    render(ConfigBar, {
      props: {
        options,
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
        onChange: vi.fn(),
        providerId: 'some-future-agent',
      },
    });
    expect(screen.getByTestId('config-agent').textContent).toBe('some-future-agent');
  });

  it('hides the pickers and agent name entirely when the caller has no room, keeping the popover reachable behind nothing until it is toggled back', () => {
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        providerId: 'claude',
        compact: true,
      },
    });
    expect(screen.queryByTestId('config-trigger')).toBeNull();
    expect(screen.queryByTestId('config-agent')).toBeNull();
  });
});

describe('ConfigBar: config-option source (issue #753, D4-3)', () => {
  it('renders no source badge and no pin control when the caller has not wired sources at all (every call site written before this issue)', async () => {
    render(ConfigBar, {
      props: { options, onChange: vi.fn() },
    });
    await openPopover();
    expect(screen.queryByTestId('config-source-model')).toBeNull();
    expect(screen.queryByTestId('config-pin-model')).toBeNull();
  });

  it("shows which layer produced each category's current value", async () => {
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        sources: { model: 'project', thought_level: 'account', mode: 'default' },
      },
    });
    await openPopover();
    expect(screen.getByTestId('config-source-model').textContent).toContain('Project');
    expect(screen.getByTestId('config-source-thought_level').textContent).toContain('Account');
    expect(screen.getByTestId('config-source-mode').textContent).toContain('Agent default');
  });

  it("summarizes every non-mode category's source in the trigger's own title, without opening the popover", () => {
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        sources: { model: 'project', thought_level: 'account', mode: 'default' },
      },
    });
    const title = screen.getByTestId('config-trigger').getAttribute('title');
    expect(title).toContain('Model: Project');
    expect(title).toContain('Thought Level: Account');
  });

  it('renders no pin control when only onPinToProject is given, without its onUnpinFromProject pair', async () => {
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        sources: { model: 'account' },
        onPinToProject: vi.fn(),
      },
    });
    await openPopover();
    expect(screen.queryByTestId('config-pin-model')).toBeNull();
  });

  it('pinning an unpinned category calls onPinToProject with that category', async () => {
    const onPinToProject = vi.fn();
    const onUnpinFromProject = vi.fn();
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        sources: { model: 'account' },
        onPinToProject,
        onUnpinFromProject,
      },
    });
    await openPopover();
    await fireEvent.click(screen.getByTestId('config-pin-model'));
    expect(onPinToProject).toHaveBeenCalledWith('model');
    expect(onUnpinFromProject).not.toHaveBeenCalled();
  });

  it('the pin control on an already-pinned category calls onUnpinFromProject instead, and reads as pressed', async () => {
    const onPinToProject = vi.fn();
    const onUnpinFromProject = vi.fn();
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        sources: { model: 'project' },
        onPinToProject,
        onUnpinFromProject,
      },
    });
    await openPopover();
    const pinButton = screen.getByTestId('config-pin-model');
    expect(pinButton.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(pinButton);
    expect(onUnpinFromProject).toHaveBeenCalledWith('model');
    expect(onPinToProject).not.toHaveBeenCalled();
  });

  it('mode gets its own source badge and pin control, exactly like every other category', async () => {
    const onPinToProject = vi.fn();
    render(ConfigBar, {
      props: {
        options,
        onChange: vi.fn(),
        sources: { mode: 'account' },
        onPinToProject,
        onUnpinFromProject: vi.fn(),
      },
    });
    await openPopover();
    expect(screen.getByTestId('config-source-mode').textContent).toContain('Account');
    await fireEvent.click(screen.getByTestId('config-pin-mode'));
    expect(onPinToProject).toHaveBeenCalledWith('mode');
  });
});
