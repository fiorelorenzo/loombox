/**
 * The browser-safe entry point of this package (`@loombox/providers-core/browser`).
 *
 * Everything here is pure logic — reducers, parsers, catalogs, types — with no
 * `node:` import anywhere in its module graph. The main barrel (`./index`) also
 * exports `AcpClient`, `PermissionQueue` and `ConfigOptionStore`, which extend
 * Node's `EventEmitter` and (for `AcpClient`) spawn the agent process, so a
 * client bundle importing the barrel pulls those in too.
 *
 * That is exactly the failure `permission-queue-state.ts`'s doc comment already
 * describes one layer down: `node:events` externalizes to an empty stub in a
 * client-side Vite build, so `class X extends EventEmitter {}` throws the moment
 * the module is evaluated. A production `vite build` hides it — Rollup
 * tree-shakes the unused classes away — but `vite dev` evaluates every module it
 * serves, so the web app died on hydration with
 * `Cannot access "node:events.EventEmitter" in client code`, ~5s after painting
 * a perfectly healthy-looking page.
 *
 * So the split that already existed per-module now exists at the entry point:
 * browser code imports this, Node code imports the barrel. Adding a `node:`
 * import to any module re-exported below re-breaks the client, which is the
 * point — it belongs behind the barrel instead.
 */

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
  CONTEXT_NEAR_LIMIT_THRESHOLD,
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
export type {
  AcpAvailableCommandsUpdateEvent,
  AcpConfigOptionsEvent,
  AcpConfigOptionUpdateEvent,
  AcpSessionLifecycleEvent,
  AcpSessionStatus,
  AcpSessionStatusEvent,
  AcpSessionWireEvent,
  AcpTurnEndedEvent,
  AcpTurnStartedEvent,
} from './types';
export type { AcpSessionSummary } from './types';
export { deriveFeatureFlags } from './capabilities';
export type { AcpFeatureFlags } from './capabilities';
export type { AcpAgentCapabilities, AcpPromptCapabilities } from './types';
export type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionOutcome,
  AcpRequestPermissionParams,
} from './types';
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
export type { AcpConfigOption, AcpConfigOptionChoice } from './types';
export type { AcpAvailableCommand, AcpAvailableCommandInput } from './types';
export { ProviderRegistry, RESERVED_PROVIDER_IDS } from './provider-registry';
export type { AcpProviderModule } from './provider-registry';
export { IMAGE_EXTENSION_BY_MIME_TYPE, sniffImageMimeType } from './image';
export type { SniffedImageMimeType } from './image';
export type { AcpImageContentBlock, AcpResourceLinkContentBlock } from './types';
export type {
  AcpMcpHttpServerConfig,
  AcpMcpKeyValue,
  AcpMcpServerConfig,
  AcpMcpSseServerConfig,
  AcpMcpStdioServerConfig,
} from './types';
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
export {
  McpSecretGrantStore,
  McpServerSecretMissingError,
  resolveMcpServerConfigs,
} from './mcp-secret-grants';
export { MCP_SERVER_PRESET_CATALOG, instantiateMcpPreset } from './mcp-presets';
export type { McpServerPreset } from './mcp-presets';
export {
  PluginConfigError,
  parsePluginConfig,
  parsePluginConfigList,
  resolveEffectivePlugins,
} from './plugin-config';
export type { PluginConfig, PluginConfigRecord } from './plugin-config';
export type {
  EnqueuePermissionRequestInput,
  PendingPermissionRequest,
  PermissionResolveResult,
} from './permission-queue-state';

// v1: Zod validation for the ACP-native half of `AcpSessionWireEvent` plus
// the `permission_request` payload (SPEC.md §7.24; issue #593). Used by
// `apps/web`'s `relay-client.ts` to parse (not cast) a decrypted
// `session_update`/`permission_request` envelope before it reaches the
// transcript reducer.
export {
  acpPermissionRequestPayloadSchema,
  acpToolCallUpdateSchema,
  acpTranscriptUpdateSchema,
} from './acp-wire-schema';
