import { z } from 'zod';
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
