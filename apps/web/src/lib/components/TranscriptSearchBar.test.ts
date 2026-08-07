// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TranscriptSearchBar from './TranscriptSearchBar.svelte';

afterEach(() => cleanup());

interface BarProps {
  query: string;
  activeIndex: number;
  matchCount: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

function renderBar(overrides: Partial<BarProps> = {}) {
  const onQueryChange = vi.fn();
  const onNext = vi.fn();
  const onPrevious = vi.fn();
  const onClose = vi.fn();
  const utils = render(TranscriptSearchBar, {
    props: {
      query: '',
      activeIndex: 0,
      matchCount: 0,
      onQueryChange,
      onNext,
      onPrevious,
      onClose,
      ...overrides,
    },
  });
  return { ...utils, onQueryChange, onNext, onPrevious, onClose };
}

describe('TranscriptSearchBar (issues #262/#263)', () => {
  it('autofocuses the query input on mount', () => {
    renderBar();
    expect(screen.getByTestId('transcript-search-input')).toBe(document.activeElement);
  });

  it('shows no count while the query is empty', () => {
    renderBar({ query: '', matchCount: 0 });
    expect(screen.getByTestId('transcript-search-count').textContent?.trim()).toBe('');
  });

  it('shows "No results" for a non-empty query with zero matches', () => {
    renderBar({ query: 'zzz', matchCount: 0 });
    expect(screen.getByTestId('transcript-search-count').textContent?.trim()).toBe('No results');
  });

  it('shows "N of M", 1-based, once there are matches', () => {
    renderBar({ query: 'needle', matchCount: 5, activeIndex: 2 });
    expect(screen.getByTestId('transcript-search-count').textContent?.trim()).toBe('3 of 5');
  });

  it('calls onQueryChange as the user types, forwarding the raw input value', async () => {
    const { onQueryChange } = renderBar();
    const input = screen.getByTestId('transcript-search-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'needle' } });
    expect(onQueryChange).toHaveBeenCalledWith('needle');
  });

  it('Enter calls onNext, Shift+Enter calls onPrevious', async () => {
    const { onNext, onPrevious } = renderBar({ query: 'needle', matchCount: 3 });
    const input = screen.getByTestId('transcript-search-input');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNext).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onClose', async () => {
    const { onClose } = renderBar();
    const input = screen.getByTestId('transcript-search-input');
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables next/previous while there are no matches, enables them once there are', () => {
    const { rerender } = renderBar({ query: 'zzz', matchCount: 0 });
    expect((screen.getByTestId('transcript-search-next') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('transcript-search-prev') as HTMLButtonElement).disabled).toBe(true);

    rerender({
      query: 'needle',
      matchCount: 2,
      activeIndex: 0,
      onQueryChange: vi.fn(),
      onNext: vi.fn(),
      onPrevious: vi.fn(),
      onClose: vi.fn(),
    });
    expect((screen.getByTestId('transcript-search-next') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByTestId('transcript-search-prev') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('clicking next/previous/close calls the matching handler', async () => {
    const { onNext, onPrevious, onClose } = renderBar({ query: 'needle', matchCount: 3 });
    await fireEvent.click(screen.getByTestId('transcript-search-next'));
    expect(onNext).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByTestId('transcript-search-prev'));
    expect(onPrevious).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByTestId('transcript-search-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
