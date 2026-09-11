/**
 * Native camera/photo-library picker parity for the Capacitor shell
 * (SPEC.md §7.25, issue #284). `AttachmentBar.svelte`'s existing single
 * "Attach image" trigger already opens one combined OS chooser on mobile
 * web — a plain `<input type="file" accept="image/*">` with no `capture`
 * attribute lets the mobile browser itself offer "Take Photo" and "Photo
 * Library" from the same sheet. `pickAttachmentImages` is the one place
 * that swaps in the Capacitor equivalent: `AttachmentBar.pickFiles()`
 * checks `Capacitor.isNativePlatform()` once and calls this instead of
 * clicking the hidden input, rather than branching scattered through the
 * component.
 *
 * Design note (the "pick the implementation once, not a capability check
 * at the point of use" question this issue asks to answer explicitly):
 * `getPhoto`'s `CameraSource.Prompt` is the plugin's own combined
 * "camera or gallery" dialog, and it is the only shape that has ever
 * matched this one-button affordance. Capacitor 8.1 split the
 * *non-deprecated* API into `takePhoto`/`chooseFromGallery` and points a
 * caller who still wants one combined chooser at building bespoke UI
 * ("use `@capacitor/action-sheet` or any UI component of your choosing",
 * per the plugin's own `getPhoto` deprecation note). Standing up a second
 * visible affordance — its own button, a new hand-drawn icon in the
 * bespoke set, a composer layout change — is real product surface this
 * parity issue does not ask for and that can't be visually reviewed from
 * this box. So this deliberately keeps `getPhoto` on a plugin version
 * where it is deprecated but still shipped and functional, rather than
 * inventing new UI or hand-rolling a chooser dialog just to reach a
 * "non-deprecated API" checkbox. That is also the honest reading of the
 * "lowest common denominator" trap this design question warns against:
 * the risk isn't using a deprecated method, it's an abstraction that
 * flattens a real native affordance down to whatever the web can already
 * do. `getPhoto` still gets the *real* native camera/gallery chooser, full
 * quality/orientation options included — nothing about the web fallback
 * leaks into what native code path runs. Revisit once Capacitor actually
 * removes `getPhoto`, or once a design pass wants a dedicated
 * camera-only affordance.
 *
 * Whatever bytes come back run through the exact same
 * `validateAttachmentBytes` (magic-byte sniff, size cap, HEIC/HEIF reject,
 * `attachments.ts`) a web-picked file does — this module only ever turns a
 * `Photo` into a `File` via `RelayClient.attachFile`'s normal
 * `file.arrayBuffer()` read; it never inspects or decides what counts as a
 * valid image itself. That is what keeps HEIC/HEIF v1 behavior identical
 * with no native-specific branch: a HEIC byte stream a device hands back
 * unconverted is rejected exactly like one dropped from a desktop browser
 * (SPEC §7.25: "v1 rejects... unless native decode is demonstrably
 * reliable" — reusing the same sniff instead of trusting the device is
 * exactly *not* trusting an undemonstrated decode).
 *
 * NOT RUNNABLE HERE: no Android emulator, no iOS toolchain on this box
 * (docs/superpowers/specs/2026-08-08-capacitor-mobile-spike.md). The
 * `camera`/`fetchImpl` params below exist so the branching/conversion
 * logic is unit-tested against fakes standing in for the real plugin and
 * `fetch`; the actual native `@capacitor/camera` call is exercised only by
 * TypeScript's structural check against its `.d.ts`, never by a live run.
 */
import {
  Camera,
  CameraResultType,
  CameraSource,
  type CameraPlugin,
  type Photo,
} from '@capacitor/camera';

/** Minimal `@capacitor/camera` surface this module needs — satisfied by the real plugin singleton and by a test fake. */
export type NativeCameraEngine = Pick<CameraPlugin, 'getPhoto'>;

/**
 * Converts a `Photo`'s `webPath` into a real `File`. `webPath` is a
 * Capacitor-resolvable URL (a native `capacitor://` wrapper on device, a
 * plain `blob:` URL from the plugin's own web fallback) the WebView already
 * knows how to load — so this needs no platform-specific byte-decoding of
 * its own, just the one `fetch` an `<img src>` binding would also make.
 * Returns `undefined` for a result with no `webPath` (e.g. a cancelled or
 * malformed pick) rather than throwing, matching `AttachableFile`'s own
 * "give validation something byte-real or nothing" contract.
 */
export async function photoToFile(
  photo: Photo,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<File | undefined> {
  if (!photo.webPath) return undefined;
  const response = await fetchImpl(photo.webPath);
  const blob = await response.blob();
  const extension = photo.format || 'jpg';
  const mimeType = blob.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`;
  return new File([blob], `${name}.${extension}`, { type: mimeType });
}

/**
 * The native branch of `AttachmentBar`'s single "Attach image" trigger:
 * the device's own combined camera/photo-library chooser. Returns `[]`
 * (not a throw) when the user cancels the native dialog — `getPhoto`
 * rejects on cancel, and a cancelled pick is not a failure the composer
 * should surface as one.
 */
export async function pickAttachmentImages(
  camera: NativeCameraEngine = Camera,
  fetchImpl: typeof fetch = fetch,
): Promise<File[]> {
  try {
    const photo = await camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      correctOrientation: true,
    });
    const file = await photoToFile(photo, 'attachment', fetchImpl);
    return file ? [file] : [];
  } catch {
    return [];
  }
}
