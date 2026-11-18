import { describe, expect, it, vi } from 'vitest';

import { photoToFile, pickAttachmentImages, type NativeCameraEngine } from './native-attachments';
import { CameraResultType, CameraSource, type Photo } from '@capacitor/camera';

/** A `fetch`-shaped fake standing in for the WebView's real `fetch`, resolving `webPath` to a fixed `Blob`. */
function fakeFetch(blob: Blob): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(blob)) as unknown as typeof fetch;
}

describe('photoToFile (#284)', () => {
  it('fetches webPath and builds a File carrying the sniffed format as both name suffix and mimeType', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const photo: Photo = {
      webPath: 'capacitor://localhost/_capacitor_file_/tmp/img.jpeg',
      format: 'jpeg',
      saved: false,
    };
    const file = await photoToFile(photo, 'attachment', fakeFetch(blob));
    expect(file).toBeInstanceOf(File);
    expect(file!.name).toBe('attachment.jpeg');
    expect(file!.type).toBe('image/jpeg');
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('normalizes the platform-reported "jpg" format to an image/jpeg mimeType', async () => {
    const photo: Photo = { webPath: 'capacitor://localhost/x.jpg', format: 'jpg', saved: false };
    const file = await photoToFile(photo, 'attachment', fakeFetch(new Blob([new Uint8Array([9])])));
    expect(file!.name).toBe('attachment.jpg');
    expect(file!.type).toBe('image/jpeg');
  });

  it('returns undefined, not a throw, for a result with no webPath', async () => {
    const photo: Photo = { format: 'jpeg', saved: false };
    await expect(photoToFile(photo, 'attachment', fakeFetch(new Blob()))).resolves.toBeUndefined();
  });
});

describe('pickAttachmentImages (#284)', () => {
  it('calls getPhoto with the combined camera/gallery prompt and returns a single File built from the result', async () => {
    const photo: Photo = {
      webPath: 'capacitor://localhost/photo.png',
      format: 'png',
      saved: false,
    };
    const getPhoto = vi.fn().mockResolvedValue(photo);
    const camera: NativeCameraEngine = { getPhoto };
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const files = await pickAttachmentImages(camera, fakeFetch(new Blob([pngBytes])));

    expect(getPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ resultType: CameraResultType.Uri, source: CameraSource.Prompt }),
    );
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/png');
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(pngBytes);
  });

  it('resolves to an empty array, not a rejection, when the user cancels the native dialog', async () => {
    const camera: NativeCameraEngine = {
      getPhoto: vi.fn().mockRejectedValue(new Error('User cancelled photos app')),
    };
    await expect(pickAttachmentImages(camera)).resolves.toEqual([]);
  });
});
