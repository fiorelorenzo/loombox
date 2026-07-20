export const PACKAGE_NAME = '@loombox/providers-core';

export { AcpClient, McpServerSecretMissingError } from './client';
export type { AcpChildProcess, AcpClientOptions, NewSessionOptions } from './client';
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
export {
  ancestorChainForToolCall,
  createTranscriptState,
  reduceSessionEvent,
  reduceTranscript,
} from './transcript';
export type {
  TranscriptItem,
  TranscriptMessageItem,
  TranscriptState,
  TranscriptToolCallItem,
  UsageRecord,
} from './transcript';

// v1: session-lifecycle wire events — status badge / config-options push /
// turn-started-ended (SPEC.md §7.13/§7.24/§8; issues #126/#128/#149).
// Additive to the transcript-reducer exports above; `reduceSessionEvent` is
// the reducer entry point over this wider union.
export type {
  AcpConfigOptionsEvent,
  AcpConfigOptionUpdateEvent,
  AcpSessionLifecycleEvent,
  AcpSessionStatus,
  AcpSessionStatusEvent,
  AcpSessionWireEvent,
  AcpTurnEndedEvent,
  AcpTurnStartedEvent,
} from './types';

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

// v1: the pure, EventEmitter-free core `PermissionQueue` delegates to
// (Wave D.2, issue #144/#145/#146/#147) — a consumer that cannot safely
// extend `node:events` (a browser bundle) uses these functions directly to
// build its own reactive queue store over the exact same FIFO/nested-
// visibility/cancel-all rules, instead of re-implementing them.
export {
  cancelAllPermissionRequests,
  createPermissionQueueState,
  enqueuePermissionRequest,
  headPermissionRequest,
  isPermissionRequestActionable,
  listPermissionRequests,
  resolvePermissionRequest,
} from './permission-queue-state';
export type { PermissionQueueState } from './permission-queue-state';

// v1: config-option (model/mode/reasoning-effort) state (SPEC.md §7.24;
// issue #179).
export { ConfigOptionStore } from './config-options';
export type { ConfigOptionChangeEvent } from './config-options';
export type { AcpConfigOption, AcpConfigOptionChoice } from './types';

// v1: the provider-module registry + enrich() hook extension point
// (SPEC.md §5.5; issue #181).
export { ProviderRegistry, RESERVED_PROVIDER_IDS } from './provider-registry';
export type { AcpProviderModule } from './provider-registry';

// v1: image hand-off content blocks + shared magic-byte sniffing (SPEC.md
// §7.25; issues #157/#159).
export { IMAGE_EXTENSION_BY_MIME_TYPE, sniffImageMimeType } from './image';
export type { SniffedImageMimeType } from './image';
export type { AcpImageContentBlock, AcpResourceLinkContentBlock } from './types';

// v1: configured MCP servers fed into `session/new` (SPEC.md §7.7; issue
// #190).
export type {
  AcpMcpHttpServerConfig,
  AcpMcpKeyValue,
  AcpMcpServerConfig,
  AcpMcpSseServerConfig,
  AcpMcpStdioServerConfig,
} from './types';

// v1: the MCP server configuration data model — parser/validator for a raw
// user config into the typed `McpServerConfig` list, the required-secrets
// declaration, and the global-plus-project-overrides merge algorithm
// (SPEC.md §7.7; issue #187).
export {
  McpServerConfigError,
  parseMcpServerConfig,
  parseMcpServerConfigList,
  requiredSecrets,
  requiredSecretsForList,
  resolveEffectiveMcpServers,
} from './mcp-config';
export type {
  McpHttpServerConfig,
  McpServerConfig,
  McpServerConfigRecord,
  McpServerVarDecl,
  McpSseServerConfig,
  McpStdioServerConfig,
} from './mcp-config';

// v1: the per-server MCP secret grant model — grant/revoke ACL plus the
// resolver that turns a declared `McpServerConfig` list into the
// `AcpMcpServerConfig` list `AcpClient.newSession` consumes, failing fast
// on an ungranted/missing secret (SPEC.md §7.7, §7.17; issue #189).
export { McpSecretGrantStore, resolveMcpServerConfigs } from './mcp-secret-grants';
