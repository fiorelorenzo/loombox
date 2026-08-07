import { z } from 'zod';
import { attentionHint } from './attention';
import { blobDownload, blobDownloadResponse, blobRef, blobUpload } from './attachments';
import {
  agentInstructionsGetRequest,
  agentInstructionsGetResponse,
  agentInstructionsSetRequest,
  agentInstructionsSetResponse,
} from './agent-instructions';
import {
  fsListRequest,
  fsListResponse,
  fsReadRequest,
  fsReadResponse,
  fsWriteRequest,
  fsWriteResponse,
} from './fs';
import { gitDiffRequest, gitDiffResponse } from './git-diff';
import { gitGraphRequest, gitGraphResponse } from './git-graph';
import {
  gitBranchCreateRequest,
  gitBranchCreateResponse,
  gitBranchListRequest,
  gitBranchListResponse,
  gitBranchMergeAbortRequest,
  gitBranchMergeAbortResponse,
  gitBranchMergeRequest,
  gitBranchMergeResponse,
  gitBranchSwitchRequest,
  gitBranchSwitchResponse,
} from './git-branch';
import { gitPushRequest, gitPushResponse } from './git-push';
import {
  gitStashDropRequest,
  gitStashDropResponse,
  gitStashListRequest,
  gitStashListResponse,
  gitStashPopRequest,
  gitStashPopResponse,
  gitStashSaveRequest,
  gitStashSaveResponse,
} from './git-stash';
import {
  gitCommitDraftRequest,
  gitCommitDraftResponse,
  gitCommitRequest,
  gitCommitResponse,
} from './git-commit';
import { gitDiffExplainRequest, gitDiffExplainResponse } from './git-diff-explain';
import {
  gitHunkActionRequest,
  gitHunkActionResponse,
  gitHunkDiffRequest,
  gitHunkDiffResponse,
} from './git-hunks';
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
  terminalResyncMarker,
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
  nodeSelfUpdateApplyRequest,
  nodeSelfUpdateApplyResponse,
  nodeSelfUpdateStatusAnnounce,
} from './node-self-update';
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
  sessionTemplateListGet,
  sessionTemplateListResult,
  sessionTemplateListSet,
} from './session-template';
import { spendCapGet, spendCapResult, spendCapSet, sessionSpendCapResume } from './spend-cap';
import { spendReportRequest, spendReportResponse } from './spend-report';
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
import { ciCheckStatus } from './ci-check';
import { reviewCommentStatus } from './review-comment';
import { prMergeRequest, prMergeResult } from './pr-merge';
import { ciAutoIterateStatus, ciAutoIterateStop } from './ci-auto-iterate';
import { runStatus } from './run-status';
import { trackerConnectivityStatus } from './tracker-connectivity';

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
  fsWriteRequest,
  fsWriteResponse,
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
  terminalResyncMarker,
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
  sessionTemplateListGet,
  sessionTemplateListSet,
  sessionTemplateListResult,
  spendCapGet,
  spendCapSet,
  spendCapResult,
  sessionSpendCapResume,
  spendReportRequest,
  spendReportResponse,
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
  gitHunkDiffRequest,
  gitHunkDiffResponse,
  gitHunkActionRequest,
  gitHunkActionResponse,
  gitBranchListRequest,
  gitBranchListResponse,
  gitBranchCreateRequest,
  gitBranchCreateResponse,
  gitBranchSwitchRequest,
  gitBranchSwitchResponse,
  gitBranchMergeRequest,
  gitBranchMergeResponse,
  gitBranchMergeAbortRequest,
  gitBranchMergeAbortResponse,
  gitPushRequest,
  gitPushResponse,
  gitStashSaveRequest,
  gitStashSaveResponse,
  gitStashListRequest,
  gitStashListResponse,
  gitStashPopRequest,
  gitStashPopResponse,
  gitStashDropRequest,
  gitStashDropResponse,
  gitCommitDraftRequest,
  gitCommitDraftResponse,
  gitCommitRequest,
  gitCommitResponse,
  gitDiffExplainRequest,
  gitDiffExplainResponse,
  gitGraphRequest,
  gitGraphResponse,
  ciCheckStatus,
  reviewCommentStatus,
  prMergeRequest,
  prMergeResult,
  trackerConnectivityStatus,
  agentInstructionsGetRequest,
  agentInstructionsGetResponse,
  agentInstructionsSetRequest,
  agentInstructionsSetResponse,
  ciAutoIterateStatus,
  ciAutoIterateStop,
  runStatus,
  ping,
  pong,
  nodeSelfUpdateStatusAnnounce,
  nodeSelfUpdateApplyRequest,
  nodeSelfUpdateApplyResponse,
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
