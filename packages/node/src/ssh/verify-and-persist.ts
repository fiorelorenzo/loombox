import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { SshTargetConfig } from '../target';
import { RemoteProcessRunner } from './remote-process-runner';
import type { RemoteTransport } from './remote-transport';

/** Where a node persists verified `ssh:` targets when no `stateDir` is injected. Mirrors `@loombox/supervisor`'s `defaultStateDir()` convention, under this package's own subdirectory. */
export function defaultNodeStateDir(): string {
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
