import { z } from 'zod';
import { base64String, encryptedEnvelope } from './envelope';
import { PROTOCOL_V1 } from './handshake';

/**
 * Interactive PTY terminals (SPEC §7.5; issues #172/#173/#174). Exactly like
 * `fs.ts`'s directory listings and `steering.ts`'s prompts/permissions,
 * terminal bytes are PRIVATE session content (SPEC §8's metadata boundary):
 * stdin typed by the user, stdout/stderr produced by the shell, and even the
 * negotiated cols/rows all travel ONLY inside an `encryptedEnvelope`, sealed/
 * opened with `@loombox/crypto`'s `sealJson`/`openJson` under the session's
 * derived key. Every wire message below carries only clear ROUTING metadata —
 * `sessionId` + `terminalId` (and, for `terminal_open`, `targetId` +
 * `requestId`, mirroring `fsListRequest`'s own convention) — never a byte of
 * terminal content; the relay only ever forwards the opaque envelope
 * (`packages/relay/src/relay.ts` routes a client's `terminal_open`/
 * `terminal_input`/`terminal_resize`/`terminal_close` to the owning node
 * exactly like `prompt_inject`/`fs_list_request`, and fans a node's
 * `terminal_opened`/`terminal_output`/`terminal_closed` out to a session's
 * subscribed clients exactly like `fs_list_response`/`permission_request` —
 * it never inspects any of these envelopes' plaintext).
 *
 * Keyed by `sessionId` + `terminalId` throughout (not just `sessionId`) so a
 * single session can host more than one open terminal at once, all sharing
 * that session's working directory/worktree (issue #173) — `terminalId` is a
 * client-generated opaque id, scoped to its session, with no further
 * structure this package cares about.
 *
 * One request/reply pair (`terminal_open`/`terminal_opened`) establishes a
 * terminal, `terminal_input`/`terminal_output` stream bytes in each
 * direction for as long as it's open, `terminal_resize` renegotiates the PTY
 * window size, and `terminal_close`/`terminal_closed` tear it down — either
 * because the client asked to close it, or because the underlying shell
 * exited on its own (SPEC §16 grounding: message shape modeled clean-room on
 * hapi's `terminal.ts`'s create/write/resize/close vocabulary, AGPL, design
 * reference only, no code copied; keyed by session+terminalId per that same
 * reference).
 */

/** The plaintext a `terminal_open` envelope decrypts to: the PTY's initial window size. */
export const terminalOpenPayloadV1 = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalOpenPayloadV1 = z.infer<typeof terminalOpenPayloadV1>;

/** A successful terminal_open. */
export const terminalOpenOkV1 = z.object({
  outcome: z.literal('ok'),
});
export type TerminalOpenOkV1 = z.infer<typeof terminalOpenOkV1>;

/** A failed terminal_open (no shell/PTY available on the target, spawn failure, ...) — carried as a payload variant, mirroring `fsListErrorV1`, so the client can show a legible failure rather than hang waiting for a reply that never comes. */
export const terminalOpenErrorV1 = z.object({
  outcome: z.literal('error'),
  message: z.string().min(1),
});
export type TerminalOpenErrorV1 = z.infer<typeof terminalOpenErrorV1>;

/** The plaintext a `terminal_opened` envelope decrypts to. */
export const terminalOpenResultPayloadV1 = z.discriminatedUnion('outcome', [
  terminalOpenOkV1,
  terminalOpenErrorV1,
]);
export type TerminalOpenResultPayloadV1 = z.infer<typeof terminalOpenResultPayloadV1>;

/**
 * The plaintext a `terminal_input`/`terminal_output` envelope decrypts to:
 * one chunk of raw terminal bytes, base64-encoded (JSON has no binary type,
 * exactly like every other binary field this package's wire schemas carry —
 * see `envelope.ts`'s own `base64String`). The same shape either direction:
 * a client only ever sends `terminal_input`, a node only ever sends
 * `terminal_output`, so the *message type* (not a field inside this payload)
 * is what disambiguates direction.
 */
export const terminalDataPayloadV1 = z.object({
  data: base64String,
});
export type TerminalDataPayloadV1 = z.infer<typeof terminalDataPayloadV1>;

/** The plaintext a `terminal_resize` envelope decrypts to: the PTY's renegotiated window size. */
export const terminalResizePayloadV1 = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResizePayloadV1 = z.infer<typeof terminalResizePayloadV1>;

/** Why a terminal closed: the client asked to close it, its shell exited on its own, or the node hit an error running/streaming it. */
export const terminalClosedReasonV1 = z.enum(['closed_by_client', 'exited', 'error']);
export type TerminalClosedReasonV1 = z.infer<typeof terminalClosedReasonV1>;

/** The plaintext a `terminal_closed` envelope decrypts to. */
export const terminalClosedPayloadV1 = z.object({
  reason: terminalClosedReasonV1,
  /** The shell's exit code, when `reason` is `'exited'` and one was observed. */
  exitCode: z.number().int().optional(),
  /** The signal that terminated the shell, if any (e.g. `'SIGHUP'`). */
  signal: z.string().optional(),
  /** A human-readable detail, mainly for `reason: 'error'`. */
  message: z.string().optional(),
});
export type TerminalClosedPayloadV1 = z.infer<typeof terminalClosedPayloadV1>;

/** Parses and validates a decrypted `terminal_open` payload, throwing on an invalid one. */
export function parseTerminalOpenPayloadV1(data: unknown): TerminalOpenPayloadV1 {
  return terminalOpenPayloadV1.parse(data);
}

/** Same as {@link parseTerminalOpenPayloadV1} but never throws; returns zod's result. */
export function safeParseTerminalOpenPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TerminalOpenPayloadV1> {
  return terminalOpenPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `terminal_opened` payload, throwing on an invalid one. */
export function parseTerminalOpenResultPayloadV1(data: unknown): TerminalOpenResultPayloadV1 {
  return terminalOpenResultPayloadV1.parse(data);
}

/** Same as {@link parseTerminalOpenResultPayloadV1} but never throws; returns zod's result. */
export function safeParseTerminalOpenResultPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TerminalOpenResultPayloadV1> {
  return terminalOpenResultPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `terminal_input`/`terminal_output` payload, throwing on an invalid one. */
export function parseTerminalDataPayloadV1(data: unknown): TerminalDataPayloadV1 {
  return terminalDataPayloadV1.parse(data);
}

/** Same as {@link parseTerminalDataPayloadV1} but never throws; returns zod's result. */
export function safeParseTerminalDataPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TerminalDataPayloadV1> {
  return terminalDataPayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `terminal_resize` payload, throwing on an invalid one. */
export function parseTerminalResizePayloadV1(data: unknown): TerminalResizePayloadV1 {
  return terminalResizePayloadV1.parse(data);
}

/** Same as {@link parseTerminalResizePayloadV1} but never throws; returns zod's result. */
export function safeParseTerminalResizePayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TerminalResizePayloadV1> {
  return terminalResizePayloadV1.safeParse(data);
}

/** Parses and validates a decrypted `terminal_closed` payload, throwing on an invalid one. */
export function parseTerminalClosedPayloadV1(data: unknown): TerminalClosedPayloadV1 {
  return terminalClosedPayloadV1.parse(data);
}

/** Same as {@link parseTerminalClosedPayloadV1} but never throws; returns zod's result. */
export function safeParseTerminalClosedPayloadV1(
  data: unknown,
): z.SafeParseReturnType<unknown, TerminalClosedPayloadV1> {
  return terminalClosedPayloadV1.safeParse(data);
}

/**
 * A client asks the owning node to open a new PTY terminal on one of its
 * sessions' targets (SPEC §7.5). Routed exactly like `fs_list_request`
 * (`relay.ts`'s `routeToOwningNode`) — `sessionId` alone is enough to find
 * the owning node; `targetId` rides along as clear routing metadata too
 * (mirroring `fsListRequest`'s convention) though the relay does not need it
 * to route this message. `terminalId` is chosen by the client so it can
 * address this same terminal in every later `terminal_input`/
 * `terminal_resize`/`terminal_close`.
 */
export const terminalOpen = z.object({
  type: z.literal('terminal_open'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  targetId: z.string().min(1),
  terminalId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TerminalOpen = z.infer<typeof terminalOpen>;

/**
 * The owning node's reply to `terminal_open`. Fanned out to a session's
 * subscribed clients exactly like `fs_list_response` (`relay.ts`'s
 * `fanOutDirect`) — a requesting client matches its own pending request by
 * `requestId`; any other subscribed client simply has no pending request
 * with that id and ignores it.
 */
export const terminalOpened = z.object({
  type: z.literal('terminal_opened'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  requestId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TerminalOpened = z.infer<typeof terminalOpened>;

/** A client streams one chunk of typed input to an open terminal's stdin. Routed to the owning node exactly like `prompt_inject`. */
export const terminalInput = z.object({
  type: z.literal('terminal_input'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TerminalInput = z.infer<typeof terminalInput>;

/** The owning node streams one chunk of an open terminal's output. Fanned out to a session's subscribed clients exactly like `fs_list_response`. */
export const terminalOutput = z.object({
  type: z.literal('terminal_output'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TerminalOutput = z.infer<typeof terminalOutput>;

/** Either direction of the terminal byte stream, discriminated on `type` — a convenience union for code that handles both the same way (e.g. a wire-level byte-visibility test). */
export const terminalData = z.discriminatedUnion('type', [terminalInput, terminalOutput]);
export type TerminalData = z.infer<typeof terminalData>;

/** A client renegotiates an open terminal's PTY window size (e.g. the browser tab/pane was resized). Routed to the owning node exactly like `terminal_input`. */
export const terminalResize = z.object({
  type: z.literal('terminal_resize'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TerminalResize = z.infer<typeof terminalResize>;

/** A client asks the owning node to close an open terminal. No envelope: closing carries no content, only the id of what to close — mirroring `blob_download`'s own envelope-less shape. */
export const terminalClose = z.object({
  type: z.literal('terminal_close'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
});
export type TerminalClose = z.infer<typeof terminalClose>;

/** The owning node confirms a terminal has closed, whether by client request or because its shell exited on its own. Fanned out exactly like `terminal_opened`/`terminal_output`. */
export const terminalClosed = z.object({
  type: z.literal('terminal_closed'),
  protocolVersion: z.literal(PROTOCOL_V1),
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  envelope: encryptedEnvelope,
});
export type TerminalClosed = z.infer<typeof terminalClosed>;
