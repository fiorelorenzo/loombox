import type {
  AcpProvider,
  AcpProviderModule,
  AcpSpawnConfig,
  AcpTranscriptUpdate,
  AcpUpdate,
} from '@loombox/providers-core';

/**
 * Oh My Pi's ACP entrypoint.
 *
 * Unlike Claude Code and Codex, `omp acp` is not an npx-resolved bridge
 * package wrapping a separate vendor binary — `acp` is a subcommand of the
 * `omp` binary itself, which a user has necessarily already installed
 * locally to use omp at all. So the spawn recipe names `omp` directly, with
 * `acp` as its sole argument, never `npx -y <package>`.
 *
 * Verified by handshaking the real `omp acp` process over stdio in this
 * environment, twice (2026-07-28 — not a guess): `initialize` reports
 * protocolVersion `1` and `agentInfo: { name: 'oh-my-pi', title: 'Oh My
 * Pi', version: '17.1.7' }`. A full turn works end to end too: `session/new`
 * returns a sessionId plus a `configOptions` catalog (a `mode` select), and
 * prompting emits `available_commands_update`, `session_info_update`,
 * `tool_call`, `tool_call_update`, `agent_message_chunk`, and
 * `usage_update` updates, ending with `stopReason: 'end_turn'` — the same
 * transcript / tool-row / cost-meter surface loombox already renders for
 * Claude/Codex, no bespoke handling required.
 *
 * **fs capability note:** omp honours the client's negotiated fs
 * capability. With `fs.readTextFile: true` advertised, it calls back
 * `fs/read_text_file` on the client and blocks on the reply.
 * `AcpClient.initialize()` (`packages/providers/core/src/client.ts`)
 * advertises `fs: { readTextFile: false, writeTextFile: false }` — verified
 * against the real binary that with exactly those (false) capabilities, omp
 * does its own file I/O directly with zero `fs/*` callbacks, and the turn
 * still completes correctly. So no client change is required here, but
 * this is called out explicitly so nobody flips that capability flag to
 * `true` later without first implementing the `fs/read_text_file` /
 * `fs/write_text_file` request handlers omp would then start calling.
 *
 * `enrich()` is a no-op: omp has no confirmed vendor `_meta` parent-link
 * signal yet, the same position Codex is in today (see
 * `@loombox/providers-codex`'s `codexProvider` doc comment).
 */
const OHMYPI_ACP_COMMAND = 'omp';
const OHMYPI_ACP_ARGS = ['acp'];

/**
 * The Oh My Pi provider adapter: supplies the spawn config to launch `omp`
 * in ACP mode, registered under id `'ohmypi'`.
 *
 * This is the v0 `AcpProvider` shape (single-arg `enrich`), kept for parity
 * with `@loombox/providers-claude`'s `claudeProvider` and
 * `@loombox/providers-codex`'s `codexProvider`. See `ohmypiProviderModule`
 * below for the v1 `AcpProviderModule` shape this same adapter registers
 * under `ProviderRegistry`.
 */
export const ohmypiProvider: AcpProvider = {
  id: 'ohmypi',

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: OHMYPI_ACP_COMMAND,
      args: OHMYPI_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpUpdate): AcpUpdate {
    return update;
  },
};

/**
 * The v1 `AcpProviderModule` shape: registers under the same `'ohmypi'` id
 * against `ProviderRegistry`, driving the fuller `AcpTranscriptUpdate`
 * surface (`tool_call`/`plan_update`/`usage_update`) a real verified turn
 * actually emits (see the module doc comment above).
 *
 * `requiredCommand` is `'omp'` — the same value `spawnConfig` launches,
 * unlike claude/codex where the two differ (`npx` vs. the vendor CLI): omp
 * has no npx-resolved wrapper package in between, so the CLI a target's
 * PATH must carry and the CLI the spawn recipe invokes are literally the
 * same command.
 */
export const ohmypiProviderModule: AcpProviderModule = {
  id: 'ohmypi',
  requiredCommand: OHMYPI_ACP_COMMAND,

  spawnConfig(opts: { cwd: string }): AcpSpawnConfig {
    return {
      command: OHMYPI_ACP_COMMAND,
      args: OHMYPI_ACP_ARGS,
      cwd: opts.cwd,
    };
  },

  enrich(update: AcpTranscriptUpdate, _raw: unknown): AcpTranscriptUpdate {
    return update;
  },
};
