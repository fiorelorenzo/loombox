// @vitest-environment jsdom
/**
 * `AttachmentBar`'s native branch (issue #284), split from
 * `AttachmentBar.test.ts` because it mocks `@capacitor/core` module-wide —
 * every other `AttachmentBar` test relies on the real (web) `Capacitor`
 * singleton, which correctly reports `isNativePlatform() === false` in
 * jsdom with no bridge injected.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent, waitFor } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import AttachmentBar from './AttachmentBar.svelte';

const { pickAttachmentImages } = vi.hoisted(() => ({ pickAttachmentImages: vi.fn() }));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('../native-attachments', () => ({ pickAttachmentImages }));

afterEach(() => {
  cleanup();
  pickAttachmentImages.mockReset();
});

const field = createRawSnippet<[{ pickFiles: () => void }]>((args) => ({
  render: () => `<div><button type="button" data-testid="attach">Attach</button></div>`,
  setup: (element: Element) => {
    element
      .querySelector('[data-testid="attach"]')
      ?.addEventListener('click', () => args().pickFiles());
  },
}));

describe('AttachmentBar: native picker branch (issue #284)', () => {
  it('calls onFiles with the native picker result instead of opening the hidden input', async () => {
    const nativeFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'attachment.png', {
      type: 'image/png',
    });
    pickAttachmentImages.mockResolvedValue([nativeFile]);
    const onFiles = vi.fn();
    render(AttachmentBar, {
      props: { attachments: [], onFiles, onRetry: vi.fn(), onRemove: vi.fn(), field },
    });
    const input = screen.getByLabelText('Attach images') as HTMLInputElement;
    const clicked = vi.spyOn(input, 'click');

    await fireEvent.click(screen.getByTestId('attach'));
    await waitFor(() => expect(pickAttachmentImages).toHaveBeenCalled());

    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([nativeFile]));
    expect(clicked).not.toHaveBeenCalled();
  });

  it('never calls onFiles when the native picker returns no files (cancelled)', async () => {
    pickAttachmentImages.mockResolvedValue([]);
    const onFiles = vi.fn();
    render(AttachmentBar, {
      props: { attachments: [], onFiles, onRetry: vi.fn(), onRemove: vi.fn(), field },
    });

    await fireEvent.click(screen.getByTestId('attach'));
    await waitFor(() => expect(pickAttachmentImages).toHaveBeenCalled());

    expect(onFiles).not.toHaveBeenCalled();
  });
});
