import { z } from 'zod';
import { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';
import { fsListRequest, fsListResponse } from './fs';
import {
  amkEpochFetchRequest,
  amkEpochFetchResponse,
  amkEscrow,
  deviceRegister,
  deviceRevoke,
  deviceRotate,
  newDeviceBootstrapRequest,
  newDeviceBootstrapResponse,
  qrPairingRequest,
  qrPairingResponse,
} from './devices';
import { initialize, initializeResult } from './handshake';
import { presence, resyncMarker, resyncRequest } from './presence';
import {
  sessionAnnounceV1,
  sessionCreate,
  sessionListRequest,
  sessionListV1,
  sessionResume,
} from './sessions';
import { configOption, permissionRequest, permissionResponse, promptInjectV1 } from './steering';
import { targetAnnounce } from './targets';
import { sessionUpdateEnvelopeV1 } from './transcript';

/** The full v1 wire message set, discriminated on `type` (SPEC §10, §16, `docs/v1-plan.md`). */
export const wireMessageV1 = z.discriminatedUnion('type', [
  initialize,
  initializeResult,
  deviceRegister,
  deviceRevoke,
  deviceRotate,
  amkEscrow,
  amkEpochFetchRequest,
  amkEpochFetchResponse,
  newDeviceBootstrapRequest,
  newDeviceBootstrapResponse,
  qrPairingRequest,
  qrPairingResponse,
  targetAnnounce,
  sessionCreate,
  sessionAnnounceV1,
  sessionResume,
  sessionListRequest,
  sessionListV1,
  sessionUpdateEnvelopeV1,
  promptInjectV1,
  permissionRequest,
  permissionResponse,
  configOption,
  blobUpload,
  blobRef,
  blobDownload,
  blobDownloadResponse,
  fsListRequest,
  fsListResponse,
  presence,
  resyncRequest,
  resyncMarker,
]);
export type WireMessageV1 = z.infer<typeof wireMessageV1>;

/** Parses and validates an inbound v1 wire payload, throwing on an invalid one. */
export function parseWireMessageV1(data: unknown): WireMessageV1 {
  return wireMessageV1.parse(data);
}

/** Same as {@link parseWireMessageV1} but never throws; returns zod's result. */
export function safeParseWireMessageV1(
  data: unknown,
): z.SafeParseReturnType<unknown, WireMessageV1> {
  return wireMessageV1.safeParse(data);
}
