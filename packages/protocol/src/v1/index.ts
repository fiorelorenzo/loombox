/**
 * @loombox/protocol v1 (SPEC §10, §16; `docs/v1-plan.md`; issue #315).
 * Additive alongside the v0 schema in `../index.ts` — every v0 export stays
 * untouched; this module is the whole v1 wire contract, re-exported from the
 * package root.
 */

export type { Base64String, EncryptedEnvelope, EncryptionAlg } from './envelope';
export { base64String, encryptedEnvelope, encryptionAlg } from './envelope';

export type { BaseMessageV1, Initialize, InitializeResult, WireRole } from './handshake';
export {
  PROTOCOL_V1,
  SUPPORTED_PROTOCOL_VERSIONS,
  baseMessageV1,
  initialize,
  initializeResult,
  negotiateVersion,
  wireRole,
} from './handshake';

export type {
  AmkEscrow,
  DeviceRegister,
  DeviceRevoke,
  DeviceRotate,
  NewDeviceBootstrapRequest,
  NewDeviceBootstrapResponse,
  QrPairingRequest,
  QrPairingResponse,
  WrappedAmkEnvelope,
} from './devices';
export {
  amkEscrow,
  deviceRegister,
  deviceRevoke,
  deviceRotate,
  newDeviceBootstrapRequest,
  newDeviceBootstrapResponse,
  qrPairingRequest,
  qrPairingResponse,
  wrappedAmkEnvelope,
} from './devices';

export type { TargetAnnounce, TargetDescriptor, TargetKind } from './targets';
export { targetAnnounce, targetDescriptor, targetKind } from './targets';

export type {
  SessionAnnounceV1,
  SessionCreate,
  SessionListRequest,
  SessionListV1,
  SessionMetaPublic,
  SessionResume,
  SessionWithPrivateEnvelope,
} from './sessions';
export {
  sessionAnnounceV1,
  sessionCreate,
  sessionListRequest,
  sessionListV1,
  sessionMetaPublic,
  sessionResume,
  sessionWithPrivateEnvelope,
} from './sessions';

export type { SessionUpdateEnvelopeV1 } from './transcript';
export { sessionUpdateEnvelopeV1 } from './transcript';

export type {
  ConfigOption,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  PromptInjectV1,
} from './steering';
export {
  configOption,
  permissionDecision,
  permissionRequest,
  permissionResponse,
  promptInjectV1,
} from './steering';

export type { BlobDownload, BlobDownloadResponse, BlobRef, BlobUpload } from './attachments';
export { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';

export type { Presence, ResyncMarker, ResyncRequest } from './presence';
export { presence, resyncMarker, resyncRequest } from './presence';

export type { WireMessageV1 } from './message';
export { parseWireMessageV1, safeParseWireMessageV1, wireMessageV1 } from './message';

import { base64String, encryptedEnvelope, encryptionAlg } from './envelope';
import { baseMessageV1, initialize, initializeResult, wireRole } from './handshake';
import {
  amkEscrow,
  deviceRegister,
  deviceRevoke,
  deviceRotate,
  newDeviceBootstrapRequest,
  newDeviceBootstrapResponse,
  qrPairingRequest,
  qrPairingResponse,
  wrappedAmkEnvelope,
} from './devices';
import { targetAnnounce, targetDescriptor, targetKind } from './targets';
import {
  sessionAnnounceV1,
  sessionCreate,
  sessionListRequest,
  sessionListV1,
  sessionMetaPublic,
  sessionResume,
  sessionWithPrivateEnvelope,
} from './sessions';
import { sessionUpdateEnvelopeV1 } from './transcript';
import {
  configOption,
  permissionDecision,
  permissionRequest,
  permissionResponse,
  promptInjectV1,
} from './steering';
import { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';
import { presence, resyncMarker, resyncRequest } from './presence';
import { wireMessageV1 } from './message';

/** Registry of every v1 wire schema, for introspection/tooling (mirrors v0's `schemas` in `../index.ts`). */
export const schemasV1 = {
  base64String,
  encryptedEnvelope,
  encryptionAlg,
  baseMessageV1,
  wireRole,
  initialize,
  initializeResult,
  deviceRegister,
  wrappedAmkEnvelope,
  deviceRevoke,
  deviceRotate,
  amkEscrow,
  newDeviceBootstrapRequest,
  newDeviceBootstrapResponse,
  qrPairingRequest,
  qrPairingResponse,
  targetKind,
  targetDescriptor,
  targetAnnounce,
  sessionMetaPublic,
  sessionWithPrivateEnvelope,
  sessionCreate,
  sessionAnnounceV1,
  sessionResume,
  sessionListRequest,
  sessionListV1,
  sessionUpdateEnvelopeV1,
  promptInjectV1,
  permissionDecision,
  permissionRequest,
  permissionResponse,
  configOption,
  blobUpload,
  blobRef,
  blobDownload,
  blobDownloadResponse,
  presence,
  resyncRequest,
  resyncMarker,
  wireMessageV1,
} as const;
