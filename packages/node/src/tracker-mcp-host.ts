/* ---------------------------------------------------------------------
 * The node-side MCP host that actually serves the native tracker's
 * `tracker_*` tools to a running agent session (SPEC §7.10; issue #627,
 * completing #211's tool contract — `./tracker-mcp-tools.ts`'s own doc
 * comment names this exact gap: "no node-side MCP host exists yet").
 *
 * **Why HTTP, in-process, one endpoint per loombox session — not a spawned
 * stdio subprocess.** Issue #627 names both as acceptable
 * ("a stdio subprocess the node spawns per session, or an http endpoint
 * the node serves"). A `stdio` `McpServerConfig` is spawned by the
 * CONNECTED AGENT, not this node (`command`/`args`/`env` is all a
 * `McpServerConfig` ever hands the agent — see `@loombox/providers-core`'s
 * `mcp-config.ts`) — this node has no `ipc` channel back to a process it
 * never itself spawned, only that child's own stdout/stderr, which the
 * agent's MCP client already owns for the MCP wire protocol itself.
 * Getting a write tool call through THIS node's own live permission queue
 * (`@loombox/supervisor`'s `AgentSession.permissions`, the exact FIFO
 * queue every other tool call's `session/request_permission` already
 * goes through) would then need a second, hand-rolled IPC transport back
 * to this process for zero benefit. Hosting the MCP server here instead —
 * a loopback-only (`127.0.0.1`) `StreamableHTTPServerTransport` per
 * session, reachable from the agent's process because
 * `session-sandbox.ts`'s own bubblewrap invocation runs with
 * `--share-net` (the network namespace is never isolated, only the
 * filesystem is) — means every tracker tool call lands directly in THIS
 * process, with a direct, synchronous reference to the live
 * `AgentSession` issue #627 needs for permission gating. No new
 * dependency on IPC framing, no second process to keep alive, no message
 * loss window between this node and a child it doesn't control the
 * lifecycle of.
 *
 * **Authority model — the acceptance's "say explicitly which operations
 * are gated and which are not, and why."** `tracker_list`/`tracker_get`
 * are pure reads with no side effect on the user's real tracker — called
 * straight through, no permission prompt, exactly like this repo's other
 * read-only tool calls (a file read, a directory list) never need one
 * either. `tracker_create`/`tracker_update`/`tracker_link_session` mutate
 * the user's real tracker data, so each one is gated through
 * `TrackerMcpSessionContext.requestWritePermission` BEFORE
 * `TrackerMcpTool.execute` ever runs — the caller (`NodeDaemon`, see
 * `node-daemon.ts`'s `requestTrackerWritePermission`) implements that hook
 * by enqueueing a synthetic tool-call permission request onto the SAME
 * `AgentSession.permissions` FIFO queue, and through the SAME
 * `evaluateToolProfile` D3-4 profile gate (issue #752), every other
 * mutating tool call in this codebase already goes through — a project's
 * saved permission profile or a human's own allow/deny answer governs a
 * tracker write exactly as it would an edit_file or execute_command call,
 * never a parallel, weaker mechanism invented just for this tool family.
 *
 * **Tool-list honesty — the acceptance's third bullet.** This host is
 * only ever registered for a session at all when `NodeDaemon` has already
 * confirmed the bound project's `TrackerMode` is `{kind:'native'}` (see
 * `node-daemon.ts`'s `resolveMcpServersWithTracker`) — `tracker_*` reads
 * and writes `NativeTrackerStore` directly (issue #210/#211), which is
 * simply not the project's tracker at all in `live` (GitHub/Jira) mode;
 * `resolveTrackerBackend` (`tracker-backend-composition.ts`) is that
 * mode's own, entirely separate resolution path, and deliberately never
 * reached from here. A `live`-mode session's `mcpServers` list never
 * carries this server, so its agent never sees `tracker_*` in its own
 * `tools/list` at all — never advertised only to fail.
 *
 * **Security note.** Loopback-only, and every session's endpoint path is
 * an unguessable random token (`randomBytes(24)`) minted fresh per
 * `register()` call and forgotten on `unregister()` — the same shape a
 * local dev tool's own loopback-bound, token-in-URL server would use.
 * This is not a defense against another process on the SAME machine
 * inspecting `/proc` for this node's own listen state; it is a defense
 * against a stray cross-origin request (a browser tab, another loopback
 * service) stumbling onto a live tracker-mutating endpoint by guessing a
 * path.
 * --------------------------------------------------------------------- */

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { AcpMcpServerConfig } from '@loombox/providers-core';

import {
  createTrackerMcpTools,
  TrackerMcpToolError,
  type TrackerMcpTool,
  type TrackerMcpToolName,
} from './tracker-mcp-tools';
import type { NativeTrackerStore } from './native-tracker-store';

/** The name every session's tracker server registers under (`McpServerConfig.name`/`AcpMcpServerConfig.name`) — matched by `AgentProfile.deniedMcpServers` (issue #752) exactly like any other declared server name, so a profile can omit the tracker entirely for a session, same mechanism, no special case. */
export const TRACKER_MCP_SERVER_NAME = 'loombox-tracker';

/** Which of the five `tracker_*` tools mutate the store — gated through `TrackerMcpSessionContext.requestWritePermission` before `execute` ever runs. The other two (`tracker_list`/`tracker_get`) are pure reads, called straight through with no gate — see this module's own doc comment for why that split is deliberate. Fixed, static membership, so a plain lookup record, not a Set (mirrors `permission-policy.ts`'s own `SHELL_INTERPRETERS` convention). */
const WRITE_TOOL_NAMES: Record<string, true> = {
  tracker_create: true,
  tracker_update: true,
  tracker_link_session: true,
};

/** {@link TrackerMcpSessionContext.requestWritePermission}'s result — deliberately NOT `@loombox/providers-core`'s own `AcpPermissionOutcome`/`AcpPermissionOption` vocabulary: this module has no reason to know ACP's `optionId`/`kind` shape at all, only whether the write may proceed and, if not, a short reason to hand back to the agent as the tool's own error text. `NodeDaemon`'s implementation is the one place that translates a real permission-queue outcome into this shape. */
export interface TrackerWritePermissionResult {
  readonly allowed: boolean;
  /** Required when `allowed` is `false` — surfaced verbatim in the tool's `CallToolResult` error text (e.g. `"blocked by profile \"Reviewer\""`, `"denied"`, `"cancelled"`). */
  readonly reason?: string;
}

/** What a caller (`NodeDaemon`) resolves once per session and hands to {@link TrackerMcpHost.register} — the exact `(store, projectPath, authorId, sessionId)` `createTrackerMcpTools` itself needs (see `./tracker-mcp-tools.ts`), plus the one hook this host adds on top. */
export interface TrackerMcpSessionContext {
  readonly store: NativeTrackerStore;
  readonly projectPath: string;
  readonly authorId: string;
  readonly sessionId: string;
  /** See this module's doc comment's "Authority model" section. Never called for `tracker_list`/`tracker_get`. */
  requestWritePermission(
    toolName: TrackerMcpToolName,
    rawInput: unknown,
  ): Promise<TrackerWritePermissionResult>;
}

export interface TrackerMcpHostOptions {
  /** Loopback host to bind the one shared HTTP listener to. Defaults to `127.0.0.1` — see this module's doc comment's "Security note". */
  host?: string;
}

/** One underlying MCP protocol connection — its own `initialize` handshake, its own SDK-assigned `Mcp-Session-Id` — against a registered Loombox session's tracker endpoint. See {@link RegisteredLoomboxSession}'s own doc comment for why a session's endpoint can and does outlive more than one of these. */
interface RegisteredMcpConnection {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

/**
 * Everything `register()` resolves once for a Loombox session (SPEC
 * §7.10; issue #627): the `tools`/`requestWritePermission` every
 * connection to this session's endpoint shares verbatim (`createTrackerMcpTools`
 * is a pure, stateless factory over the same `(store, projectPath,
 * authorId, sessionId)` for the session's whole lifetime — nothing about
 * it is per-connection), plus the live `Mcp-Session-Id -> RegisteredMcpConnection`
 * map this endpoint currently holds.
 *
 * **Why a map, not a single connection.** Nothing in the MCP spec (or in
 * a real agent's own MCP client implementation) guarantees a client
 * opens exactly one `StreamableHTTPServerTransport`-level connection and
 * keeps it alive for as long as the Loombox session itself lives — a
 * client is free to `initialize` a fresh connection for every tool call,
 * or after any idle period, and a real one may well do exactly that (this
 * module's own `node-daemon-tracker-mcp.test.ts` fixture does, on
 * purpose, to exercise this). The SDK's `StreamableHTTPServerTransport`
 * is a single-MCP-session object: a second, independent `initialize`
 * against an already-initialized one is refused outright ("Server
 * already initialized"). An earlier version of this host wired one
 * `McpServer`/transport pair per Loombox session for that session's
 * whole lifetime and broke on exactly this the first time a second
 * connection landed — this map is the SDK's own documented fix (see
 * `StreamableHTTPServerTransport`'s `onsessioninitialized`/
 * `onsessionclosed` options): the *Loombox session's own* URL token
 * stays fixed for its whole lifetime (this module's own security
 * boundary), while the *MCP protocol session* underneath it is free to
 * open and close as many times as a real client's own connection
 * lifecycle calls for.
 */
interface RegisteredLoomboxSession {
  readonly tools: readonly TrackerMcpTool[];
  readonly requestWritePermission: TrackerMcpSessionContext['requestWritePermission'];
  readonly connections: Map<string, RegisteredMcpConnection>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the `tools/list` entry for one tracker tool, converting its Zod input schema into the plain JSON Schema the MCP wire protocol carries. */
function toolListEntry(tool: TrackerMcpTool): ListToolsResult['tools'][number] {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as ListToolsResult['tools'][number]['inputSchema'],
  };
}

/** Registers the MCP `tools/list`/`tools/call` request handlers for one session's tracker tools onto its own `McpServer` — the module's one real seam between the generic MCP wire handling above and `createTrackerMcpTools`'s tool contract. */
function wireTrackerTools(
  mcpServer: McpServer,
  tools: readonly TrackerMcpTool[],
  requestWritePermission: TrackerMcpSessionContext['requestWritePermission'],
): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  const toolList = tools.map(toolListEntry);

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList }));

  mcpServer.server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const tool = byName.get(request.params.name as TrackerMcpToolName);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text', text: `unknown tool "${request.params.name}"` }],
        };
      }

      const rawInput: unknown = request.params.arguments ?? {};

      if (WRITE_TOOL_NAMES[tool.name]) {
        const permission = await requestWritePermission(tool.name, rawInput);
        if (!permission.allowed) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `"${tool.name}" was not approved (${permission.reason ?? 'denied'}) — the record was not changed.`,
              },
            ],
          };
        }
      }

      try {
        const result = await tool.execute(rawInput);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof TrackerMcpToolError ? error.message : errorMessage(error);
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  );
}

/**
 * Owns the one loopback HTTP listener every native-mode session's tracker
 * MCP endpoint is mounted on (started lazily, on the first `register()`
 * call this node process ever makes — a node whose sessions never touch a
 * native-mode project opens no port at all), and every registered Loombox
 * session's own `RegisteredLoomboxSession` mounted on it — see that
 * interface's own doc comment for why one Loombox session's endpoint can
 * carry more than one underlying MCP protocol connection over its
 * lifetime. See this module's own doc comment for the full design
 * rationale.
 */
export class TrackerMcpHost {
  private readonly host: string;
  private httpServer: Server | undefined;
  private listening: Promise<{ port: number }> | undefined;
  private readonly byToken = new Map<string, RegisteredLoomboxSession>();
  private readonly tokenBySessionId = new Map<string, string>();

  constructor(options: TrackerMcpHostOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
  }

  /** Whether the loopback listener is up yet — exposed for tests only; a caller never needs to check this before `register()`, which starts it on demand. */
  get isListening(): boolean {
    return this.httpServer !== undefined;
  }

  private ensureListening(): Promise<{ port: number }> {
    if (this.listening) return this.listening;
    const { promise, resolve, reject } = Promise.withResolvers<{ port: number }>();
    this.listening = promise;
    const server = createServer((req, res) => this.handleRequest(req, res));
    server.on('error', reject);
    server.listen(0, this.host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('TrackerMcpHost: expected an AddressInfo from a loopback TCP listener'));
        return;
      }
      this.httpServer = server;
      resolve({ port: address.port });
    });
    return promise;
  }

  /**
   * Routes one incoming request by this module's two-level scheme: the
   * URL's own `/tracker/<token>` names the Loombox session (never
   * changes for that session's whole lifetime); the `Mcp-Session-Id`
   * header, once one has been assigned, names which of that session's
   * (possibly several — see {@link RegisteredLoomboxSession}) live MCP
   * connections this request belongs to. No header at all means "open a
   * fresh one" — the common case for a client's very first request, and
   * an equally normal one for its Nth if that client reconnects between
   * calls rather than holding one connection open throughout.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${this.host}`);
    const token = /^\/tracker\/([^/]+)$/.exec(url.pathname)?.[1];
    const session = token ? this.byToken.get(token) : undefined;
    if (!session) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown tracker session');
      return;
    }

    const mcpSessionHeader = req.headers['mcp-session-id'];
    const mcpSessionId = typeof mcpSessionHeader === 'string' ? mcpSessionHeader : undefined;

    if (mcpSessionId !== undefined) {
      const existing = session.connections.get(mcpSessionId);
      if (!existing) {
        // A session id this endpoint has never issued, or one whose
        // connection has already closed — the SDK's own "requests with
        // invalid session IDs are rejected with 404" convention,
        // enforced one layer up since routing among possibly-many
        // connections is this host's own job now, not a single
        // transport instance's.
        res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown mcp session');
        return;
      }
      this.dispatch(existing.transport, req, res);
      return;
    }

    // No Mcp-Session-Id: open a fresh MCP-level connection against this
    // same Loombox session's endpoint, then hand this request to it once
    // it's actually wired — never before `mcpServer.connect()` resolves,
    // or an `initialize` sent this same tick could race the transport's
    // own message handling. A non-`initialize` request that lands here
    // (a malformed/buggy client) is rejected by the fresh transport
    // itself, per the SDK's own "non-initialization requests without a
    // session ID get 400" rule — nothing extra to do for that case here.
    this.openConnection(session)
      .then((connection) => this.dispatch(connection.transport, req, res))
      .catch((error: unknown) => {
        console.warn(`TrackerMcpHost: failed to open a new MCP session: ${errorMessage(error)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
  }

  private dispatch(
    transport: StreamableHTTPServerTransport,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    transport.handleRequest(req, res).catch((error: unknown) => {
      console.warn(`TrackerMcpHost: request handling failed: ${errorMessage(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }

  /**
   * Builds one fresh {@link RegisteredMcpConnection} for `session`: a new
   * `McpServer` wired with that Loombox session's own `tools`/
   * `requestWritePermission` (shared verbatim, never rebuilt per
   * connection), and a new `StreamableHTTPServerTransport` that adds
   * itself to `session.connections` the moment the SDK actually assigns
   * it a session id (`onsessioninitialized`, fired mid-`handleRequest`,
   * before that call returns) and removes itself the moment that MCP
   * session ends — on an explicit client `close()` (`onsessionclosed`,
   * the ordinary case) or an abrupt disconnect (`transport.onclose`, the
   * fallback that actually prevents a dead entry from lingering forever
   * when a client never sends a clean termination at all; safe to run
   * twice since a `Map.delete` on an already-removed key is a no-op).
   */
  private async openConnection(
    session: RegisteredLoomboxSession,
  ): Promise<RegisteredMcpConnection> {
    const mcpServer = new McpServer(
      { name: TRACKER_MCP_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    wireTrackerTools(mcpServer, session.tools, session.requestWritePermission);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (mcpSessionId) => {
        session.connections.set(mcpSessionId, connection);
      },
      onsessionclosed: (mcpSessionId) => {
        session.connections.delete(mcpSessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) session.connections.delete(transport.sessionId);
    };

    const connection: RegisteredMcpConnection = { server: mcpServer, transport };
    await mcpServer.connect(transport);
    return connection;
  }

  /**
   * Registers `context.sessionId`'s tracker MCP server (starting the
   * shared loopback listener first if this is the first registration
   * this process has ever made) and returns the `AcpMcpServerConfig`
   * entry a caller (`NodeDaemon.resolveMcpServersWithTracker`) appends to
   * that session's `mcpServers` list. Idempotent: re-registering an
   * already-registered `sessionId` (a retried spawn) tears down the old
   * endpoint first rather than leaking it. Opens no MCP connection
   * itself — {@link openConnection} does that lazily, on that endpoint's
   * first real request.
   */
  async register(context: TrackerMcpSessionContext): Promise<AcpMcpServerConfig> {
    this.unregister(context.sessionId);

    const { port } = await this.ensureListening();
    const token = randomBytes(24).toString('base64url');

    const tools = createTrackerMcpTools({
      store: context.store,
      projectPath: context.projectPath,
      authorId: context.authorId,
      sessionId: context.sessionId,
    });

    const session: RegisteredLoomboxSession = {
      tools,
      requestWritePermission: context.requestWritePermission,
      connections: new Map(),
    };
    this.byToken.set(token, session);
    this.tokenBySessionId.set(context.sessionId, token);

    return {
      name: TRACKER_MCP_SERVER_NAME,
      type: 'http',
      url: `http://${this.host}:${port}/tracker/${token}`,
      headers: [],
    };
  }

  /** Tears down `sessionId`'s tracker MCP server — every one of its still-open MCP connections, not just one — if any. A no-op the second time. Called once that session's bridge is gone (`NodeDaemon`'s `'exit'` handler) so a stale token can never outlive the session it was minted for. */
  unregister(sessionId: string): void {
    const token = this.tokenBySessionId.get(sessionId);
    if (!token) return;
    this.tokenBySessionId.delete(sessionId);
    const session = this.byToken.get(token);
    this.byToken.delete(token);
    if (!session) return;
    for (const connection of [...session.connections.values()]) {
      connection.server.close().catch((error: unknown) => {
        console.warn(
          `TrackerMcpHost: failed to close session ${sessionId}'s tracker server: ${errorMessage(error)}`,
        );
      });
    }
  }

  /** Closes the shared loopback listener and every still-registered session's server — this node's own shutdown path. A no-op if `register()` was never called. */
  async close(): Promise<void> {
    for (const sessionId of [...this.tokenBySessionId.keys()]) this.unregister(sessionId);
    const server = this.httpServer;
    this.httpServer = undefined;
    this.listening = undefined;
    if (!server) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }
}
