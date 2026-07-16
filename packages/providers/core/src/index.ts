export const PACKAGE_NAME = '@loombox/providers-core';

export { AcpClient } from './client';
export type { AcpChildProcess } from './client';
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
