// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@loombox/providers-core/browser';
import { SessionReplay } from '$lib/transcript/replay.svelte';
import SessionReplayControls from './SessionReplayControls.svelte';

afterEach(() => cleanup());

function toolCallItem(id: string): TranscriptItem {
  return {
    type: 'tool_call',
    id,
    turnId: 'turn:1',
    title: 'Read file',
    toolKind: 'read',
    status: 'completed',
    diff: undefined,
    rawInput: undefined,
    content: undefined,
    parentToolCallId: undefined,
    startedAtMs: undefined,
    elapsedMs: undefined,
    costAtStartUsd: undefined,
    attributedCostUsd: undefined,
  } as TranscriptItem;
}

describe('SessionReplayControls (issue #265)', () => {
  it('starts paused, showing a Play control and 0 of N steps', () => {
    const replay = new SessionReplay([toolCallItem('tc1'), toolCallItem('tc2')]);
    render(SessionReplayControls, { props: { replay } });
    expect(screen.getByTestId('replay-play-pause').getAttribute('aria-label')).toBe('Play replay');
    expect(screen.getByTestId('replay-progress').textContent?.trim()).toBe('0 / 2 steps');
  });

  it('clicking play/pause toggles the underlying engine and its own label', async () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    render(SessionReplayControls, { props: { replay } });

    await fireEvent.click(screen.getByTestId('replay-play-pause'));
    expect(replay.playing).toBe(true);
    flushSync();
    expect(screen.getByTestId('replay-play-pause').getAttribute('aria-label')).toBe('Pause replay');

    await fireEvent.click(screen.getByTestId('replay-play-pause'));
    expect(replay.playing).toBe(false);
  });

  it('speed options form a mutually-exclusive radiogroup, defaulting to 1x checked', () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    render(SessionReplayControls, { props: { replay } });
    const options = screen.getAllByTestId('replay-speed-option');
    expect(options).toHaveLength(4);
    expect(options[0]!.textContent?.trim()).toBe('1×');
    expect(options[0]!.getAttribute('aria-checked')).toBe('true');
    expect(options[1]!.getAttribute('aria-checked')).toBe('false');
  });

  it('clicking a speed option updates the engine speed and which option is checked', async () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    render(SessionReplayControls, { props: { replay } });
    const options = screen.getAllByTestId('replay-speed-option');

    await fireEvent.click(options[2]!); // 4×
    expect(replay.speed).toBe(4);
    flushSync();
    const refreshed = screen.getAllByTestId('replay-speed-option');
    expect(refreshed[2]!.getAttribute('aria-checked')).toBe('true');
    expect(refreshed[0]!.getAttribute('aria-checked')).toBe('false');
  });

  it('arrow keys move the speed selection, wrapping at both ends', async () => {
    const replay = new SessionReplay([toolCallItem('tc1')]);
    render(SessionReplayControls, { props: { replay } });
    const options = screen.getAllByTestId('replay-speed-option');

    await fireEvent.keyDown(options[0]!, { key: 'ArrowLeft' });
    expect(replay.speed).toBe(8); // wraps from 1x back to the last preset

    await fireEvent.keyDown(options[0]!, { key: 'ArrowRight' });
    expect(replay.speed).toBe(1);
  });

  it('scrubbing seeks the engine directly and pauses it', async () => {
    const replay = new SessionReplay([toolCallItem('tc1'), toolCallItem('tc2')]);
    replay.play();
    render(SessionReplayControls, { props: { replay } });

    const scrub = screen.getByTestId('replay-scrub') as HTMLInputElement;
    await fireEvent.input(scrub, { target: { value: String(replay.totalDurationMs) } });
    expect(replay.playing).toBe(false);
    expect(replay.positionMs).toBe(replay.totalDurationMs);
  });

  it('skip to end reveals everything and disables itself once finished', async () => {
    const replay = new SessionReplay([toolCallItem('tc1'), toolCallItem('tc2')]);
    render(SessionReplayControls, { props: { replay } });

    const skipButton = screen.getByTestId('replay-skip-to-end') as HTMLButtonElement;
    expect(skipButton.disabled).toBe(false);
    await fireEvent.click(skipButton);
    expect(replay.finished).toBe(true);
    flushSync();
    expect((screen.getByTestId('replay-skip-to-end') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('replay-progress').textContent?.trim()).toBe('2 / 2 steps');
  });

  it('restart jumps back to the beginning and starts playing again', async () => {
    const replay = new SessionReplay([toolCallItem('tc1'), toolCallItem('tc2')]);
    replay.skipToEnd();
    render(SessionReplayControls, { props: { replay } });

    await fireEvent.click(screen.getByTestId('replay-restart'));
    expect(replay.positionMs).toBe(0);
    expect(replay.playing).toBe(true);
  });
});
