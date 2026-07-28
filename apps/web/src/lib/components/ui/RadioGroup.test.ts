// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RadioGroup, { type RadioOption } from './RadioGroup.svelte';

afterEach(() => cleanup());

const OPTIONS: RadioOption[] = [
  { value: 'worktree', label: 'Isolated worktree', description: 'A fresh branch.' },
  { value: 'in-place', label: 'In place', description: 'Only one session at a time.' },
];

describe('RadioGroup (coherence v5 design spec §1, issue #508 — NewSessionDialog Workspace choice)', () => {
  it('renders one role="radio" option per entry, aria-checked reflecting the current value', () => {
    render(RadioGroup, {
      props: { value: 'worktree', options: OPTIONS, onChange: vi.fn(), label: 'Workspace' },
    });
    expect(screen.getByTestId('ui-radio-group-worktree').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('ui-radio-group-in-place').getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByText('A fresh branch.')).toBeTruthy();
  });

  it("calls onChange with the clicked option's value", async () => {
    const onChange = vi.fn();
    render(RadioGroup, {
      props: { value: 'worktree', options: OPTIONS, onChange, label: 'Workspace' },
    });
    await fireEvent.click(screen.getByTestId('ui-radio-group-in-place'));
    expect(onChange).toHaveBeenCalledWith('in-place');
  });

  it('exposes an aria-label when standalone, or aria-labelledby when wired to an external label', () => {
    render(RadioGroup, {
      props: { value: 'worktree', options: OPTIONS, onChange: vi.fn(), label: 'Workspace' },
    });
    expect(screen.getByRole('radiogroup').getAttribute('aria-label')).toBe('Workspace');

    cleanup();
    render(RadioGroup, {
      props: {
        value: 'worktree',
        options: OPTIONS,
        onChange: vi.fn(),
        labelledBy: 'external-label-id',
      },
    });
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBe('external-label-id');
    expect(group.hasAttribute('aria-label')).toBe(false);
  });

  it('roots each option testid under a caller-provided dataTestId', () => {
    render(RadioGroup, {
      props: {
        value: 'worktree',
        options: OPTIONS,
        onChange: vi.fn(),
        label: 'Workspace',
        dataTestId: 'new-session-workspace',
      },
    });
    expect(screen.getByTestId('new-session-workspace-worktree')).toBeTruthy();
    expect(screen.getByTestId('new-session-workspace-in-place')).toBeTruthy();
  });
});
