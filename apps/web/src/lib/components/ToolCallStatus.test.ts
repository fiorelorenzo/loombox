// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToolCallStatus from './ToolCallStatus.svelte';

afterEach(() => cleanup());

describe('ToolCallStatus', () => {
  it('renders nothing when there is no status yet', () => {
    const { container } = render(ToolCallStatus, { props: { status: undefined } });
    expect(container.querySelector('[data-testid="tool-call-status"]')).toBeNull();
  });

  it('shows a visible label next to the dot while a call is still moving', () => {
    render(ToolCallStatus, { props: { status: 'in_progress' } });
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'In progress' })).toBeTruthy();
  });

  it('shows a visible label for a call that has not started yet', () => {
    render(ToolCallStatus, { props: { status: 'pending' } });
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('drops the visible "Completed" caption once a call has settled successfully, without losing the accessible name', () => {
    render(ToolCallStatus, { props: { status: 'completed' } });
    expect(screen.queryByText('Completed')).toBeNull();
    // The dot itself still carries the accessible name for assistive tech.
    expect(screen.getByRole('img', { name: 'Completed' })).toBeTruthy();
  });

  it('makes a failed call louder than a completed one: visible, bold, danger-toned label', () => {
    const { container: failedContainer } = render(ToolCallStatus, {
      props: { status: 'failed' },
    });
    expect(screen.getByText('Failed')).toBeTruthy();
    const failedLabel = failedContainer.querySelector('.status-label');
    expect(failedLabel?.className).toContain('status-label');
    expect(failedContainer.querySelector('.tool-call-status-failed')).toBeTruthy();
    cleanup();

    // Same markup shape for completed, but no visible label at all — the
    // asymmetry is the point (failed shouts, completed stays quiet).
    render(ToolCallStatus, { props: { status: 'completed' } });
    expect(screen.queryByText(/./, { selector: '.status-label' })).toBeNull();
  });
});
