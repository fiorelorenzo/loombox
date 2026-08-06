import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * The read-only file-tree panel + `@file` picker (SPEC §7.4, §7.25's `@file
 * references` bullet; issues #171/#160). A directory listing is PRIVATE
 * metadata exactly like a session title/`projectPath` (SPEC §8's metadata
 * boundary): the requested path and the returned entries travel ONLY inside
 * an `encryptedEnvelope`, sealed/opened with `@loombox/crypto`'s `sealJson`/
 * `openJson` under the session's derived key, precisely like every session-
 * lifecycle event (`session-events.ts`'s doc comment) and the transcript
 * itself. The two wire messages below (`fsListRequest`/`fsListResponse`)
 * carry only clear ROUTING metadata — `sessionId` (and, for the request,
 * `targetId`, mirroring `sessionCreate`'s own routing-field convention) plus
 * `requestId` to correlate a reply — never a path string; the relay only
 * ever forwards the opaque envelope (`packages/relay/src/relay.ts` routes
 * `fs_list_request` to the owning node exactly like `prompt_inject`/
 * `config_option`, and fans `fs_list_response` out to a session's subscribed
 * clients exactly like `blob_ref`/`permission_request` — it never inspects
 * either envelope's plaintext).
 *
 * This is this package's own invention layered on top of the node's
 * `ExecutionTarget` filesystem primitives (`packages/node/src/target.ts`),
 * not an ACP passthrough — so, like `session-events.ts`, it is this
 * package's job to be the one validated source of truth for the inner
 * payload shape, imported directly by both `@loombox/node` (which seals it)
 * and `apps/web` (which opens it), rather than mirrored across the
 * encryption boundary the way an ACP-owned or node-private shape is
 * elsewhere in this codebase.
 */

/** One directory entry's kind. `ExecutionTarget.readdirDetailed` additionally distinguishes an "other" filesystem object (socket, device, ...); the wire never needs that distinction — a node maps it to `'file'` before sealing (SPEC §7.4 only needs to render as a file or a directory). */
export const fsEntryKindV1 = z.enum(['file', 'dir', 'symlink']);
export type FsEntryKindV1 = z.infer<typeof fsEntryKindV1>;

/** One entry in a directory listing. `size` is bytes; `0` for a directory. */
export const fsEntryV1 = z.object({
  name: z.string().min(1),
  kind: fsEntryKindV1,
  size: z.number().int().nonnegative(),
});
export type FsEntryV1 = z.infer<typeof fsEntryV1>;

/**
 * The plaintext an `fs_list_request` envelope decrypts to: the directory to
 * list, relative to the session's project root — `''` (or `'.'`) for the
 * root itself. Never an absolute path or one that escapes the root; the
 * node enforces that (`packages/node/src/node-daemon.ts`'s path-traversal
 * guard), this schema only validates shape.
 */
export const fsListRequestPayloadV1 = z.object({
  path: z.string(),
});
export type FsListRequestPayloadV1 = z.infer<typeof fsListRequestPayloadV1>;

/** The successful outcome: `path`'s entries. */
export const fsListResultV1 = z.object({
  outcome: z.literal('ok'),
  path: z.string(),
  entries: z.array(fsEntryV1),
});
export type FsListResultV1 = z.infer<typeof fsListResultV1>;

/**
 * A failed listing (path traversal refused, not found, not a directory, a
 * transport failure against an `ssh:` target, ...) — carried as a payload
 * variant rather than simply never replying, so the picker/tree UI can show
 * *something* rather than a silent hang (SPEC §7.4's "read-only" scope still
 * expects a legible failure).
 */
export const fsListErrorV1 = z.object({
  outcome: z.literal('error'),
  path: z.string(),
  message: z.string().min(1),
});
export type FsListErrorV1 = z.infer<typeof fsListErrorV1>;

/** The plaintext an `fs_list_response` envelope decrypts to. */
export const fsListResponsePayloadV1 = z.discriminatedUnion('outcome', [
  fsListResultV1,
  fsListErrorV1,
]);
export type FsListResponsePayloadV1 = z.infer<typeof fsListResponsePayloadV1>;

/** Parses and validates a decrypted `fs_list_request` payload, throwing on an invalid one. */
export function parseFsListRequestPayloadV1(data: unknown): FsListRequestPayloadV1 {
  return fsListRequestPayloadV1.parse(data);
}

/** Same as {@link parseFsListRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseFsListRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, FsListRequestPayloadV1> {
  return fsListRequestPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `fs_list_response` payload, throwing on an invalid one. */
export function parseFsListResponsePayloadV1(data: unknown): FsListResponsePayloadV1 {
  return fsListResponsePayloadV1.parse(data);
}

/** Same as {@link parseFsListResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseFsListResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, FsListResponsePayloadV1> {
  return fsListResponsePayloadV1.safeParse(data);
}

/**
 * A client asks the owning node to list a directory inside one of its
 * sessions' projects (SPEC §7.4). Routed exactly like `prompt_inject`/
 * `config_option` (`relay.ts`'s `routeToOwningNode`) — `sessionId` alone is
 * enough to find the owning node; `targetId` rides along as clear routing
 * metadata too (mirroring `sessionCreate`'s convention) though the relay
 * does not need it to route this message.
 */
export const fsListRequest = z.object({
  type: z.literal('fs_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type FsListRequest = z.infer<typeof fsListRequest>;

/**
 * The owning node's reply. Fanned out to a session's subscribed clients
 * exactly like `blob_ref`/`permission_request` (`relay.ts`'s `fanOutDirect`)
 * — a requesting client filters on `requestId` to match its own pending
 * request; any other subscribed client simply has no pending request with
 * that id and ignores it.
 */
export const fsListResponse = z.object({
  type: z.literal('fs_list_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type FsListResponse = z.infer<typeof fsListResponse>;

/**
 * The read-only file VIEWER's own wire pair (SPEC §7.4's sibling; issue
 * #737 — "the file tree can only insert a mention, the only place a
 * file's content ever renders is inside whatever edit/diff card the agent
 * itself produces"). Same crypto/routing boundary as `fs_list_request`/
 * `fs_list_response` above — sealed under the session's derived key,
 * routed to the owning node by `sessionId` alone (`relay.ts`'s
 * `routeToOwningNode`), fanned back out to every subscribed client
 * (`fanOutDirect`) — because a file's full text is exactly as private as
 * its directory listing, no new boundary to reason about.
 *
 * Deliberately a one-shot request-per-open, never a live subscription:
 * C5-1 (`docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §3)
 * settled the Files panel as "a browsing tool, deliberately not a live
 * view of the agent" — the viewer this backs is that same read-only
 * snapshot contract, not a file watcher. A client re-sends
 * `fs_read_request` (a fresh `requestId`) to refresh; nothing here pushes
 * an update on its own.
 */

/**
 * The plaintext an `fs_read_request` envelope decrypts to: the file to
 * read, relative to the session's project root — never absolute, never
 * one that escapes the root (the node enforces that, same guard
 * `fs_list_request` already gets; this schema only validates shape).
 */
export const fsReadRequestPayloadV1 = z.object({
  path: z.string(),
});
export type FsReadRequestPayloadV1 = z.infer<typeof fsReadRequestPayloadV1>;

/**
 * The successful outcome: `path`'s full text content. `truncated` is
 * `true` when the node cut the file off at its own size cap
 * (`NodeDaemon`'s `MAX_FS_READ_BYTES`) — the viewer renders what it got
 * plus a visible "truncated" notice, never a silently incomplete file
 * that reads as whole.
 */
export const fsReadResultV1 = z.object({
  outcome: z.literal('ok'),
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});
export type FsReadResultV1 = z.infer<typeof fsReadResultV1>;

/**
 * A failed read (path traversal refused, not found, a directory, binary
 * content the viewer can't usefully show as text, a transport failure
 * against an `ssh:` target, ...) — carried as a payload variant rather
 * than simply never replying, exactly like `fsListErrorV1`.
 */
export const fsReadErrorV1 = z.object({
  outcome: z.literal('error'),
  path: z.string(),
  message: z.string().min(1),
});
export type FsReadErrorV1 = z.infer<typeof fsReadErrorV1>;

/** The plaintext an `fs_read_response` envelope decrypts to. */
export const fsReadResponsePayloadV1 = z.discriminatedUnion('outcome', [
  fsReadResultV1,
  fsReadErrorV1,
]);
export type FsReadResponsePayloadV1 = z.infer<typeof fsReadResponsePayloadV1>;

/** Parses and validates a decrypted `fs_read_request` payload, throwing on an invalid one. */
export function parseFsReadRequestPayloadV1(data: unknown): FsReadRequestPayloadV1 {
  return fsReadRequestPayloadV1.parse(data);
}

/** Same as {@link parseFsReadRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseFsReadRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, FsReadRequestPayloadV1> {
  return fsReadRequestPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `fs_read_response` payload, throwing on an invalid one. */
export function parseFsReadResponsePayloadV1(data: unknown): FsReadResponsePayloadV1 {
  return fsReadResponsePayloadV1.parse(data);
}

/** Same as {@link parseFsReadResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseFsReadResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, FsReadResponsePayloadV1> {
  return fsReadResponsePayloadV1.safeParse(data);
}

/**
 * A client asks the owning node to read one file inside one of its
 * sessions' projects (issue #737). Routed exactly like `fs_list_request`
 * (`relay.ts`'s `routeToOwningNode`) — `sessionId` alone is enough to find
 * the owning node; `targetId` rides along as clear routing metadata too,
 * same convention.
 */
export const fsReadRequest = z.object({
  type: z.literal('fs_read_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type FsReadRequest = z.infer<typeof fsReadRequest>;

/**
 * The owning node's reply. Fanned out to a session's subscribed clients
 * exactly like `fs_list_response` — a requesting client filters on
 * `requestId` to match its own pending request; any other subscribed
 * client simply has no pending request with that id.
 */
export const fsReadResponse = z.object({
  type: z.literal('fs_read_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type FsReadResponse = z.infer<typeof fsReadResponse>;
