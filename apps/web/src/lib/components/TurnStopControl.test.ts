// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TurnStopControl from './TurnStopControl.svelte';

afterEach(() => cleanup());

describe('TurnStopControl (#129)', () => {
  it('renders nothing while no turn is active', () => {
    render(TurnStopControl, { props: { turnActive: false, onStop: vi.fn() } });
    expect(screen.queryByTestId('turn-stop-control')).toBeNull();
  });

  it('is reachable (rendered) whenever a turn is active, independent of any permission request', () => {
    render(TurnStopControl, { props: { turnActive: true, onStop: vi.fn() } });
    expect(screen.getByTestId('turn-stop-control')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop the running turn' })).toBeTruthy();
  });

  it('calls onStop, and only onStop — no rollback/undo call bundled in — on click', async () => {
    const onStop = vi.fn();
    render(TurnStopControl, { props: { turnActive: true, onStop } });
    await fireEvent.click(screen.getByTestId('turn-stop-control'));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
