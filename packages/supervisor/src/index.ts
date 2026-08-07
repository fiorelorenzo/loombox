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

// v2: git-based checkpoint & rollback engine (SPEC §7.20; issue #266), and
// its filesystem-snapshot sibling for a project with no `.git` (issue
// #267) — same public surface and return shapes, so `@loombox/node`'s
// `NodeDaemon.getCheckpointStore` can hand a session either one (see
// `./git-checkpoint-store.ts`'s module doc comment). `isGitWorktree` is
// the probe that decision is made from.
export {
  GitCheckpointStore,
  CheckpointNotFoundError,
  DetachedHeadError,
  DirtySubmoduleError,
  isGitWorktree,
  NotAGitWorktreeError,
} from './git-checkpoint-store';
export type {
  GitCheckpoint,
  GitCheckpointStoreOptions,
  RestoreFileChange,
  RestorePreview,
  RestoreResult,
} from './git-checkpoint-store';
export {
  FsSnapshotCheckpointStore,
  MAX_FS_SNAPSHOT_BYTES,
  MAX_FS_SNAPSHOT_FILES,
  SnapshotTooLargeError,
} from './fs-snapshot-checkpoint-store';
export type { FsSnapshotCheckpointStoreOptions } from './fs-snapshot-checkpoint-store';
