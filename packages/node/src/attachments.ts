import type { webcrypto } from 'node:crypto';

import { decryptEnvelope, envelopeFromWire } from '@loombox/crypto';
import {
  PROTOCOL_V1,
  type BlobDownload,
  type EncryptedEnvelope,
  type WireMessageV1,
} from '@loombox/protocol';

type CryptoKey = webcrypto.CryptoKey;

/**
 * Fetches one attachment blob's opaque ciphertext by ref (SPEC §7.25
 * "Deliver to the executing host"; issue #156). The relay only ever serves
 * ciphertext — this interface never sees, and never needs, any key
 * material. Kept narrow and separate from `AttachmentResolver` (below) so a
 * test can fake the transport without touching crypto at all.
 */
export interface BlobSource {
  downloadBlob(sessionId: string, ref: string): Promise<EncryptedEnvelope>;
}

/**
 * The minimal surface `RelayBlobSource` needs off this node's *existing*
 * relay connection — never a new one (issue #156's acceptance criterion).
 * `RelayConnection` (this package's real production connection) already
 * satisfies this shape; a test can substitute a tiny fake with no
 * WebSocket/network involved at all.
 */
export interface RelayLike {
  send(message: WireMessageV1): void;
  on(event: 'message', listener: (message: WireMessageV1) => void): void;
  off(event: 'message', listener: (message: WireMessageV1) => void): void;
}

export interface RelayBlobSourceOptions {
  /** How long to wait for the matching `blob_download_response` before rejecting (default 10s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A `BlobSource` backed by this node's existing relay connection: sends a
 * `blob_download` and resolves once the matching `blob_download_response`
 * (same `sessionId`+`ref`) arrives on that same connection's inbound message
 * stream — exactly the wire pair `packages/protocol/src/v1/attachments.ts`
 * already defines, reused rather than extended. No new socket, no new
 * relay-facing message type.
 *
 * Note (honest gap, tracked separately): the relay's own message router
 * (`packages/relay/src/relay.ts`) currently only handles `blob_download` for
 * a *client*-role connection (`handleClientMessage`); a *node*-role
 * connection sending it today falls through to `handleNodeMessage`'s default
 * case and is dropped with a warning, not routed to `store.blobs.download`.
 * `packages/relay` is out of this PR's scope (see the PR description), so
 * this class is correct against the documented wire contract and is
 * hermetically tested against a fake `RelayLike` standing in for a
 * relay that *does* route it — wiring that routing on the relay side is
 * the remaining piece before this works against the live relay.
 */
export class RelayBlobSource implements BlobSource {
  private readonly relay: RelayLike;
  private readonly timeoutMs: number;

  constructor(relay: RelayLike, options: RelayBlobSourceOptions = {}) {
    this.relay = relay;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  downloadBlob(sessionId: string, ref: string): Promise<EncryptedEnvelope> {
    return new Promise((resolve, reject) => {
      // `onMessage` closes over `timer`, declared just below — safe despite
      // the forward reference: `onMessage` only ever runs later, as an event
      // listener callback, by which point `timer` is already initialized.
      const onMessage = (message: WireMessageV1): void => {
        if (
          message.type === 'blob_download_response' &&
          message.sessionId === sessionId &&
          message.ref === ref
        ) {
          clearTimeout(timer);
          this.relay.off('message', onMessage);
          resolve(message.envelope);
        }
      };

      this.relay.on('message', onMessage);
      const timer = setTimeout(() => {
        this.relay.off('message', onMessage);
        reject(
          new Error(
            `RelayBlobSource: timed out waiting for blob_download_response (session ${sessionId}, ref ${ref})`,
          ),
        );
      }, this.timeoutMs);

      const request: BlobDownload = {
        type: 'blob_download',
        protocolVersion: PROTOCOL_V1,
        sessionId,
        ref,
      };
      this.relay.send(request);
    });
  }
}

/**
 * The AAD binding target used to decrypt one attachment blob (SPEC §8's
 * swap/spoof fix), mirroring exactly how the relay's own in-memory/DB blob
 * store keys each upload (`relay.ts`: `` `${sessionId}:${ref}` ``) — so a
 * ciphertext relabeled onto a different session or a different ref within
 * the same session fails to decrypt instead of silently opening.
 */
export function attachmentResourceId(sessionId: string, ref: string): string {
  return `${sessionId}:${ref}`;
}

/**
 * Downloads (via a `BlobSource`) and decrypts one attachment blob under a
 * caller-supplied session key — SPEC §7.25's "fetches the ciphertext by
 * ref... and decrypts it locally." Deliberately takes the key per call
 * rather than owning key derivation itself: `@loombox/node`'s `NodeDaemon`
 * is the only thing holding the account's AMK (SPEC §8), so key derivation
 * stays there; this class only ever sees the one session key it's handed.
 */
export class AttachmentResolver {
  private readonly blobSource: BlobSource;

  constructor(blobSource: BlobSource) {
    this.blobSource = blobSource;
  }

  async resolve(sessionId: string, ref: string, key: CryptoKey): Promise<Uint8Array> {
    const wire = await this.blobSource.downloadBlob(sessionId, ref);
    const envelope = envelopeFromWire(wire);
    return decryptEnvelope(attachmentResourceId(sessionId, ref), envelope, key);
  }
}
