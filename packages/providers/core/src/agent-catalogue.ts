/* ---------------------------------------------------------------------
 * Curated catalogue of known-good ACP agents (D1-3's second half,
 * `docs/superpowers/specs/2026-08-05-zed-parity-decisions.md` §4; issue
 * #749). Mirrors `mcp-presets.ts` deliberately: a small catalogue of
 * literal, fully-formed configs plus one `instantiate*` function that is
 * the *only* path from a catalogue entry to a real record — so a
 * catalogue pick can never take a different code path than a hand-typed
 * one, the same structural guarantee `mcp-presets.ts`'s own doc comment
 * describes for MCP server presets.
 *
 * Convenience only, same trust model D1-3 was built on
 * (`@loombox/node`'s `custom-agent.ts`, whose own doc comment is the
 * canonical statement of this): `instantiateAgentCatalogueEntry` returns
 * an ordinary `CustomAgentRecordV1`, which still goes through the exact
 * same per-project store (`addCustomAgent`) and the exact same node-side
 * allowlist check (`assertCustomAgentAllowed`) as a hand-typed custom
 * agent. There is no separate trust tier for a catalogue pick — an
 * allowlisted catalogue entry runs no differently than a disallowed one
 * that happens to share its `command` string, and nothing in this module
 * can change that. This module has no opinion on, and makes no attempt
 * to check, whether any entry's `command` is actually allowlisted on any
 * particular node — that answer only ever comes from
 * `RelayClient.probeCustomAgent` against a real target.
 *
 * Claude Code and Codex are deliberately NOT catalogued here: both are
 * already registered `AcpProvider`s (`@loombox/providers-claude`,
 * `@loombox/providers-codex`), so a project never needs the custom-agent
 * path to launch them — they show up in the ordinary provider picker
 * instead. This catalogue exists for real ACP agents that ship as a bare
 * CLI with no loombox-side provider module, each verified one at a time
 * straight from that agent's own documentation (issue #749: "do not
 * invent invocations you have not checked") — see each entry's
 * `verification.sourceUrl`.
 *
 * Upkeep is itself an acceptance criterion (issue #749: "the cost is
 * upkeep, so the acceptance includes it"): every entry names the exact
 * published version its `config` was last checked against and the date
 * of that check. `isAgentCatalogueEntryStale` turns "nobody has
 * re-verified this in a while" into a *visible* failure two different
 * ways rather than a silently-aging comment:
 *
 *   1. `agent-catalogue.test.ts` asserts every entry is fresh as of the
 *      real current date — a maintainer who lets an entry lapse breaks
 *      the build, out loud, the same day it happens to run.
 *   2. `instantiateAgentCatalogueEntry` itself throws
 *      {@link StaleAgentCatalogueEntryError} for an already-stale entry,
 *      so even a build that shipped *before* an entry went stale still
 *      refuses to hand back a possibly-wrong invocation once it *is*
 *      stale, rather than quietly launching whatever `command`/`args`
 *      happen to still be sitting in this file.
 *
 * Neither check is a security boundary — both exist only so "verified
 * against" stays true. The node's allowlist is what decides whether
 * anything actually runs, staleness or not.
 * --------------------------------------------------------------------- */

import { customAgentRecordV1, type CustomAgentRecordV1 } from '@loombox/protocol';

/**
 * The upkeep record every catalogue entry carries (issue #749's central
 * acceptance criterion) — never just a comment in this source file, since
 * `AgentCataloguePicker`-style UI (`NewSessionDialog`'s quick-add row)
 * renders these three fields verbatim next to the entry's name.
 */
export interface AgentCatalogueVerification {
  /** The exact published package/version this entry's `config` was checked against, e.g. `"@google/gemini-cli@0.54.0"` — a real, resolvable version, never a bare "latest". */
  against: string;
  /** ISO 8601 date (`yyyy-mm-dd`) this entry was last confirmed against `against`, by reading `sourceUrl` directly. */
  verifiedOn: string;
  /** The documentation URL actually read to confirm `config.command`/`config.args` — this agent's own docs, never a third party's guess or an unverified blog post. */
  sourceUrl: string;
  /** Days after `verifiedOn` this entry stays trusted. Past it, {@link isAgentCatalogueEntryStale} reports `true` and {@link instantiateAgentCatalogueEntry} refuses. Set per entry (not a shared constant) since agents ship on different cadences — a fast-moving CLI's ACP flag is more likely to have moved on than a stable one's. */
  staleAfterDays: number;
}

/**
 * One catalogue entry: a human-readable blurb for the picker UI, the
 * literal `CustomAgentRecordV1`-shaped fields it expands to, and the
 * verification record above. `config` is not a catalogue-only type — it
 * is the exact same shape a hand-filled "define a custom agent" form
 * produces (mirrors `McpServerPreset.config`'s own doc comment).
 */
export interface AgentCatalogueEntry {
  /** Stable catalogue id (kebab-case), independent of `config.name` — a display-name edit never breaks a caller that keyed on this. */
  id: string;
  /** Short blurb shown next to the entry's name in the quick-add UI. */
  description: string;
  /** The literal record this entry expands to, verbatim (see module doc comment). */
  config: CustomAgentRecordV1;
  verification: AgentCatalogueVerification;
}

/** Thrown by {@link instantiateAgentCatalogueEntry} for an entry past its own staleness window — see the module doc comment for why this is a thrown error, not just a UI hint. */
export class StaleAgentCatalogueEntryError extends Error {
  constructor(readonly entry: AgentCatalogueEntry) {
    super(
      `agent catalogue entry "${entry.config.name}" (${entry.id}) was last verified against ` +
        `${entry.verification.against} on ${entry.verification.verifiedOn} and is now past its ` +
        `${entry.verification.staleAfterDays}-day staleness window. Re-verify its command/args ` +
        `against ${entry.verification.sourceUrl} before trusting it again.`,
    );
    this.name = 'StaleAgentCatalogueEntryError';
  }
}

/** The instant `entry` crosses from fresh to stale — `verifiedOn` (parsed as UTC midnight) plus `staleAfterDays`. */
export function agentCatalogueEntryStaleAt(entry: AgentCatalogueEntry): Date {
  const verifiedOnMs = Date.parse(`${entry.verification.verifiedOn}T00:00:00Z`);
  return new Date(verifiedOnMs + entry.verification.staleAfterDays * 24 * 60 * 60 * 1000);
}

/** `true` once `now` has reached or passed {@link agentCatalogueEntryStaleAt}. `now` defaults to the real current time; a test passes an explicit instant instead of mocking the clock. */
export function isAgentCatalogueEntryStale(
  entry: AgentCatalogueEntry,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= agentCatalogueEntryStaleAt(entry).getTime();
}

/**
 * The starter catalogue (issue #749). Small and deliberately narrow: only
 * agents that (a) speak ACP today, (b) are not already a registered
 * loombox provider, and (c) have a real, current, checkable doc page
 * naming the exact invocation used here.
 */
export const AGENT_CATALOGUE: readonly AgentCatalogueEntry[] = [
  {
    id: 'gemini-cli',
    description:
      "Google's Gemini CLI in ACP mode — Gemini models with Google Search grounding, file ops, shell, and MCP support.",
    config: customAgentRecordV1.parse({
      name: 'Gemini CLI',
      command: 'gemini',
      args: ['--acp'],
    }),
    verification: {
      against: '@google/gemini-cli@0.54.0',
      verifiedOn: '2026-08-06',
      sourceUrl: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md',
      staleAfterDays: 180,
    },
  },
  {
    id: 'qwen-code',
    description:
      "Alibaba's Qwen Code CLI in ACP mode — Qwen3-Coder with MCP support, run via its stable `--acp` flag.",
    config: customAgentRecordV1.parse({
      name: 'Qwen Code',
      command: 'qwen',
      args: ['--acp'],
    }),
    verification: {
      against: '@qwen-code/qwen-code@0.21.6',
      verifiedOn: '2026-08-06',
      sourceUrl:
        'https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md',
      staleAfterDays: 180,
    },
  },
];

/**
 * Expands `entry` into a fresh `CustomAgentRecordV1`, the same shape a
 * hand-filled "define a custom agent" form produces — routed through the
 * exact same `customAgentRecordV1` validator (mirrors
 * `instantiateMcpPreset`'s one-liner exactly). Throws
 * {@link StaleAgentCatalogueEntryError} for an entry already past its own
 * staleness window (module doc comment) rather than handing back a record
 * this module itself no longer trusts.
 */
export function instantiateAgentCatalogueEntry(
  entry: AgentCatalogueEntry,
  now: Date = new Date(),
): CustomAgentRecordV1 {
  if (isAgentCatalogueEntryStale(entry, now)) {
    throw new StaleAgentCatalogueEntryError(entry);
  }
  return customAgentRecordV1.parse(JSON.parse(JSON.stringify(entry.config)));
}
