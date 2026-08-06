import { z } from 'zod';
import { attentionHint } from './attention';
import { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';
import { fsListRequest, fsListResponse, fsReadRequest, fsReadResponse } from './fs';
import { gitDiffRequest, gitDiffResponse } from './git-diff';
import { mcpPromptGetRequest, mcpPromptGetResponse } from './mcp-prompts';
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
import {
  configOption,
  configOptionResult,
  permissionRequest,
  permissionResponse,
  promptInjectV1,
} from './steering';
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
import { customAgentProbeRequest, customAgentProbeResponse } from './custom-agent';
import { sshDiscoveryRequest, sshDiscoveryResponse } from './ssh-discovery';
import {
  decommissionTargetRequest,
  decommissionTargetResponse,
  targetUpdateRequest,
  targetUpdateResponse,
} from './target-lifecycle';
import {
  sessionArchiveRequest,
  sessionArchiveResponse,
  sessionForkRequest,
  sessionForkResponse,
} from './session-lifecycle';
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
  permissionPolicyGet,
  permissionPolicyResult,
  permissionPolicySet,
  permissionPolicyViolation,
} from './permission-policy';
import {
  checkpointCreate,
  checkpointList,
  checkpointListResult,
  checkpointResult,
  checkpointRestore,
  checkpointRestorePreview,
  checkpointRestorePreviewResult,
  checkpointRestoreResult,
} from './checkpoint';
import {
  sessionRewind,
  sessionRewindPreview,
  sessionRewindPreviewResult,
  sessionRewindResult,
} from './rewind';
import { keymapGetRequest, keymapResult, keymapSetRequest } from './keymap';
import {
  agentProfileListGet,
  agentProfileListResult,
  agentProfileListSet,
  agentProfileSessionGet,
  agentProfileSessionResult,
  agentProfileSessionSet,
} from './agent-profile';
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
import { trackerModeGetRequest, trackerModeResponse, trackerModeSetRequest } from './tracker';
import {
  trackerSnapshotRequest,
  trackerSnapshotResponse,
  trackerWriteRequest,
  trackerWriteResponse,
} from './tracker-records';
import { prOpenPreviewRequest, prOpenPreviewResult, prOpenRequest, prOpenResult } from './pr';
import { runCancel, runExit, runOutput, runStart, runStarted } from './test-runner';

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
  sessionForkRequest,
  sessionForkResponse,
  sessionUpdateEnvelopeV1,
  promptInjectV1,
  permissionRequest,
  permissionResponse,
  configOption,
  configOptionResult,
  blobUpload,
  blobRef,
  blobDownload,
  blobDownloadResponse,
  fsListRequest,
  fsListResponse,
  mcpPromptGetRequest,
  mcpPromptGetResponse,
  fsReadRequest,
  fsReadResponse,
  targetFsListRequest,
  targetFsListResponse,
  customAgentProbeRequest,
  customAgentProbeResponse,
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
  trackerModeGetRequest,
  trackerModeSetRequest,
  trackerModeResponse,
  trackerSnapshotRequest,
  trackerSnapshotResponse,
  trackerWriteRequest,
  trackerWriteResponse,
  runStart,
  runStarted,
  runOutput,
  runExit,
  runCancel,
  permissionPolicyGet,
  permissionPolicySet,
  permissionPolicyResult,
  permissionPolicyViolation,
  keymapGetRequest,
  keymapSetRequest,
  keymapResult,
  agentProfileListGet,
  agentProfileListSet,
  agentProfileListResult,
  agentProfileSessionGet,
  agentProfileSessionSet,
  agentProfileSessionResult,
  checkpointCreate,
  checkpointResult,
  checkpointList,
  checkpointListResult,
  checkpointRestorePreview,
  checkpointRestorePreviewResult,
  checkpointRestore,
  checkpointRestoreResult,
  sessionRewindPreview,
  sessionRewindPreviewResult,
  sessionRewind,
  sessionRewindResult,
  prOpenPreviewRequest,
  prOpenPreviewResult,
  prOpenRequest,
  prOpenResult,
  gitDiffRequest,
  gitDiffResponse,
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
