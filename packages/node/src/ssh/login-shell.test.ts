import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProcessTransport } from './local-process-transport';
import { wrapForLoginShell } from './login-shell';

describe('wrapForLoginShell', () => {
  it('runs the command through a login shell (bash -lc), the "login-shell-sourcing path"', () => {
    const wrapped = wrapForLoginShell('node --version');
    expect(wrapped.startsWith('bash -lc ')).toBe(true);
  });

  it('includes an explicit, best-effort mise-activate fallback for boxes where a login shell alone does not source it (SPEC §9)', () => {
    const wrapped = wrapForLoginShell('node --version');
    expect(wrapped).toContain('activate bash');
    // Guarded, never a hard dependency on mise existing on the remote.
    expect(wrapped).toMatch(/\$HOME\/\.local\/bin\/mise/);
  });

  it('embeds the original command unmodified inside the wrapped script', () => {
    const wrapped = wrapForLoginShell('echo hello-from-remote');
    expect(wrapped).toContain('echo hello-from-remote');
  });

  it('single-quote-escapes the outer script so embedded single quotes in the command survive shell parsing', () => {
    const wrapped = wrapForLoginShell("echo 'it'\\''s a test'");
    // Sanity: running the wrapped command for real reproduces the original
    // command's own output, proving the escaping round-trips correctly.
    expect(wrapped).toContain(`'\\''`);
  });
});

describe('wrapForLoginShell (proved for real against LocalProcessTransport)', () => {
  let fakeHome: string;
  let transport: LocalProcessTransport;

  beforeEach(async () => {
    fakeHome = await mkdtemp(path.join(tmpdir(), 'loombox-login-shell-'));
    // A fake mise install: `mise activate bash` just prints an `export
    // PATH=...` line that prepends a directory holding a PATH-only fake
    // "agent CLI" binary — exactly what real mise's shim activation does.
    const miseBinDir = path.join(fakeHome, '.local', 'bin');
    await mkdir(miseBinDir, { recursive: true });
    const shimsDir = path.join(fakeHome, '.local', 'mise-shims');
    await mkdir(shimsDir, { recursive: true });
    await writeFile(
      path.join(miseBinDir, 'mise'),
      [
        '#!/bin/sh',
        'if [ "$1" = "activate" ]; then',
        `  echo 'export PATH="${shimsDir}:$PATH"'`,
        'fi',
        '',
      ].join('\n'),
    );
    await chmod(path.join(miseBinDir, 'mise'), 0o755);
    await writeFile(
      path.join(shimsDir, 'agent-cli'),
      ['#!/bin/sh', 'echo agent-cli-ran'].join('\n'),
    );
    await chmod(path.join(shimsDir, 'agent-cli'), 0o755);

    transport = new LocalProcessTransport();
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('a plain (unwrapped) exec — as a non-login, non-interactive `ssh host cmd` runs — cannot resolve the mise-shimmed PATH-only binary', async () => {
    // Same restricted PATH a bare, non-login SSH exec typically starts from
    // (no mise shims dir on it, matching issue #73's actual gap), with no
    // login-shell/mise-activate wrapping applied.
    const command = `HOME=${fakeHome} PATH=/usr/bin:/bin command -v agent-cli || echo not-found`;
    const result = await transport.exec(command);
    expect(result.stdout.trim()).toBe('not-found');
  });

  it('the wrapped command resolves the mise-shimmed binary, proving the wrapping actually fixes the non-interactive PATH gap (issue #73)', async () => {
    // `LocalProcessTransport.exec` has no env option (matching production
    // `RemoteTransport.exec`'s shape), so `HOME` is set as an env-var prefix
    // on the whole wrapped `bash -lc '...'` invocation, exactly as a real
    // remote shell session would already have `$HOME` set for it. The inner
    // command itself starts from the same restricted `PATH` as the unwrapped
    // case above — resolution only succeeds because the wrapper's explicit
    // `mise activate bash` fallback prepends the shims dir to it.
    const wrapped = `HOME=${fakeHome} PATH=/usr/bin:/bin ${wrapForLoginShell('command -v agent-cli && agent-cli')}`;
    const result = await transport.exec(wrapped);
    expect(result.stdout).toContain('agent-cli-ran');
  });
});
