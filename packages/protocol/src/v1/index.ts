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
  AcpConfigOptionChoiceV1,
  AcpConfigOptionV1,
  ConfigOptionsEventV1,
  ConfigOptionUpdateEventV1,
  SessionLifecycleEventV1,
  SessionStatusEventV1,
  SessionStatusV1,
  TurnEndedEventV1,
  TurnStartedEventV1,
} from './session-events';
export {
  acpConfigOptionChoiceV1,
  acpConfigOptionV1,
  configOptionsEventV1,
  configOptionUpdateEventV1,
  parseSessionLifecycleEventV1,
  safeParseSessionLifecycleEventV1,
  sessionLifecycleEventV1,
  sessionStatusEventV1,
  sessionStatusV1,
  turnEndedEventV1,
  turnStartedEventV1,
} from './session-events';

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

export type {
  FsEntryKindV1,
  FsEntryV1,
  FsListErrorV1,
  FsListRequest,
  FsListRequestPayloadV1,
  FsListResponse,
  FsListResponsePayloadV1,
  FsListResultV1,
} from './fs';
export {
  fsEntryKindV1,
  fsEntryV1,
  fsListErrorV1,
  fsListRequest,
  fsListRequestPayloadV1,
  fsListResponse,
  fsListResponsePayloadV1,
  fsListResultV1,
  parseFsListRequestPayloadV1,
  parseFsListResponsePayloadV1,
  safeParseFsListRequestPayloadV1,
  safeParseFsListResponsePayloadV1,
} from './fs';

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
  acpConfigOptionChoiceV1,
  acpConfigOptionV1,
  configOptionsEventV1,
  configOptionUpdateEventV1,
  sessionLifecycleEventV1,
  sessionStatusEventV1,
  sessionStatusV1,
  turnEndedEventV1,
  turnStartedEventV1,
} from './session-events';
import {
  configOption,
  permissionDecision,
  permissionRequest,
  permissionResponse,
  promptInjectV1,
} from './steering';
import { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';
import {
  fsEntryKindV1,
  fsEntryV1,
  fsListErrorV1,
  fsListRequest,
  fsListRequestPayloadV1,
  fsListResponse,
  fsListResponsePayloadV1,
  fsListResultV1,
} from './fs';
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
  acpConfigOptionChoiceV1,
  acpConfigOptionV1,
  sessionStatusV1,
  sessionStatusEventV1,
  configOptionsEventV1,
  configOptionUpdateEventV1,
  turnStartedEventV1,
  turnEndedEventV1,
  sessionLifecycleEventV1,
  promptInjectV1,
  permissionDecision,
  permissionRequest,
  permissionResponse,
  configOption,
  blobUpload,
  blobRef,
  blobDownload,
  blobDownloadResponse,
  fsEntryKindV1,
  fsEntryV1,
  fsListRequestPayloadV1,
  fsListResultV1,
  fsListErrorV1,
  fsListResponsePayloadV1,
  fsListRequest,
  fsListResponse,
  presence,
  resyncRequest,
  resyncMarker,
  wireMessageV1,
} as const;
