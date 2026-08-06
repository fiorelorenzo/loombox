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

/**
 * Polls `check()` on a real interval — kept, as the sole survivor of this
 * shape in the file (issue #793), only for the marker-file-exists check
 * below: filesystem completion has no callback/event to hook the way the
 * PTY's own `onData` does, and this is a real spawned `bash` writing to a
 * real file, so there is no fake-timer clock to drive deterministically
 * either — `vi.useFakeTimers()` only fakes JS timers, not a real OS
 * process's real-world execution time.
 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!check()) throw new Error('waitFor: condition never became true within timeout');
}

/**
 * Resolves the instant the session's output stream matches `predicate`,
 * driven directly by the `onData` event as chunks arrive — not by
 * re-checking an accumulated buffer against a wall-clock deadline every
 * 20ms the way `waitFor` above does. That poll-until-deadline shape was
 * this suite's actual bug (issue #793): a real bash PTY round trip under a
 * loaded CI runner routinely took longer than the fixed poll window, so
 * the test failed on its own clock rather than on anything false — three
 * times running, since this package's `retry: 2` (`vitest.config.ts`)
 * can't rescue a deterministic clock loss. `predicate` sees the *whole*
 * buffer received so far, not just the latest chunk, since the banner and
 * any prior output can land split across multiple `onData` calls.
 *
 * Still backstopped by `timeoutMs` as a real (not fake) wall-clock
 * `setTimeout` — a deliberate exception, not the primary synchronisation:
 * this drives a real `bash` process over a real PTY, which has no
 * fake-timer equivalent to advance deterministically, so a genuine "the
 * banner never arrives at all" regression still needs a real clock to
 * eventually give up on. `20_000` mirrors this package's own real-PTY
 * bound used elsewhere for the same "spawn bash, round-trip one typed
 * line" class of wait (`node-daemon.test.ts`'s local-terminal tests and
 * `node-daemon-permission-policy.test.ts`'s wired policy tests, both
 * `{ retry: 0, timeout: 20000 }`, with the same "real PTY, not a flake"
 * reasoning in their own comments).
 */
function waitForOutput(
  session: TerminalSession,
  predicate: (buffered: string) => boolean,
  timeoutMs = 20_000,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let buffered = '';
  const timer = setTimeout(() => {
    unsubscribe();
    reject(
      new Error(
        `waitForOutput: predicate never matched within ${timeoutMs}ms. Output so far: ${JSON.stringify(buffered)}`,
      ),
    );
  }, timeoutMs);
  const unsubscribe = session.onData((chunk) => {
    buffered += Buffer.from(chunk).toString('utf8');
    if (predicate(buffered)) {
      clearTimeout(timer);
      unsubscribe();
      resolve(buffered);
    }
  });
  return promise;
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

// Every `it` below is given an explicit `{ timeout: 20_000 }` (issue #793):
// vitest's own per-test default is 5000ms, and that — not the waitFor/
// waitForOutput helpers above — was the actual bound this suite kept
// hitting under a loaded CI runner (and, confirmed locally on this box
// too): a real `bash --noprofile --norc` round trip through a real PTY
// routinely clears 5s under load well before anything is actually wrong.
// `20_000` matches this package's own established bound for the same
// "spawn a real shell, round-trip one typed line" class of test
// (`node-daemon.test.ts`'s local-terminal tests, `{ retry: 0, timeout:
// 20000 }`); unlike those, this file keeps the package's default `retry:
// 2` (`vitest.config.ts`) rather than `retry: 0`, since that retry budget
// predates and was sized for exactly this file's real-PTY flakiness.

describe('PolicyEnforcedPty — real bash over a real PTY', () => {
  it(
    'a denied command typed + Enter never reaches the real shell: no marker file, and a rejection banner appears in the terminal output',
    { timeout: 20_000 },
    async () => {
      const marker = path.join(workDir, 'marker');
      const session = openPolicyEnforcedTerminal(
        policy({ command: { allow: [], deny: ['touch *'] } }),
      );

      // Subscribed *before* the write: `PolicyEnforcedPty` broadcasts a
      // denied line's banner synchronously inside `write()` itself (see
      // that class's own doc comment), before `write()` even returns, so a
      // listener attached only after the call would miss it entirely.
      const banner = waitForOutput(session, (buffered) =>
        buffered.includes('blocked by permission policy'),
      );
      session.write(`touch ${marker}\n`);
      const output = await banner;

      // The real ordering guarantee this test is about: the marker's absence
      // is only meaningful proof of "never reached the shell" once the
      // rejection banner has actually arrived. Any earlier, "no marker yet"
      // could just as well mean the real shell simply hasn't finished the
      // round trip yet, not that it was blocked.
      expect(existsSync(marker)).toBe(false);
      expect(output).toContain('touch *');
    },
  );

  it(
    'an allowed command still runs, and the terminal keeps working for the next line',
    { timeout: 20_000 },
    async () => {
      const session = openPolicyEnforcedTerminal(
        policy({ command: { allow: [], deny: ['rm *'] } }),
      );

      // Allowed lines are forwarded to the real inner PTY and echoed back
      // asynchronously by the real shell, so — unlike the denied-command
      // banner above — there is no synchronous-broadcast race to beat by
      // subscribing first; still done in the same order for consistency.
      const echoed = waitForOutput(session, (buffered) => buffered.includes('hello-pty'));
      session.write('echo hello-pty\n');
      await echoed;
    },
  );

  it(
    'EMPTY_PERMISSION_POLICY (absent policy) behaves exactly like an unwrapped terminal',
    { timeout: 20_000 },
    async () => {
      const marker = path.join(workDir, 'marker');
      const session = openPolicyEnforcedTerminal(EMPTY_PERMISSION_POLICY);

      session.write(`touch ${marker}\n`);
      await waitFor(() => existsSync(marker));
    },
  );

  it('deny wins over an overlapping allow rule', { timeout: 20_000 }, async () => {
    const marker = path.join(workDir, 'marker');
    const session = openPolicyEnforcedTerminal(
      policy({ command: { allow: ['touch *'], deny: ['touch *'] } }),
    );

    const banner = waitForOutput(session, (buffered) =>
      buffered.includes('blocked by permission policy'),
    );
    session.write(`touch ${marker}\n`);
    await banner;
    expect(existsSync(marker)).toBe(false);
  });

  it(
    'tracks backspace edits: a typo corrected before Enter is judged on the final, corrected line',
    { timeout: 20_000 },
    async () => {
      const marker = path.join(workDir, 'marker');
      const session = openPolicyEnforcedTerminal(
        policy({ command: { allow: [], deny: ['touch *'] } }),
      );

      // Type "touch <marker>WRONG", backspace away "WRONG", then submit —
      // the buffered line at Enter-time is exactly "touch <marker>".
      // Subscribed before the final Enter write, which is what actually
      // triggers `PolicyEnforcedPty`'s synchronous banner broadcast.
      const banner = waitForOutput(session, (buffered) =>
        buffered.includes('blocked by permission policy'),
      );
      session.write(`touch ${marker}WRONG`);
      session.write('\x7f\x7f\x7f\x7f\x7f'); // 5 backspaces, one per stray char
      session.write('\n');
      await banner;
      expect(existsSync(marker)).toBe(false);
    },
  );

  it(
    'calls onViolation and logs, naming the project/rule/matched line',
    { timeout: 20_000 },
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { promise: violationSeen, resolve: onViolationSeen } = Promise.withResolvers<void>();
      const onViolation = vi.fn();
      const session = openPolicyEnforcedTerminal(
        policy({ command: { allow: [], deny: ['touch *'] } }),
        (violation) => {
          onViolation(violation);
          onViolationSeen();
        },
      );

      session.write(`touch ${path.join(workDir, 'marker')}\n`);
      // Driven straight off the callback firing, not a poll of
      // `onViolation.mock.calls.length` against a deadline: the callback IS
      // the event this test depends on.
      await violationSeen;

      expect(onViolation.mock.calls[0]![0]).toMatchObject({
        projectPath: '/proj-a',
        surface: 'terminal',
        dimension: 'command',
        rule: 'touch *',
      });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it(
    're-reads the policy on every submitted line, never a construction-time snapshot: a policy mutated after this terminal opened blocks the very next line, no reconnect (issue #751)',
    { timeout: 20_000 },
    async () => {
      const marker = path.join(workDir, 'marker');
      let currentPolicy = policy();
      const session = openPolicyEnforcedTerminal(() => currentPolicy);

      const beforePolicy = waitForOutput(session, (buffered) => buffered.includes('before-policy'));
      session.write('echo before-policy\n');
      await beforePolicy;

      // Mutate what the resolver returns — no new terminal, no reconnect.
      currentPolicy = policy({ command: { allow: [], deny: ['touch *'] } });

      const banner = waitForOutput(session, (buffered) =>
        buffered.includes('blocked by permission policy'),
      );
      session.write(`touch ${marker}\n`);
      await banner;
      expect(existsSync(marker)).toBe(false);
    },
  );

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

    it(
      'a network deny match stops a typed connection attempt before it dials out',
      { timeout: 20_000 },
      async () => {
        const dest = `127.0.0.1:${port}`;
        const session = openPolicyEnforcedTerminal(
          policy({ network: { allow: [], deny: [dest] } }),
        );

        const banner = waitForOutput(session, (buffered) =>
          buffered.includes('blocked by permission policy'),
        );
        session.write(
          `${process.execPath} -e "require('net').createConnection(${port}, '127.0.0.1')" ${dest}\n`,
        );
        await banner;
        expect(connections).toBe(0);
      },
    );
  });
});
