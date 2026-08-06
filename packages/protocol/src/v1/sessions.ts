import { z } from 'zod';
import { customAgentRecordV1 } from './custom-agent';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The session-metadata boundary Lorenzo approved (`docs/v1-plan.md`,
 * SPEC §8's "bridge" bullet): only these fields are clear, relay-indexable
 * routing metadata (id, node/target routing, `accountId` for the
 * `owner_account_id` scoping filter, provider, timestamps, resync `seq`).
 * `title` and `projectPath` are NEVER in this schema — they travel only
 * inside the paired `encryptedEnvelope` below, opaque to the relay.
 */
export const sessionMetaPublic = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  accountId: z.string().min(1),
  provider: z.string().min(1),
  createdAt: z.number(),
  seq: z.number().int().nonnegative().optional(),
});
export type SessionMetaPublic = z.infer<typeof sessionMetaPublic>;

/** `SessionMetaPublic` plus its paired encrypted envelope, which decrypts to `{ title, projectPath }`. */
export const sessionWithPrivateEnvelope = z.object({
  session: sessionMetaPublic,
  privateEnvelope: encryptedEnvelope,
});
export type SessionWithPrivateEnvelope = z.infer<typeof sessionWithPrivateEnvelope>;

/**
 * The plaintext a session's private envelope decrypts to — the other half of
 * the boundary {@link sessionMetaPublic} describes. Defined here, once,
 * because both ends of the wire have to agree on it: `@loombox/node` seals it
 * in `session_announce` and opens it out of `session_create`, and `apps/web`
 * does the mirror image. Before this schema existed each side carried its own
 * hand-written `SessionPrivateMeta` interface and nothing checked they matched.
 *
 * The relay never sees any of this; it routes on {@link sessionMetaPublic}
 * alone (SPEC §8).
 */
export const sessionPrivateMetaV1 = z.object({
  title: z.string(),
  projectPath: z.string(),
  /**
   * SPEC §7.1's per-session choice: isolate this session in a fresh git
   * worktree (`true`) or run directly in `projectPath` (`false`). Omitted
   * means "no opinion" and the node applies its per-target default, which is
   * what every client sent before this field existed — `local` isolates,
   * `ssh:` works in place (`CreateNodeSessionOptions.worktree`).
   *
   * Optional on purpose, and it must stay that way: the relay drops frames
   * that fail schema validation without reporting a version mismatch, so a
   * field made required here would silently break every peer that predates
   * it. Only meaningful when the folder is a git repo (SPEC §6).
   */
  worktree: z.boolean().optional(),
  /**
   * D1-3's per-project custom agent (`docs/superpowers/specs/
   * 2026-08-05-zed-parity-decisions.md` §4; issue #748), present only when
   * `session_create`'s `provider` is the `'custom'` sentinel. Carried here,
   * inside the SAME encrypted envelope as `title`/`projectPath` — never in
   * the clear `sessionCreate.provider`/`sessionMetaPublic.provider` fields
   * — so the record (a binary name, args, env) is opaque to the relay
   * exactly like every other piece of session-private metadata. Optional
   * for the same versioning reason `worktree` is: an older peer that has
   * never heard of this field must keep parsing every other session
   * unchanged rather than failing closed on it.
   */
  customAgent: customAgentRecordV1.optional(),
  /**
   * Set only on a `session_fork_request`'s envelope (design spec
   * `2026-08-05-zed-parity-decisions.md` §3's C6-2; issue #746): the turn
   * (inclusive) the new session's copied transcript ends at. Absent on an
   * ordinary `session_create` — same "optional so an older peer keeps
   * parsing every other field unchanged" rule `worktree`/`customAgent`
   * above already establish.
   */
  forkFromTurnId: z.string().min(1).optional(),
});
export type SessionPrivateMetaV1 = z.infer<typeof sessionPrivateMetaV1>;

/** Parses and validates a decrypted session private envelope, throwing on an invalid one. */
export function parseSessionPrivateMetaV1(data: unknown): SessionPrivateMetaV1 {
  return sessionPrivateMetaV1.parse(data);
}

/** Same as {@link parseSessionPrivateMetaV1} but never throws; returns zod's result. */
export function safeParseSessionPrivateMetaV1(
  data: unknown,
): z.SafeParseReturnType<unknown, SessionPrivateMetaV1> {
  return sessionPrivateMetaV1.safeParse(data);
}

/** A client asks a node to start a new session on one of its targets. */
export const sessionCreate = z.object({
  type: z.literal('session_create'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  targetId: z.string().min(1),
  provider: z.string().min(1),
  privateEnvelope: encryptedEnvelope,
});
export type SessionCreate = z.infer<typeof sessionCreate>;

/** A node tells the relay a session exists (the v1 counterpart of v0's `session_announce`, split per the boundary above). */
export const sessionAnnounceV1 = z.object({
  type: z.literal('session_announce'),
  protocolVersion: z.literal(PROTOCOL_V1),
  session: sessionMetaPublic,
  privateEnvelope: encryptedEnvelope,
});
export type SessionAnnounceV1 = z.infer<typeof sessionAnnounceV1>;

/** A client (re)attaches to an existing session, e.g. on reconnect (SPEC §7.22). */
export const sessionResume = z.object({
  type: z.literal('session_resume'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
});
export type SessionResume = z.infer<typeof sessionResume>;

/** A client asks the relay for its account-scoped session snapshot (SPEC §8's OAuth-alone listing). */
export const sessionListRequest = z.object({
  type: z.literal('session_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
});
export type SessionListRequest = z.infer<typeof sessionListRequest>;

/**
 * The relay's snapshot of the caller's sessions: `SessionMetaPublic[]` plus
 * each session's encrypted-title envelope (v1 counterpart of v0's
 * `session_list`, split per the metadata boundary).
 */
export const sessionListV1 = z.object({
  type: z.literal('session_list'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessions: z.array(sessionWithPrivateEnvelope),
});
export type SessionListV1 = z.infer<typeof sessionListV1>;
