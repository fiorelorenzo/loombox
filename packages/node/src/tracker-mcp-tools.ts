/* ---------------------------------------------------------------------
 * The MCP tool contract for the native tracker (SPEC §7.10, §7.7; issue
 * #211, building on #210's `TrackerRecord`/`NativeTrackerStore`): gives a
 * running agent session `tracker_list`/`tracker_get`/`tracker_create`/
 * `tracker_update`/`tracker_link_session` tools so it can read and write
 * `native`-mode tracker items itself instead of the user relaying them by
 * hand. SPEC §7.10 names this exact tool set, citing
 * `nimbalyst/design/trackers/unified-tracker-system.md:259-336` for "that
 * contract shape" — that file was not available anywhere in this
 * clean-room build environment (AGENTS.md: "fork or import no code" is a
 * hard gate regardless), so the five names, their CRUD responsibilities,
 * and the fields/system/indexed-column split below are taken directly
 * from SPEC §7.10's and this issue's own prose, not from reading
 * Nimbalyst's code.
 *
 * **Scoping, structural rather than checked.** "A session must not be
 * able to read or write another project's tracker records" (issue #211's
 * acceptance) is enforced by construction, not by an input check that
 * could be gotten wrong: {@link TrackerMcpToolContext}'s `projectPath` /
 * `authorId` / `sessionId` are resolved by the caller (the future MCP
 * host, from the session's own bound project — never from anything the
 * agent sends) and closed over when {@link createTrackerMcpTools} builds
 * each tool's `execute`. None of the five input schemas below has a
 * `projectPath` field, and every schema is `.strict()`, so an agent
 * cannot even submit one to try to override it — `NativeTrackerStore`
 * itself then only ever sees the one `projectPath` this module was built
 * for. A `tracker_get`/`tracker_update`/`tracker_link_session` call
 * naming a real record id that belongs to a *different* project is
 * indistinguishable, at the store layer, from a made-up id: `get` returns
 * `null` and the mutating tools throw {@link TrackerMcpToolError} — see
 * this file's test for the two-project proof.
 *
 * **Real finding, stated plainly (issue #211's acceptance allows this in
 * place of faked wiring): no node-side MCP host exists yet.** Grepping
 * this repo's whole MCP surface (`@loombox/providers-core`'s
 * `mcp-config.ts`/`mcp-secret-grants.ts`, `@loombox/node`'s
 * `mcp-config-store.ts`/`mcp-secrets.ts`, `McpServerConfigPanel.svelte`)
 * turns up exactly one mechanism: a user *declares* an external MCP
 * server (stdio command, or an http/sse URL) per SPEC §7.7, which
 * `NodeDaemon.resolveMcpServers` resolves into the plain
 * `AcpMcpServerConfig[]` that `AcpClient.newSession` hands to the ACP
 * agent — the agent itself then connects to that external process. There
 * is no code anywhere that runs an MCP *server* inside the node and
 * serves tool calls against it; wiring this contract in for real means
 * building that host (something that speaks MCP over stdio or http,
 * spawned/served per session, registered into a session's
 * `McpServerConfig` list ahead of every other declared server) — a
 * distinct, larger piece of work than the tool contract itself, and
 * explicitly not this issue's data-model dependency to build blind. This
 * module is therefore a standalone, fully tested unit with the one seam a
 * host needs: {@link createTrackerMcpTools} takes a `NativeTrackerStore`
 * plus a resolved, non-spoofable `(projectPath, authorId, sessionId)` and
 * returns ready-to-register tool definitions — `name`, `description`,
 * `inputSchema`, and an `execute` that validates, calls the store, and
 * returns the exact `TrackerRecord` shape (`fields`/`system`/indexed
 * columns, per #210) with no ad-hoc DTO in between. Filed as a follow-up:
 * "Native tracker: node-side MCP host to actually serve tracker_* tools
 * to a session" (loombox roadmap epic #21).
 * --------------------------------------------------------------------- */

import { z } from 'zod';

import type { TrackerRecord } from '@loombox/shared';

import { NativeTrackerStore, NativeTrackerStoreError } from './native-tracker-store';

/** The five tools SPEC §7.10 names, in the order it lists them. */
export const TRACKER_MCP_TOOL_NAMES = [
  'tracker_list',
  'tracker_get',
  'tracker_create',
  'tracker_update',
  'tracker_link_session',
] as const;
export type TrackerMcpToolName = (typeof TRACKER_MCP_TOOL_NAMES)[number];

/**
 * Thrown for a failed input validation or a store-layer failure
 * (`NativeTrackerStoreError`, e.g. an unknown `primaryType` or a
 * nonexistent record id) surfaced through one of these tools. Always
 * names the offending tool, mirroring this package's other per-module
 * error classes (`NativeTrackerStoreError`, `McpConfigError`) — a future
 * host catches this and turns it into an MCP tool error response; this
 * module has no opinion on wire framing.
 */
export class TrackerMcpToolError extends Error {
  constructor(
    public readonly tool: TrackerMcpToolName,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`tracker MCP tool "${tool}": ${message}`, options);
    this.name = 'TrackerMcpToolError';
  }
}

const fieldsSchema = z.record(z.string(), z.unknown());
const typeTagsSchema = z.array(z.string().min(1));

/** `tracker_list` — lists the bound project's records, optionally narrowed by type/tag/archived state (mirrors `NativeTrackerStore.list`'s `ListTrackerRecordsFilter` exactly). */
export const trackerListInputSchema = z
  .object({
    primaryType: z.string().min(1).optional(),
    typeTag: z.string().min(1).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();
export type TrackerListToolInput = z.infer<typeof trackerListInputSchema>;
export interface TrackerListToolOutput {
  readonly records: readonly TrackerRecord[];
}

/** `tracker_get` — fetches one record by its internal `id` or its project-scoped, human-facing `issueNumber`; exactly one of the two is required. */
export const trackerGetInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    issueNumber: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const provided = [input.id !== undefined, input.issueNumber !== undefined].filter(
      Boolean,
    ).length;
    if (provided !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of "id" or "issueNumber" is required',
      });
    }
  });
export type TrackerGetToolInput = z.infer<typeof trackerGetInputSchema>;
export interface TrackerGetToolOutput {
  /** `null` when no record matches — a missing lookup is not an error. */
  readonly record: TrackerRecord | null;
}

/** `tracker_create` — creates a record of a known type (built-in or already `defineType`-registered) with the given business `fields`. `system.authorId` is stamped from the bound session context, never from tool input. */
export const trackerCreateInputSchema = z
  .object({
    primaryType: z.string().min(1),
    typeTags: typeTagsSchema.optional(),
    fields: fieldsSchema,
  })
  .strict();
export type TrackerCreateToolInput = z.infer<typeof trackerCreateInputSchema>;

/** `tracker_update` — patches business data (`primaryType`/`typeTags`/`fields`/`archived`) on an existing record; omitted fields are left as-is, matching `NativeTrackerStore.update`. Never touches `system` — that's `tracker_link_session`'s job. */
export const trackerUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    primaryType: z.string().min(1).optional(),
    typeTags: typeTagsSchema.optional(),
    fields: fieldsSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type TrackerUpdateToolInput = z.infer<typeof trackerUpdateInputSchema>;

/** `tracker_link_session` — links the *current* session (bound in context, never a caller-supplied id) into a record's `system.linkedSessionIds`. */
export const trackerLinkSessionInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
export type TrackerLinkSessionToolInput = z.infer<typeof trackerLinkSessionInputSchema>;

/** The output shape shared by every tool that returns a single, mutated-or-fetched record. */
export interface TrackerRecordToolOutput {
  readonly record: TrackerRecord;
}

/**
 * What a future MCP host resolves once per session and passes in here —
 * never anything an agent's tool-call input can influence. See this
 * file's doc comment for why that split is what makes cross-project
 * access structurally impossible rather than merely validated against.
 */
export interface TrackerMcpToolContext {
  readonly store: NativeTrackerStore;
  /** The session's bound project — the one and only project every tool built from this context can ever touch. */
  readonly projectPath: string;
  /** Stamped as `system.authorId` on every record `tracker_create` makes. */
  readonly authorId: string;
  /** Stamped into `system.linkedSessionIds` by `tracker_link_session`. */
  readonly sessionId: string;
}

/** One registerable MCP tool: a name, a human-readable description, its Zod input schema, and a validating `execute`. */
export interface TrackerMcpTool<TInput = unknown, TOutput = unknown> {
  readonly name: TrackerMcpToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  execute(rawInput: unknown): Promise<TOutput>;
}

function parseInput<T>(tool: TrackerMcpToolName, schema: z.ZodType<T>, rawInput: unknown): T {
  const result = schema.safeParse(rawInput);
  if (!result.success) {
    const detail = result.error.issues
      .map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      )
      .join('; ');
    throw new TrackerMcpToolError(tool, `invalid input — ${detail}`, { cause: result.error });
  }
  return result.data;
}

function runStoreOp<T>(tool: TrackerMcpToolName, op: () => T): T {
  try {
    return op();
  } catch (error) {
    if (error instanceof NativeTrackerStoreError) {
      throw new TrackerMcpToolError(tool, error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * Builds the five `tracker_*` MCP tool definitions for one session, bound
 * to `context.projectPath` (see {@link TrackerMcpToolContext}). A future
 * MCP host registers each returned tool by `name` and calls `execute`
 * with the agent's raw tool-call arguments.
 */
export function createTrackerMcpTools(context: TrackerMcpToolContext): readonly TrackerMcpTool[] {
  const { store, projectPath, authorId, sessionId } = context;

  const list: TrackerMcpTool<TrackerListToolInput, TrackerListToolOutput> = {
    name: 'tracker_list',
    description:
      "List this project's native tracker records, optionally filtered by primaryType, typeTag, and whether to include archived records.",
    inputSchema: trackerListInputSchema,
    async execute(rawInput) {
      const input = parseInput('tracker_list', trackerListInputSchema, rawInput);
      const records = runStoreOp('tracker_list', () =>
        store.list(projectPath, {
          primaryType: input.primaryType,
          typeTag: input.typeTag,
          includeArchived: input.includeArchived,
        }),
      );
      return { records };
    },
  };

  const get: TrackerMcpTool<TrackerGetToolInput, TrackerGetToolOutput> = {
    name: 'tracker_get',
    description:
      'Fetch one native tracker record by internal id or by its project-scoped issueNumber. Returns record: null if nothing matches.',
    inputSchema: trackerGetInputSchema,
    async execute(rawInput) {
      const input = parseInput('tracker_get', trackerGetInputSchema, rawInput);
      const record = runStoreOp('tracker_get', () => {
        if (input.id !== undefined) return store.get(projectPath, input.id);
        if (input.issueNumber !== undefined) {
          return store.getByIssueNumber(projectPath, input.issueNumber);
        }
        // Unreachable: trackerGetInputSchema.superRefine guarantees exactly
        // one of id/issueNumber is present by the time execute() runs.
        throw new TrackerMcpToolError(
          'tracker_get',
          'exactly one of "id" or "issueNumber" is required',
        );
      });
      return { record: record ?? null };
    },
  };

  const create: TrackerMcpTool<TrackerCreateToolInput, TrackerRecordToolOutput> = {
    name: 'tracker_create',
    description:
      'Create a native tracker record of a known type (a built-in Task/Bug/Epic, or a project-defined custom type) with the given fields.',
    inputSchema: trackerCreateInputSchema,
    async execute(rawInput) {
      const input = parseInput('tracker_create', trackerCreateInputSchema, rawInput);
      const record = runStoreOp('tracker_create', () =>
        store.create(projectPath, {
          primaryType: input.primaryType,
          typeTags: input.typeTags,
          fields: input.fields,
          authorId,
        }),
      );
      return { record };
    },
  };

  const update: TrackerMcpTool<TrackerUpdateToolInput, TrackerRecordToolOutput> = {
    name: 'tracker_update',
    description:
      'Patch an existing native tracker record\u2019s primaryType, typeTags, fields, and/or archived state. Omitted fields are left unchanged.',
    inputSchema: trackerUpdateInputSchema,
    async execute(rawInput) {
      const input = parseInput('tracker_update', trackerUpdateInputSchema, rawInput);
      const record = runStoreOp('tracker_update', () =>
        store.update(projectPath, input.id, {
          primaryType: input.primaryType,
          typeTags: input.typeTags,
          fields: input.fields,
          archived: input.archived,
        }),
      );
      return { record };
    },
  };

  const linkSession: TrackerMcpTool<TrackerLinkSessionToolInput, TrackerRecordToolOutput> = {
    name: 'tracker_link_session',
    description:
      'Link the current agent session into a native tracker record\u2019s linked sessions.',
    inputSchema: trackerLinkSessionInputSchema,
    async execute(rawInput) {
      const input = parseInput('tracker_link_session', trackerLinkSessionInputSchema, rawInput);
      const record = runStoreOp('tracker_link_session', () =>
        store.linkSession(projectPath, input.id, sessionId),
      );
      return { record };
    },
  };

  return [list, get, create, update, linkSession];
}
