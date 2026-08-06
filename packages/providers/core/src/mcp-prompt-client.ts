/* ---------------------------------------------------------------------
 * A minimal, one-shot MCP (Model Context Protocol) client (Zed-parity D5-2;
 * issue #754) — reads a server's declared prompts and, later, renders one.
 * Deliberately NOT part of `AcpClient`: the connected ACP agent is the one
 * that owns the "real" MCP connection each session actually uses for tool
 * calls (`session/new`'s `mcpServers` param), and — verified directly
 * against a real `omp acp` binary (v17.2.9) — that connection's prompt
 * catalogue is never forwarded onto ACP's own `available_commands_update`;
 * an agent's declared commands and an MCP server's declared prompts are
 * two disjoint sets on the wire today. So the only way to surface an MCP
 * prompt as a `/`-command at all is for loombox itself to speak MCP
 * independently, exactly like Zed does — this module is that client,
 * connecting a second time (redundant with the agent's own connection, but
 * there is no visibility into that one) purely to ask `prompts/list`/
 * `prompts/get`, never to declare tools or handle a call.
 *
 * Hand-rolled JSON-RPC rather than a dependency on `@modelcontextprotocol/
 * sdk`, matching this package's own `client.ts` convention for its ACP
 * client — the wire shape needed here (`initialize`, `notifications/
 * initialized`, `prompts/list`, `prompts/get`) is a small, stable subset,
 * hand-verified against a real reference server (`@modelcontextprotocol/
 * server-everything`, both its `stdio` and `streamableHttp` transports —
 * see `mcp-prompt-client.test.ts`'s own doc comment and this issue's PR).
 *
 * Node-only (spawns child processes for `stdio`) — exported from
 * `index.ts`, never from `browser.ts`.
 * --------------------------------------------------------------------- */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AcpMcpServerConfig } from './types';

/** One argument an MCP prompt declared (MCP's own `PromptArgument` shape). */
export interface McpPromptArgumentSpec {
  name: string;
  description?: string;
  required?: boolean;
}

/** One prompt one MCP server declared via `prompts/list`, verbatim — never the rendered content (that's `prompts/get`, see {@link fetchMcpPromptText}). */
export interface McpDiscoveredPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgumentSpec[];
}

/** One server's discovered prompt catalogue, keyed by its own configured name. */
export interface McpServerPromptsResult {
  name: string;
  prompts: McpDiscoveredPrompt[];
}

/** Shared timeout for every MCP round trip this module makes (connect + `initialize` + one call) — generous enough for an `npx`/`uvx`-fetched server's first cold start, bounded so one slow/unreachable server never stalls the others past this. */
const DEFAULT_MCP_TIMEOUT_MS = 15_000;

export interface McpPromptClientOptions {
  timeoutMs?: number;
}

/** Thrown for any failure this module can't recover from on its own — a bad spawn, a timed-out handshake, a JSON-RPC error reply. Callers that want per-server resilience (issue #754's "an unreachable server does not break the list for the others") catch this at the per-server boundary, not inside this module. */
export class McpPromptClientError extends Error {
  constructor(
    message: string,
    readonly serverName: string,
  ) {
    super(message);
    this.name = 'McpPromptClientError';
  }
}

/**
 * Reads every server's own `prompts/list` (issue #754's discovery half),
 * one independent connection per server, all in parallel. A server that
 * fails to connect, times out, or has no `prompts` capability at all
 * (a JSON-RPC "Method not found" on `prompts/list`, the ordinary shape for
 * a server that just doesn't support prompts) is silently excluded —
 * logged nowhere, since "this server has no prompts" is not a failure, and
 * a genuine connection failure here is not this session's `mcp_server_
 * status` concern either (that event already covers the ACP agent's own
 * launch attempt; this is a second, independent connection this module
 * owns end to end). A server whose own `prompts/list` succeeds but returns
 * zero prompts is excluded from the result too, matching this issue's "a
 * server with no prompts adds nothing to the list" acceptance line at the
 * source rather than relying on every caller to filter it out again.
 */
export async function fetchMcpServerPrompts(
  servers: readonly AcpMcpServerConfig[],
  opts: McpPromptClientOptions = {},
): Promise<McpServerPromptsResult[]> {
  const settled = await Promise.allSettled(
    servers.map(async (server) => ({
      name: server.name,
      prompts: await listPrompts(server, opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS),
    })),
  );
  const results: McpServerPromptsResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && outcome.value.prompts.length > 0) {
      results.push(outcome.value);
    }
  }
  return results;
}

/**
 * Renders one prompt via a fresh `prompts/get` call (issue #754's send
 * half) — the actual message text a caller sends as the user's turn.
 * `args` is already resolved by the caller against that prompt's own
 * declared argument names (this module never guesses a mapping from free
 * text). Every text content block across every returned message is joined
 * with a blank line between them (the common case is exactly one `user`
 * message with one text block — verified against `@modelcontextprotocol/
 * server-everything`'s own reference prompts); a non-text block (image,
 * embedded resource — MCP prompts can carry either) is skipped rather than
 * stringified, since there is nothing sensible to send as plain prompt
 * text for it and D5-3 (resources) is explicitly out of scope for this
 * issue. Throws {@link McpPromptClientError} on any failure — connect,
 * timeout, or the server's own rejection (e.g. a missing required
 * argument) — for the caller to fall back on (see `+page.svelte`'s
 * `resolveMcpPromptSend`).
 */
export async function fetchMcpPromptText(
  server: AcpMcpServerConfig,
  promptName: string,
  args: Readonly<Record<string, string>>,
  opts: McpPromptClientOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const result = await withTimeout(
    withMcpSession(server, timeoutMs, (call) =>
      call('prompts/get', { name: promptName, arguments: args }),
    ),
    timeoutMs,
    server.name,
  );
  const messages = isPlainObject(result) && Array.isArray(result.messages) ? result.messages : [];
  const text = messages
    .map((message) => extractText(isPlainObject(message) ? message.content : undefined))
    .filter((chunk): chunk is string => chunk !== undefined)
    .join('\n\n');
  if (!text) {
    throw new McpPromptClientError(
      `MCP server "${server.name}" prompt "${promptName}" rendered no text content`,
      server.name,
    );
  }
  return text;
}

function extractText(content: unknown): string | undefined {
  if (isPlainObject(content) && content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  return undefined;
}

/** This module's single canonical "is a plain JSON object" guard (mirrors `mcp-config.ts`/`plugin-config.ts`'s own module-local `isPlainObject` — this package has no shared type-guard module to import one from, and MCP wire replies are deliberately not zod-validated here: `providers-core` has zero workspace dependencies by design, `@loombox/protocol`'s schemas live one layer up). Every field read off the result stays individually `typeof`/`Array.isArray`-checked below — this only proves "an object", never a specific shape. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function listPrompts(
  server: AcpMcpServerConfig,
  timeoutMs: number,
): Promise<McpDiscoveredPrompt[]> {
  const result = await withTimeout(
    withMcpSession(server, timeoutMs, (call) => call('prompts/list', {})),
    timeoutMs,
    server.name,
  );
  if (!isPlainObject(result) || !Array.isArray(result.prompts)) return [];
  return result.prompts.filter(isPlainObject).map((prompt) => ({
    name: String(prompt.name),
    description: typeof prompt.description === 'string' ? prompt.description : undefined,
    arguments: Array.isArray(prompt.arguments)
      ? prompt.arguments.filter(isPlainObject).map((arg) => ({
          name: String(arg.name),
          description: typeof arg.description === 'string' ? arg.description : undefined,
          required: typeof arg.required === 'boolean' ? arg.required : undefined,
        }))
      : undefined,
  }));
}

/** One JSON-RPC call: `method` + `params` in, the response's `result` out — rejects on a JSON-RPC error reply. */
type McpCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Opens a fresh MCP connection for `server` (transport dispatched on
 * `server.type` — `stdio` for the default/`'stdio'` variant, an HTTP POST
 * round trip for `'http'`/`'sse'`, see {@link httpSession}'s own doc
 * comment for why both share one implementation), performs the
 * `initialize`/`notifications/initialized` handshake, hands `fn` a
 * type-erased {@link McpCall}, then always tears the connection down
 * (kills the spawned child for `stdio`; nothing to release for HTTP) —
 * regardless of whether `fn` resolved or threw.
 */
async function withMcpSession<T>(
  server: AcpMcpServerConfig,
  timeoutMs: number,
  fn: (call: McpCall) => Promise<T>,
): Promise<T> {
  if (server.type === 'http' || server.type === 'sse') {
    return httpSession(server, timeoutMs, fn);
  }
  return stdioSession(server, timeoutMs, fn);
}

type StdioChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** One in-flight stdio JSON-RPC request's resolver pair, keyed by request id — a genuinely dynamic, runtime-inserted-and-deleted collection (one entry per outstanding call, removed the moment its reply arrives), unlike a static lookup table. */
type PendingStdioCalls = Map<
  number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>;

async function stdioSession<T>(
  server: AcpMcpServerConfig,
  timeoutMs: number,
  fn: (call: McpCall) => Promise<T>,
): Promise<T> {
  if (server.type === 'http' || server.type === 'sse') {
    throw new McpPromptClientError(`server "${server.name}" is not a stdio server`, server.name);
  }
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const pair of server.env ?? []) {
    if (pair.value !== undefined) env[pair.name] = pair.value;
  }
  const child = spawn(server.command, server.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  }) as StdioChild;
  // Spawn errors (ENOENT — the binary itself is missing, the single most
  // common way a quick-add preset like `uvx mcp-server-git` fails on a
  // fresh machine) surface as an 'error' event, not a thrown exception —
  // routed into the same pending-request rejection path every other
  // failure uses, so a caller never has to special-case this one.
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    spawnError = err;
    // A spawn failure (ENOENT — the binary is missing, by far the most
    // common way a quick-add preset like `uvx mcp-server-git` fails on a
    // fresh machine) fires asynchronously, after `handshake`'s own first
    // `call('initialize', ...)` has already queued a pending entry — so
    // this must actively reject whatever is already waiting, not just
    // flag future calls (`call`'s own `spawnError` check below), or a
    // pending request would hang until this module's outer `withTimeout`
    // fires instead of failing fast.
    for (const { reject } of pending.values()) {
      reject(new McpPromptClientError(err.message, server.name));
    }
    pending.clear();
  });

  const rl = createInterface({ input: child.stdout, terminal: false });
  let nextId = 1;
  const pending: PendingStdioCalls = new Map();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    resolvePendingFromMessage(msg, pending);
  });

  const call: McpCall = (method, params) => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    if (spawnError) {
      reject(new McpPromptClientError(spawnError.message, server.name));
      return promise;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };

  try {
    await handshake(call);
    return await fn(call);
  } catch (error) {
    throw toMcpPromptClientError(error, server.name);
  } finally {
    rl.close();
    child.kill();
  }
}

function resolvePendingFromMessage(msg: unknown, pending: PendingStdioCalls): void {
  if (!isPlainObject(msg) || typeof msg.id !== 'number') return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if ('error' in msg) {
    const err = msg.error;
    const message =
      isPlainObject(err) && typeof err.message === 'string' ? err.message : 'MCP error';
    entry.reject(new Error(message));
  } else {
    entry.resolve(isPlainObject(msg) ? msg.result : undefined);
  }
}

/**
 * The `http`/`sse` transports share one implementation: a real
 * `sse`-configured server encountered in practice (this issue's own MCP
 * server preset catalogue has none — `mcp-presets.ts` ships one `http`
 * remote, Context7, and five `stdio`) overwhelmingly still answers the
 * same modern Streamable HTTP POST/SSE-response shape `http` uses, MCP's
 * legacy dedicated two-connection SSE transport having been superseded by
 * it; a genuinely legacy-only SSE server simply fails this request (an
 * unreachable server, per this issue's own resilience acceptance) rather
 * than being specially unsupported. Verified directly against a real
 * `@modelcontextprotocol/server-everything --streamableHttp` instance:
 * every POST response arrives as `text/event-stream` (one `data:` line
 * carrying the JSON-RPC reply), and `initialize`'s `Mcp-Session-Id`
 * response header must be echoed on every later request on this same
 * connection or the server rejects it — both handled below.
 */
async function httpSession<T>(
  server: AcpMcpServerConfig,
  timeoutMs: number,
  fn: (call: McpCall) => Promise<T>,
): Promise<T> {
  if (server.type !== 'http' && server.type !== 'sse') {
    throw new McpPromptClientError(
      `server "${server.name}" is not an http/sse server`,
      server.name,
    );
  }
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  for (const header of server.headers ?? []) {
    if (header.value !== undefined) baseHeaders[header.name] = header.value;
  }
  let sessionId: string | undefined;
  let nextId = 1;

  const call: McpCall = async (method, params) => {
    const headers = { ...baseHeaders, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) };
    const id = nextId++;
    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} calling "${method}" on "${server.name}"`);
    }
    sessionId ??= response.headers.get('mcp-session-id') ?? undefined;
    const message = await parseJsonRpcResponse(response, id);
    if (isPlainObject(message) && 'error' in message) {
      const err = message.error;
      const detail =
        isPlainObject(err) && typeof err.message === 'string' ? err.message : 'MCP error';
      throw new Error(detail);
    }
    return isPlainObject(message) ? message.result : undefined;
  };
  const notify = async (method: string): Promise<void> => {
    const headers = { ...baseHeaders, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) };
    await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
  };

  try {
    await handshake(call, notify);
    return await fn(call);
  } catch (error) {
    throw toMcpPromptClientError(error, server.name);
  }
}

/**
 * A Streamable HTTP response body is either plain JSON (`content-type:
 * application/json`) or one SSE event carrying the same JSON-RPC message
 * (`content-type: text/event-stream`, this module's own reference server
 * always takes this branch for a single request/response) — reads
 * whichever the server actually sent rather than assuming one.
 */
async function parseJsonRpcResponse(response: Response, requestId: number): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (contentType.includes('text/event-stream')) {
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed: unknown = JSON.parse(line.slice('data:'.length).trim());
        if (isPlainObject(parsed) && parsed.id === requestId) return parsed;
      } catch {
        // Not a JSON-RPC data line (a comment/keepalive) — keep scanning.
      }
    }
    return undefined;
  }
  if (!body) return undefined;
  return JSON.parse(body) as unknown;
}

/** `initialize` + `notifications/initialized`, shared by both transports — `notify` is only ever provided by {@link httpSession}; the `stdio` transport's own notification is a plain unacknowledged stdin write, folded directly into the `else` branch below rather than `stdioSession`'s `call` closure, since it never awaits a reply either way. */
async function handshake(call: McpCall, notify?: (method: string) => Promise<void>): Promise<void> {
  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'loombox', version: '0.0.0' },
  });
  if (notify) {
    await notify('notifications/initialized');
  } else {
    // stdio: a notification is just an id-less line, no reply awaited.
    await call('notifications/initialized', {}).catch(() => {
      // Some servers reply to this anyway (protocol violation, harmless);
      // most don't reply at all, which would hang `call`'s pending map
      // forever if awaited normally — caught here since nothing past the
      // handshake needs to know either way, only `stdioSession`'s own
      // process teardown (`finally`) needs to run eventually.
    });
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  serverName: string,
): Promise<T> {
  const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => rejectTimeout(new McpPromptClientError(`timed out after ${timeoutMs}ms`, serverName)),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function toMcpPromptClientError(error: unknown, serverName: string): McpPromptClientError {
  if (error instanceof McpPromptClientError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpPromptClientError(message, serverName);
}
