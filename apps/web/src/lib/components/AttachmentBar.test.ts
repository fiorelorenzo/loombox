// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAttachment } from '../attachments';
import AttachmentBar from './AttachmentBar.svelte';

afterEach(() => cleanup());

function attachment(overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: 'a1',
    name: 'photo.png',
    mimeType: 'image/png',
    size: 1234,
    previewUrl: undefined,
    status: 'uploaded',
    error: undefined,
    ...overrides,
  };
}

/** jsdom's real `File` constructor, standing in for a user-picked/dropped/pasted file. */
function pngFile(name = 'photo.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' });
}

describe('AttachmentBar: rendering (SPEC §7.25)', () => {
  it('renders nothing in the chip list when there are no attachments', () => {
    render(AttachmentBar, {
      props: { attachments: [], onFiles: vi.fn(), onRetry: vi.fn(), onRemove: vi.fn() },
    });
    expect(screen.queryByTestId('attachment-chip')).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach image' })).toBeTruthy();
  });

  it('renders a preview image when previewUrl is set', () => {
    render(AttachmentBar, {
      props: {
        attachments: [attachment({ previewUrl: 'blob:fake-preview' })],
        onFiles: vi.fn(),
        onRetry: vi.fn(),
        onRemove: vi.fn(),
      },
    });
    const img = screen.getByAltText('photo.png') as HTMLImageElement;
    expect(img.src).toContain('blob:fake-preview');
  });

  it('shows an uploading indicator for a mid-upload attachment', () => {
    render(AttachmentBar, {
      props: {
        attachments: [attachment({ status: 'uploading' })],
        onFiles: vi.fn(),
        onRetry: vi.fn(),
        onRemove: vi.fn(),
      },
    });
    expect(screen.getByText('Uploading…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('shows the failure message and a Retry control for a failed attachment', () => {
    render(AttachmentBar, {
      props: {
        attachments: [attachment({ status: 'failed', error: 'Upload failed: not connected' })],
        onFiles: vi.fn(),
        onRetry: vi.fn(),
        onRemove: vi.fn(),
      },
    });
    expect(screen.getByText('Upload failed: not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry photo.png' })).toBeTruthy();
  });

  it('shows the rejection message with no Retry control for a rejected attachment (#152)', () => {
    render(AttachmentBar, {
      props: {
        attachments: [
          attachment({
            status: 'rejected',
            error: 'This looks like a HEIC/HEIF photo... Convert it to JPEG or PNG and re-upload.',
          }),
        ],
        onFiles: vi.fn(),
        onRetry: vi.fn(),
        onRemove: vi.fn(),
      },
    });
    expect(screen.getByText(/HEIC\/HEIF/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});

describe('AttachmentBar: interaction', () => {
  it('calls onFiles with the picked files when the file input changes', async () => {
    const onFiles = vi.fn();
    render(AttachmentBar, {
      props: { attachments: [], onFiles, onRetry: vi.fn(), onRemove: vi.fn() },
    });
    const input = screen.getByLabelText('Attach images') as HTMLInputElement;
    const file = pngFile();
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('calls onFiles with the dropped files', async () => {
    const onFiles = vi.fn();
    render(AttachmentBar, {
      props: { attachments: [], onFiles, onRetry: vi.fn(), onRemove: vi.fn() },
    });
    const dropZone = screen.getByTestId('attachment-bar');
    const file = pngFile('dropped.png');
    await fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('calls onFiles with pasted image files', async () => {
    const onFiles = vi.fn();
    render(AttachmentBar, {
      props: { attachments: [], onFiles, onRetry: vi.fn(), onRemove: vi.fn() },
    });
    const dropZone = screen.getByTestId('attachment-bar');
    const file = pngFile('pasted.png');
    await fireEvent.paste(dropZone, { clipboardData: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('calls onRetry with the attachment id when Retry is clicked', async () => {
    const onRetry = vi.fn();
    render(AttachmentBar, {
      props: {
        attachments: [attachment({ id: 'a2', status: 'failed', error: 'boom' })],
        onFiles: vi.fn(),
        onRetry,
        onRemove: vi.fn(),
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Retry photo.png' }));
    expect(onRetry).toHaveBeenCalledWith('a2');
  });

  it('calls onRemove with the attachment id when the remove control is clicked', async () => {
    const onRemove = vi.fn();
    render(AttachmentBar, {
      props: {
        attachments: [attachment({ id: 'a3' })],
        onFiles: vi.fn(),
        onRetry: vi.fn(),
        onRemove,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }));
    expect(onRemove).toHaveBeenCalledWith('a3');
  });
});
