import { z } from 'zod';
import { PROTOCOL_V1 } from './handshake';

/**
 * Per-project tracker configuration (SPEC §7.10; issue #209): every project
 * chooses, once, how it tracks work — loombox's own local `native` tracker,
 * or `live` against an external GitHub/Jira tracker with no local mirror.
 * This is a plain config value, not a wire-message envelope — it carries no
 * `type`/`protocolVersion` (unlike `message.ts`'s `wireMessageV1` members),
 * the same boundary `provisioning.ts`'s `ProvisionTargetHostInputV1` draws
 * for a value nested inside other payloads rather than sent standalone.
 * `apps/web/src/lib/tracker-mode-store.ts` persists it per project
 * (localStorage today, same pattern as `mcp-server-store.ts`/
 * `plugin-store.ts`) and reuses {@link parseTrackerMode}/
 * {@link safeParseTrackerMode} below to re-validate what it reads back.
 */

/** A `live`-mode target pinned to a GitHub repo (SPEC §7.10). `projectNumber` is the repo's optional Projects v2 board. */
export const githubTarget = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  projectNumber: z.number().int().positive().optional(),
});
export type GitHubTarget = z.infer<typeof githubTarget>;

/** A `live`-mode target pinned to a Jira Cloud project (SPEC §7.10). */
export const jiraTarget = z.object({
  cloudId: z.string().min(1),
  projectKey: z.string().min(1),
});
export type JiraTarget = z.infer<typeof jiraTarget>;

/**
 * `TrackerMode`, exactly as SPEC §7.10 types it (lines 346-348): `native`
 * has no other fields, `live` carries `provider`, a `connectionId` naming a
 * `ConnectedAccount` (§7.26 — this schema never touches OAuth or a token
 * itself, only the account reference), and a `target`.
 *
 * **Divergence, called out rather than silently fixed**: SPEC's literal
 * type is `target: GitHubTarget | JiraTarget` — a flat union with no
 * correlation to `provider`, so as written it type-checks
 * `{ kind: 'live', provider: 'github', connectionId, target: <a JiraTarget> }`
 * just fine. Issue #209's acceptance explicitly requires rejecting exactly
 * that ("a GitHub target shape submitted as a Jira target"), which a flat
 * union cannot do on its own. `trackerModeLive` below keeps the exported
 * `TrackerMode` type shape identical to the spec (`target` still infers as
 * `GitHubTarget | JiraTarget`, not a provider-keyed discriminated variant)
 * and instead enforces the provider/target correlation as a runtime
 * `superRefine` cross-check, so the type stays exactly as specced while the
 * schema actually validates what the spec's prose clearly intends.
 */
const trackerModeNative = z.object({ kind: z.literal('native') });

const trackerModeLive = z.object({
  kind: z.literal('live'),
  provider: z.enum(['github', 'jira']),
  connectionId: z.string().min(1),
  target: z.union([githubTarget, jiraTarget]),
});

const trackerModeUnion = z.discriminatedUnion('kind', [trackerModeNative, trackerModeLive]);

/**
 * `superRefine` is applied to the built union (not to `trackerModeLive`
 * alone): `z.discriminatedUnion` needs every member to be a plain
 * `ZodObject` so it can read the `kind` literal off `.shape` — wrapping a
 * member in `.superRefine()` first turns it into a `ZodEffects` with no
 * `.shape`, which breaks the discriminant lookup.
 */
export const trackerMode = trackerModeUnion.superRefine((mode, ctx) => {
  if (mode.kind !== 'live') return;
  const result =
    mode.provider === 'github'
      ? githubTarget.safeParse(mode.target)
      : jiraTarget.safeParse(mode.target);
  if (!result.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: `target does not match provider '${mode.provider}' (expected a ${
        mode.provider === 'github' ? 'GitHubTarget' : 'JiraTarget'
      } shape)`,
    });
  }
});
export type TrackerMode = z.infer<typeof trackerMode>;

/** Parses and validates a `TrackerMode` value, throwing on an invalid one. */
export function parseTrackerMode(data: unknown): TrackerMode {
  return trackerMode.parse(data);
}

/** Same as {@link parseTrackerMode} but never throws; returns zod's result. */
export function safeParseTrackerMode(data: unknown): z.SafeParseReturnType<unknown, TrackerMode> {
  return trackerMode.safeParse(data);
}

/*
 * ---------------------------------------------------------------------------
 * Syncing the mode to the node (issue #631)
 * ---------------------------------------------------------------------------
 *
 * `TrackerMode` used to live only in the browser's `localStorage`, which made
 * the node structurally unable to honour it: `readTrackerSnapshotForBridge`
 * read the native store unconditionally because the native store was the only
 * thing it had, so a project switched to live GitHub or Jira saved the choice
 * and still showed local records, silently. SPEC §7.10 says a project chooses
 * "once" how it tracks work — once, not once per browser — and `connectionId`
 * names a `ConnectedAccount` that only exists in the node's own keyring, so a
 * device-local mode referenced an id that meant nothing where it was needed.
 *
 * These three messages mirror `account-connect.ts`'s
 * `account_pin_get/set_request` + `account_pin_response` deliberately: the
 * account pin is the same kind of fact (per-project, per-node, client-edited,
 * stored under `stateDir`, keyed by absolute `projectPath`) and it already had
 * the shape this needed. Same request/reply convention, and the same rule that
 * the reply carries the resulting state so a set needs no second round trip.
 */

/** A client asks `nodeId` for `projectPath`'s saved mode. */
export const trackerModeGetRequest = z.object({
  type: z.literal('tracker_mode_get_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
});
export type TrackerModeGetRequest = z.infer<typeof trackerModeGetRequest>;

/** Saves `projectPath`'s mode. There is deliberately no unset: `{kind:'native'}` is an explicit choice a user makes, and "never chosen" is only ever the initial state, never somewhere the UI returns to. */
export const trackerModeSetRequest = z.object({
  type: z.literal('tracker_mode_set_request'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  mode: trackerMode,
});
export type TrackerModeSetRequest = z.infer<typeof trackerModeSetRequest>;

/**
 * The reply to both requests: `projectPath`'s resulting mode.
 *
 * `mode` is OPTIONAL, and its absence is load-bearing rather than an empty
 * default. It means "this project has never had a mode chosen", which is a
 * distinct state from an explicit `{kind:'native'}` — the exact distinction
 * `tracker-mode-store.ts`'s own doc comment calls its whole point, and the one
 * the Tracker page's setup step branches on. Collapsing it to a native default
 * here would silently reintroduce the guess issue #209 exists to prevent.
 */
export const trackerModeResponse = z.object({
  type: z.literal('tracker_mode_response'),
  protocolVersion: z.literal(PROTOCOL_V1),
  requestId: z.string().min(1),
  nodeId: z.string().min(1),
  projectPath: z.string().min(1),
  mode: trackerMode.optional(),
});
export type TrackerModeResponse = z.infer<typeof trackerModeResponse>;
