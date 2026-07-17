// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CopyButton from './CopyButton.svelte';

afterEach(() => cleanup());

describe('CopyButton', () => {
  it('renders an accessible button and calls the provided copy function with its text on click', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    render(CopyButton, { props: { text: 'hello world', label: 'Copy message', copyFn: copy } });

    const button = screen.getByRole('button', { name: 'Copy message' });
    await fireEvent.click(button);

    expect(copy).toHaveBeenCalledWith('hello world');
  });
});
