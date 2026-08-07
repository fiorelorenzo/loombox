// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionReplayBanner from './SessionReplayBanner.svelte';

afterEach(() => cleanup());

describe('SessionReplayBanner (issue #265)', () => {
  it('unmistakably says this is a replay, not a live session', () => {
    render(SessionReplayBanner, { props: { onExit: vi.fn() } });
    const banner = screen.getByTestId('session-replay-banner');
    expect(banner.textContent).toContain('Replaying a past session');
    expect(banner.textContent?.toLowerCase()).toContain('not live');
  });

  it('exiting calls onExit', async () => {
    const onExit = vi.fn();
    render(SessionReplayBanner, { props: { onExit } });
    await fireEvent.click(screen.getByTestId('exit-replay-button'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
