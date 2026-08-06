import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultPtySpawn, TerminalSupervisor, type TerminalSession } from '@loombox/supervisor';

import {
  EMPTY_PERMISSION_POLICY,
  type PermissionPolicy,
  type PolicyViolation,
} from './permission-policy';
import { PolicyEnforcedPty } from './policy-enforced-pty';

/**
 * Real short-lived PTY round-trips (no fakes) — `bash --noprofile --norc`,
 * exactly like `@loombox/supervisor`'s own `terminal-supervisor.test.ts`,
 * driven through {@link PolicyEnforcedPty} rather than a plain
 * `TerminalSupervisor`. This is the "central test" SPEC §7.17/issue #256
 * asks for: a real interactive shell, real typed input, real command
 * execution prevented — never a mock of this module's own matcher.
 */

let workDir: string;
let supervisor: TerminalSupervisor | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'loombox-policy-pty-'));
});

/** Waits for every still-open session to actually exit before tearing down — a `closeAll()` fire-and-forget leaves the next test's fresh PTY racing the previous one's async kill for a reused fd. */
afterEach(async () => {
  if (supervisor) {
    const exits = supervisor.list().map((session) => {
      if (session.closed) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      session.onExit(() => resolve());
      return promise;
    });
    supervisor.closeAll();
    await Promise.all(exits);
  }
  supervisor = undefined;
  await rm(workDir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error('waitFor: condition never became true within timeout');
}

function policy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return {
    command: { allow: [], deny: [], ...overrides.command },
    network: { allow: [], deny: [], ...overrides.network },
  };
}

/** Spawns a real hermetic `bash` (issue #503's `--noprofile --norc`, matching `terminal-supervisor.test.ts`) wrapped in a {@link PolicyEnforcedPty}, adopted via `TerminalSupervisor.openWithPty` — the exact seam `NodeDaemon.openTerminalForBridge` itself uses for both the `local` and `ssh:` backends. `policyValue` accepts either a static `PermissionPolicy` (wrapped in a resolver that always returns it — every existing call site's fixed-policy shape) or a resolver directly, for a test that mutates what the terminal enforces mid-session (issue #751's "no restart" acceptance). */
function openPolicyEnforcedTerminal(
  policyValue: PermissionPolicy | (() => PermissionPolicy),
  onViolation?: (violation: PolicyViolation) => void,
): TerminalSession {
  supervisor = new TerminalSupervisor();
  const realPty = defaultPtySpawn({
    terminalId: 'term-1',
    file: 'bash',
    args: ['--noprofile', '--norc'],
    cwd: workDir,
    cols: 80,
    rows: 24,
  });
  const gated = new PolicyEnforcedPty({
    inner: realPty,
    projectPath: '/proj-a',
    policy: typeof policyValue === 'function' ? policyValue : () => policyValue,
    onViolation,
  });
  return supervisor.openWithPty('term-1', gated);
}

describe('PolicyEnforcedPty — real bash over a real PTY', () => {
  it('a denied command typed + Enter never reaches the real shell: no marker file, and a rejection banner appears in the terminal output', async () => {
    const marker = path.join(workDir, 'marker');
    const session = openPolicyEnforcedTerminal(
      policy({ command: { allow: [], deny: ['touch *'] } }),
    );
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    session.write(`touch ${marker}\n`);
    await waitFor(() => output.includes('blocked by permission policy'));

    expect(existsSync(marker)).toBe(false);
    expect(output).toContain('touch *');
  });

  it('an allowed command still runs, and the terminal keeps working for the next line', async () => {
    const session = openPolicyEnforcedTerminal(policy({ command: { allow: [], deny: ['rm *'] } }));
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    session.write('echo hello-pty\n');
    await waitFor(() => output.includes('hello-pty'));
  });

  it('EMPTY_PERMISSION_POLICY (absent policy) behaves exactly like an unwrapped terminal', async () => {
    const marker = path.join(workDir, 'marker');
    const session = openPolicyEnforcedTerminal(EMPTY_PERMISSION_POLICY);

    session.write(`touch ${marker}\n`);
    await waitFor(() => existsSync(marker));
  });

  it('deny wins over an overlapping allow rule', async () => {
    const marker = path.join(workDir, 'marker');
    const session = openPolicyEnforcedTerminal(
      policy({ command: { allow: ['touch *'], deny: ['touch *'] } }),
    );
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    session.write(`touch ${marker}\n`);
    await waitFor(() => output.includes('blocked by permission policy'));
    expect(existsSync(marker)).toBe(false);
  });

  it('tracks backspace edits: a typo corrected before Enter is judged on the final, corrected line', async () => {
    const marker = path.join(workDir, 'marker');
    const session = openPolicyEnforcedTerminal(
      policy({ command: { allow: [], deny: ['touch *'] } }),
    );
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    // Type "touch <marker>WRONG", backspace away "WRONG", then submit —
    // the buffered line at Enter-time is exactly "touch <marker>".
    session.write(`touch ${marker}WRONG`);
    session.write('\x7f\x7f\x7f\x7f\x7f'); // 5 backspaces, one per stray char
    session.write('\n');

    await waitFor(() => output.includes('blocked by permission policy'));
    expect(existsSync(marker)).toBe(false);
  });

  it('calls onViolation and logs, naming the project/rule/matched line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onViolation = vi.fn();
    const session = openPolicyEnforcedTerminal(
      policy({ command: { allow: [], deny: ['touch *'] } }),
      onViolation,
    );

    session.write(`touch ${path.join(workDir, 'marker')}\n`);
    await waitFor(() => onViolation.mock.calls.length > 0);

    expect(onViolation.mock.calls[0]![0]).toMatchObject({
      projectPath: '/proj-a',
      surface: 'terminal',
      dimension: 'command',
      rule: 'touch *',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('re-reads the policy on every submitted line, never a construction-time snapshot: a policy mutated after this terminal opened blocks the very next line, no reconnect (issue #751)', async () => {
    const marker = path.join(workDir, 'marker');
    let currentPolicy = policy();
    const session = openPolicyEnforcedTerminal(() => currentPolicy);
    let output = '';
    session.onData((chunk) => {
      output += Buffer.from(chunk).toString('utf8');
    });

    session.write('echo before-policy\n');
    await waitFor(() => output.includes('before-policy'));

    // Mutate what the resolver returns — no new terminal, no reconnect.
    currentPolicy = policy({ command: { allow: [], deny: ['touch *'] } });

    session.write(`touch ${marker}\n`);
    await waitFor(() => output.includes('blocked by permission policy'));
    expect(existsSync(marker)).toBe(false);
  });

  describe('network dimension — a real local TCP listener', () => {
    let server: Server;
    let port: number;
    let connections: number;

    beforeEach(async () => {
      connections = 0;
      server = createServer((socket) => {
        connections += 1;
        socket.end();
      });
      const { promise: listening, resolve: onListening } = Promise.withResolvers<void>();
      server.listen(0, '127.0.0.1', onListening);
      await listening;
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected server.address() to be an AddressInfo');
      }
      port = address.port;
    });

    afterEach(async () => {
      const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
      server.close(() => onClosed());
      await closed;
    });

    it('a network deny match stops a typed connection attempt before it dials out', async () => {
      const dest = `127.0.0.1:${port}`;
      const session = openPolicyEnforcedTerminal(policy({ network: { allow: [], deny: [dest] } }));
      let output = '';
      session.onData((chunk) => {
        output += Buffer.from(chunk).toString('utf8');
      });

      session.write(
        `${process.execPath} -e "require('net').createConnection(${port}, '127.0.0.1')" ${dest}\n`,
      );
      await waitFor(() => output.includes('blocked by permission policy'));
      expect(connections).toBe(0);
    });
  });
});
