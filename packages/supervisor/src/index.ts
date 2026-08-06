export const PACKAGE_NAME = '@loombox/supervisor';

export { AgentSession } from './agent-session';
export type { AgentSessionSpawnOptions, ToolProfileDenial } from './agent-session';
export { AgentSupervisor, DEFAULT_PROVIDER_REQUIREMENTS } from './agent-supervisor';
export type { AgentSupervisorOptions, AgentSupervisorStartOptions } from './agent-supervisor';

// v1: attachment resolution over the existing node-to-supervisor control
// channel (SPEC §7.25; issue #156).
export type { AttachmentChannel } from './attachment-channel';

// v1: on-disk resumable transcript + attention state (SPEC.md §5.6, §7.22,
// §7.24; issues #77/#78/#79).
export { TranscriptStore, TRANSCRIPT_SCHEMA_VERSION, defaultStateDir } from './transcript-store';
export type {
  AttentionState,
  AttentionStatus,
  SessionMetaFile,
  TranscriptLogEntry,
  TranscriptStoreOptions,
} from './transcript-store';

// v1: interactive PTY terminals (SPEC §7.5; issues #172/#173/#174).
export { TerminalSession, TerminalSupervisor, defaultPtySpawn } from './terminal-supervisor';
export type {
  PtyLike,
  PtySpawnFn,
  TerminalExitEvent,
  TerminalSpawnOptions,
} from './terminal-supervisor';

// v2: git-based checkpoint & rollback engine (SPEC §7.20; issue #266). No
// AgentSupervisor/AgentSession wiring or wire-protocol surface yet — see
// `./git-checkpoint-store.ts`'s module doc comment for why.
export {
  GitCheckpointStore,
  CheckpointNotFoundError,
  DetachedHeadError,
  DirtySubmoduleError,
  NotAGitWorktreeError,
} from './git-checkpoint-store';
export type {
  GitCheckpoint,
  GitCheckpointStoreOptions,
  RestorePreview,
  RestoreResult,
} from './git-checkpoint-store';
