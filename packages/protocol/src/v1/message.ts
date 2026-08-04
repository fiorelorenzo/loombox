import { z } from 'zod';
import { attentionHint } from './attention';
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
import { ping, pong } from './heartbeat';
import { leaseRelease, leaseReleaseResult, leaseRequest, leaseResult } from './lease';
import { presence, resyncMarker, resyncRequest } from './presence';
import { provisionProgress, provisionTargetRequest, provisionTargetResult } from './provisioning';
import {
  sessionAnnounceV1,
  sessionCreate,
  sessionListRequest,
  sessionListV1,
  sessionResume,
} from './sessions';
import { configOption, permissionRequest, permissionResponse, promptInjectV1 } from './steering';
import { targetAnnounce, targetList, targetListRequest, targetStatus } from './targets';
import {
  terminalClose,
  terminalClosed,
  terminalInput,
  terminalOpen,
  terminalOpened,
  terminalOutput,
  terminalResize,
} from './terminal';
import { sessionUpdateEnvelopeV1 } from './transcript';
import { targetFsListRequest, targetFsListResponse } from './target-fs';
import { sshDiscoveryRequest, sshDiscoveryResponse } from './ssh-discovery';
import {
  decommissionTargetRequest,
  decommissionTargetResponse,
  targetUpdateRequest,
  targetUpdateResponse,
} from './target-lifecycle';
import { sessionArchiveRequest, sessionArchiveResponse } from './session-lifecycle';
import {
  connectedAccountAnnounce,
  connectedAccountList,
  connectedAccountListRequest,
} from './connected-accounts';
import {
  testRunnerConfigDetect,
  testRunnerConfigDetected,
  testRunnerConfigGet,
  testRunnerConfigResult,
  testRunnerConfigSet,
} from './test-runner-config';
import {
  accountPinGetRequest,
  accountPinResolveRequest,
  accountPinResolveResponse,
  accountPinResponse,
  accountPinSetRequest,
  accountPinUnsetRequest,
  connectedAccountDisconnectRequest,
  connectedAccountDisconnectResponse,
  githubConnectCancelRequest,
  githubConnectDeviceCode,
  githubConnectResult,
  githubConnectStartRequest,
  jiraConnectRequest,
  jiraConnectResponse,
} from './account-connect';
import {
  trackerSnapshotRequest,
  trackerSnapshotResponse,
  trackerWriteRequest,
  trackerWriteResponse,
} from './tracker-records';

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
  targetListRequest,
  targetList,
  targetStatus,
  sessionCreate,
  sessionAnnounceV1,
  sessionResume,
  sessionListRequest,
  sessionListV1,
  sessionArchiveRequest,
  sessionArchiveResponse,
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
  targetFsListRequest,
  targetFsListResponse,
  terminalOpen,
  terminalOpened,
  terminalInput,
  terminalOutput,
  terminalResize,
  terminalClose,
  terminalClosed,
  presence,
  resyncRequest,
  resyncMarker,
  leaseRequest,
  leaseResult,
  leaseRelease,
  leaseReleaseResult,
  attentionHint,
  provisionTargetRequest,
  provisionProgress,
  provisionTargetResult,
  sshDiscoveryRequest,
  sshDiscoveryResponse,
  decommissionTargetRequest,
  decommissionTargetResponse,
  targetUpdateRequest,
  targetUpdateResponse,
  connectedAccountAnnounce,
  connectedAccountListRequest,
  connectedAccountList,
  testRunnerConfigGet,
  testRunnerConfigSet,
  testRunnerConfigResult,
  testRunnerConfigDetect,
  testRunnerConfigDetected,
  githubConnectStartRequest,
  githubConnectCancelRequest,
  githubConnectDeviceCode,
  githubConnectResult,
  jiraConnectRequest,
  jiraConnectResponse,
  connectedAccountDisconnectRequest,
  connectedAccountDisconnectResponse,
  accountPinGetRequest,
  accountPinSetRequest,
  accountPinUnsetRequest,
  accountPinResponse,
  accountPinResolveRequest,
  accountPinResolveResponse,
  trackerSnapshotRequest,
  trackerSnapshotResponse,
  trackerWriteRequest,
  trackerWriteResponse,
  ping,
  pong,
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
