import { z } from 'zod';
import { encryptedEnvelope } from './envelope';
import { fsEntryV1 } from './fs';
import { PROTOCOL_V1 } from './handshake';

/**
 * The directory picker's wire pair (SPEC §7.25's directory-picker bullet;
 * issue #474): `DirectoryPicker.svelte`'s data source when a client is
 * choosing a `projectPath` to create a session on, either replacing
 * `NewSessionDialog`'s bare text input or driving its lazy tree browse.
 *
 * This is `fs.ts`'s `fs_list_request`/`fs_list_response` pair's sibling, not
 * a replacement — `fs_list_request` lists inside an EXISTING session's
 * project root and is keyed by `sessionId` (a node resolves the owning
 * target through `SessionBridge.targetId`). `target_fs_list_request` below
 * instead lets a client browse a target's filesystem BEFORE any session
 * exists there at all, so it has no `sessionId` to key off — it is keyed by
 * `nodeId` + `targetId` directly, the same "no existing resource resolves
 * this, address the node directly" convention `provisioning.ts`'s
 * `ProvisionTargetRequest` already uses for the zero-touch add-target
 * wizard (see that schema's doc comment) rather than `fs.ts`'s own
 * sessionId->node lookup. `targetId` is what a node needs to pick which of
 * its `ExecutionTarget`s (local or `ssh:`) to browse; `nodeId` is clear
 * routing metadata for the relay (`packages/relay/src/relay.ts` addresses
 * the owning connection directly by `nodeId`, exactly like
 * `provision_target_request`), mirroring `fs_list_request`'s own
 * "`targetId` rides along as clear routing metadata too" convention.
 *
 * Same crypto boundary as `fs.ts` (SPEC §8's metadata boundary; Lorenzo's
 * "full E2E" v1 stance): the requested path and the returned entries travel
 * ONLY inside an `encryptedEnvelope`, sealed/opened with `@loombox/crypto`'s
 * `sealJson`/`openJson` — but under a key derived from the AMK scoped to
 * `['target', accountId, targetId]` (`packages/node/src/node-daemon.ts`'s
 * `deriveTargetKey`, mirrored in `apps/web/src/lib/relay-client.ts`'s own
 * copy of the same derivation — see either doc comment for why this one
 * derivation lives in both call sites rather than `@loombox/crypto`), NOT
 * `fs.ts`'s session-derived key, since there is no session to derive from
 * yet. The relay only ever forwards the opaque envelope, exactly like
 * `fs_list_request`/`fs_list_response` — it never inspects either payload.
 */

/**
 * The plaintext a `target_fs_list_request` envelope decrypts to: the
 * directory to list on the target's own filesystem. Unlike
 * `fsListRequestPayloadV1`'s `path` (relative to a session's project root),
 * this one is NOT bounded to any root — browsing to PICK a project
 * directory means reaching anywhere the target can — so `''`/`'.'` instead
 * asks the node for ITS OWN notion of a sensible starting point (its home
 * directory; see `NodeDaemon.resolveTargetFsPath`'s doc comment), and any
 * other value is used as the target's own absolute path, enforced only by
 * whatever that target's filesystem permissions already allow.
 */
export const targetFsListRequestPayloadV1 = z.object({
  path: z.string(),
});
export type TargetFsListRequestPayloadV1 = z.infer<typeof targetFsListRequestPayloadV1>;

/** The successful outcome: `path`'s entries, directories first (`NodeDaemon.listDirectoryForTarget`'s sort) — the same `fsEntryV1` shape `fs.ts` uses, since one directory entry means the same thing on either wire pair. */
export const targetFsListResultV1 = z.object({
  outcome: z.literal('ok'),
  path: z.string(),
  entries: z.array(fsEntryV1),
});
export type TargetFsListResultV1 = z.infer<typeof targetFsListResultV1>;

/**
 * A failed listing (an unreadable/missing directory, a transport failure
 * against an `ssh:` target, ...) — carried as a payload variant rather than
 * simply never replying, exactly like `fsListErrorV1`'s own doc comment, so
 * the picker can show *something* rather than a silent hang.
 */
export const targetFsListErrorV1 = z.object({
  outcome: z.literal('error'),
  path: z.string(),
  message: z.string().min(1),
});
export type TargetFsListErrorV1 = z.infer<typeof targetFsListErrorV1>;

/** The plaintext a `target_fs_list_response` envelope decrypts to. */
export const targetFsListResponsePayloadV1 = z.discriminatedUnion('outcome', [
  targetFsListResultV1,
  targetFsListErrorV1,
]);
export type TargetFsListResponsePayloadV1 = z.infer<typeof targetFsListResponsePayloadV1>;

/** Parses and validates a decrypted `target_fs_list_request` payload, throwing on an invalid one. */
export function parseTargetFsListRequestPayloadV1(data: unknown): TargetFsListRequestPayloadV1 {
  return targetFsListRequestPayloadV1.parse(data);
}

/** Same as {@link parseTargetFsListRequestPayloadV1} but never throws; returns zod's result. */
export function safeParseTargetFsListRequestPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TargetFsListRequestPayloadV1> {
  return targetFsListRequestPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `target_fs_list_response` payload, throwing on an invalid one. */
export function parseTargetFsListResponsePayloadV1(data: unknown): TargetFsListResponsePayloadV1 {
  return targetFsListResponsePayloadV1.parse(data);
}

/** Same as {@link parseTargetFsListResponsePayloadV1} but never throws; returns zod's result. */
export function safeParseTargetFsListResponsePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TargetFsListResponsePayloadV1> {
  return targetFsListResponsePayloadV1.safeParse(data);
}

/**
 * A client asks a specific node to list a directory on one of its targets,
 * before any session exists there (SPEC §7.25; issue #474). Routed directly
 * by `nodeId`, scoped to the requester's account, exactly like
 * `provision_target_request` (`relay.ts`'s account-checked
 * `registry.nodeConnectionsByNodeId` lookup) rather than `fs_list_request`'s
 * sessionId->node resolution — see this module's doc comment.
 */
export const targetFsListRequest = z.object({
  type: z.literal('target_fs_list_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  nodeId: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TargetFsListRequest = z.infer<typeof targetFsListRequest>;

/**
 * The node's reply, delivered back to the requesting client only (there is
 * no session to fan this out to subscribers of, unlike `fs_list_response`)
 * — the relay matches it to its pending `target_fs_list_request` by
 * `requestId`. `targetId` rides along for the same reason `fs_list_response`
 * keeps `sessionId`: which scope this reply belongs to, even though
 * `requestId` alone is what the relay/client actually key their pending-
 * request lookup on.
 */
export const targetFsListResponse = z.object({
  type: z.literal('target_fs_list_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TargetFsListResponse = z.infer<typeof targetFsListResponse>;
