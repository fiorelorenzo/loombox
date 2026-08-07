import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { SshTargetConfig } from '../target';
import { RemoteProcessRunner } from './remote-process-runner';
import type { RemoteTransport } from './remote-transport';

/**
 * Set once, by a genuine node entry point, before it constructs anything
 * that might fall back to {@link defaultNodeStateDir} — `main.ts`'s
 * `start()`, the local-node provisioning/uninstall/guided-setup flows the
 * desktop app drives directly (`provisionLocalNode`, `uninstallNode`,
 * `resolveNodeUninstallRelayOptions`, `runLocalGuidedSetup`). Nothing else
 * calls this, on purpose: a one-off `tsx` script poking at `NodeIdentityStore`
 * (or any other store below) never does, so `defaultNodeStateDir()` refuses
 * instead of silently landing on the operator's live `~/.loombox/node` —
 * issue #876, where exactly that omission (`{ stateDir2 }` typo'd instead of
 * `{ stateDir: stateDir2 }`) overwrote a running node's identity keypair.
 * Sticky for the life of the process; a real entry point only ever needs to
 * call it once, right at the top.
 */
let liveNodeStateDirAllowed = false;

export function allowLiveNodeStateDir(): void {
  liveNodeStateDirAllowed = true;
}

/**
 * Where a node persists verified `ssh:` targets, its identity, its MCP config
 * and (since #515) its session records, when no `stateDir` is injected.
 * Mirrors `@loombox/supervisor`'s `defaultStateDir()` convention, under this
 * package's own subdirectory.
 *
 * **Refuses to answer under Vitest.** These stores used to be read-mostly, so
 * a test that forgot to inject a `stateDir` was harmless. Session persistence
 * changed that: `NodeDaemon` now defaults to a persisting `SessionManager`, so
 * the same omission writes into the developer's own `~/.loombox/node`. It
 * already happened - three e2e test files left 35 phantom session records in
 * mine, which a real node would have reloaded on boot, and which made the
 * suite share one mutable file across test files. Throwing here turns that
 * class of mistake from silent corruption into a failure at the first write,
 * for every future store as well as today's.
 *
 * **Refuses outside a node entry point too (issue #876).** A production
 * identity keypair got overwritten by a plain `tsx` script that fell back
 * into this exact function — `NODE_ENV=test`/`VITEST` never fires for that
 * shape. Anything that hasn't called {@link allowLiveNodeStateDir} gets a
 * refusal instead of `~/.loombox/node`, naming `LOOMBOX_NODE_STATE_DIR` as
 * the explicit, deliberate way out: set it to wherever you actually mean
 * (a scratch `mkdtemp` dir when in doubt) and this function honors it
 * regardless of entry-point status, exactly like `main.ts`'s own config
 * loading already does for a real node.
 */
export function defaultNodeStateDir(): string {
  if (process.env.VITEST) {
    throw new Error(
      'defaultNodeStateDir(): refusing to use the real node state directory from a test. ' +
        'Pass an explicit `stateDir` (see any `mkdtemp` in packages/node/src/*.test.ts).',
    );
  }
  const stateDirOverride = process.env.LOOMBOX_NODE_STATE_DIR;
  if (stateDirOverride && stateDirOverride.trim() !== '') {
    return stateDirOverride;
  }
  if (!liveNodeStateDirAllowed) {
    throw new Error(
      'defaultNodeStateDir(): refusing to default into the live node state directory ' +
        "(~/.loombox/node) outside the node's own entry point (issue #876 — a typo'd " +
        "`stateDir` option once let a one-off script overwrite a running node's identity " +
        'this way). Pass an explicit `stateDir` to whatever you are constructing, or set ' +
        '`LOOMBOX_NODE_STATE_DIR` to the directory you actually mean. If this genuinely is ' +
        'a node entry point, call `allowLiveNodeStateDir()` once, first.',
    );
  }
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome && xdgStateHome.trim() !== '') {
    return path.join(xdgStateHome, 'loombox', 'node');
  }
  return path.join(homedir(), '.loombox', 'node');
}

/**
 * Persists the set of `ssh:` targets that have passed {@link verifySshTarget}
 * (issue #84's "on success, the target is persisted and immediately usable").
 * Plain JSON file, one write per mutation — a node's target list is small and
 * changes rarely (a guided setup flow, not a hot path), so there's no need
 * for `TranscriptStore`'s append-log design here.
 */
export class SshTargetStore {
  private readonly filePath: string;

  constructor(options: { stateDir?: string } = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, 'ssh-targets.json');
  }

  list(): SshTargetConfig[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    try {
      return JSON.parse(raw) as SshTargetConfig[];
    } catch {
      return [];
    }
  }

  get(id: string): SshTargetConfig | undefined {
    return this.list().find((target) => target.id === id);
  }

  /** Persists `config`, replacing any existing entry with the same `id`. */
  save(config: SshTargetConfig): void {
    const targets = this.list().filter((target) => target.id !== config.id);
    targets.push(config);
    this.write(targets);
  }

  remove(id: string): void {
    this.write(this.list().filter((target) => target.id !== id));
  }

  private write(targets: SshTargetConfig[]): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(targets, null, 2));
  }
}

export type SshVerifyFailureReason = 'unreachable' | 'auth_failed' | 'deploy_failed' | 'unknown';

export type SshVerifyResult =
  { ok: true } | { ok: false; reason: SshVerifyFailureReason; message: string };

/**
 * Classifies a `RemoteTransport.connect()` failure into one of the specific
 * reasons issue #84 asks a "test connection" action to report ("auth
 * failure, host unreachable, key rejected, etc."), grounded in `ssh2`'s real
 * error shapes: an auth rejection carries `.level === 'client-authentication'`
 * (host-key rejection surfaces the same way, as a `client-authentication`
 * failure after the offered credential is refused); a network-level failure
 * carries a standard Node `.code` (`ECONNREFUSED`, `ENOTFOUND`,
 * `EHOSTUNREACH`, `ETIMEDOUT`).
 */
export function classifyConnectError(error: unknown): SshVerifyFailureReason {
  if (error && typeof error === 'object') {
    const level = (error as { level?: unknown }).level;
    if (level === 'client-authentication') return 'auth_failed';

    const code = (error as { code?: unknown }).code;
    if (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'ETIMEDOUT' ||
      code === 'ENETUNREACH'
    ) {
      return 'unreachable';
    }
  }
  return 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Step 2 of the guided `ssh:` setup flow (issue #84, SPEC.md §7.23): tests a
 * candidate connection end-to-end over `transport` — connect (reachability +
 * auth), then a real deploy-and-launch-and-stop cycle of a trivial command
 * (proving the supervisor mechanism is actually deployable, not just that
 * the shell answers) — and reports success or a specific failure reason.
 * Always closes `transport` before returning, whichever path it took.
 */
export async function verifySshTarget(transport: RemoteTransport): Promise<SshVerifyResult> {
  try {
    await transport.connect();
  } catch (error) {
    return { ok: false, reason: classifyConnectError(error), message: errorMessage(error) };
  }

  try {
    const runner = new RemoteProcessRunner(transport, {
      baseDir: `/tmp/loombox-verify-${randomUUID()}`,
    });
    const probeId = randomUUID();
    try {
      const { handle, mode } = await runner.launchWithFallback(probeId, 'true');
      // A trivial command exits almost immediately; give it a moment before
      // confirming — `isRunning` returning `false` here is the *expected*
      // (successful) outcome, not evidence of failure, so this only checks
      // that launch+stop themselves didn't error.
      await runner.stop(handle);
      void mode; // deliberately unused beyond having proven a mode was chosen
    } catch (error) {
      return { ok: false, reason: 'deploy_failed', message: errorMessage(error) };
    }
    return { ok: true };
  } finally {
    await transport.close();
  }
}

/**
 * Verifies `config` (via `transportFactory(config)`, so callers can inject a
 * `FakeTransport`/`LocalProcessTransport` in tests or a real `Ssh2Transport`
 * in production) and, only on success, persists it to `store`. A failed
 * verification never touches `store` — issue #84's "a failed test leaves no
 * half-configured target behind".
 */
export async function verifyAndPersistSshTarget(
  config: SshTargetConfig,
  transportFactory: (config: SshTargetConfig) => RemoteTransport,
  store: SshTargetStore,
): Promise<SshVerifyResult> {
  const transport = transportFactory(config);
  const result = await verifySshTarget(transport);
  if (result.ok) {
    store.save(config);
  }
  return result;
}
