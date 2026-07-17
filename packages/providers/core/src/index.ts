export const PACKAGE_NAME = '@loombox/providers-core';

export { AcpClient } from './client';
export type { AcpChildProcess, AcpClientOptions } from './client';
export type {
  AcpAgentInfo,
  AcpContentBlock,
  AcpInitializeResult,
  AcpProvider,
  AcpSpawnConfig,
  AcpTextContentBlock,
  AcpTurnEnd,
  AcpUpdate,
  AcpUpdateKind,
} from './types';

// v1: the fuller ACP update surface + transcript reducer (SPEC.md §7.24,
// §5.5). Additive to the v0 exports above, which are unchanged.
export type {
  AcpDiff,
  AcpMessageChunkKind,
  AcpMessageChunkUpdate,
  AcpPlanEntry,
  AcpPlanEntryStatus,
  AcpPlanUpdate,
  AcpToolCallStatus,
  AcpToolCallUpdate,
  AcpToolKind,
  AcpTranscriptUpdate,
  AcpUsageUpdate,
} from './types';
export { createTranscriptState, reduceTranscript } from './transcript';
export type {
  TranscriptItem,
  TranscriptMessageItem,
  TranscriptState,
  TranscriptToolCallItem,
  UsageRecord,
} from './transcript';

// v1: session lifecycle (issue #176) — resume/list/cancel + replay live on
// AcpClient itself; the types below are the wire/domain shapes they use.
export type { AcpSessionSummary } from './types';

// v1: capability-negotiation-gated feature flags (SPEC.md §5.5; issue #180).
export { deriveFeatureFlags } from './capabilities';
export type { AcpFeatureFlags } from './capabilities';
export type { AcpAgentCapabilities, AcpPromptCapabilities } from './types';

// v1: the session/request_permission FIFO queue state machine (SPEC.md
// §7.24; issue #178).
export { PermissionQueue } from './permission-queue';
export type {
  EnqueuePermissionRequestInput,
  PendingPermissionRequest,
  PermissionResolveResult,
} from './permission-queue';
export type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionOutcome,
  AcpRequestPermissionParams,
} from './types';

// v1: config-option (model/mode/reasoning-effort) state (SPEC.md §7.24;
// issue #179).
export { ConfigOptionStore } from './config-options';
export type { ConfigOptionChangeEvent } from './config-options';
export type { AcpConfigOption, AcpConfigOptionChoice } from './types';

// v1: the provider-module registry + enrich() hook extension point
// (SPEC.md §5.5; issue #181).
export { ProviderRegistry, RESERVED_PROVIDER_IDS } from './provider-registry';
export type { AcpProviderModule } from './provider-registry';
