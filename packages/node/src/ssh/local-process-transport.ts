import { spawn } from 'node:child_process';

import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';

/**
 * A real, local child-process stand-in for "the remote host" (issue #80's
 * hermetic testing requirement): every `exec()` call actually runs
 * `sh -c <command>` on this machine via `node:child_process`. Everything
 * built on {@link RemoteTransport} — deploy, detach via setsid/tmux/screen,
 * fifo-fed stdin, log tailing — is exercised for real (real processes, real
 * files, real `kill -0`) without a live SSH server, proving the mechanism
 * itself rather than a mock of it. Production instead uses `Ssh2Transport`.
 */
export class LocalProcessTransport implements RemoteTransport {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async exec(command: string, options: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    if (!this.connected) {
      throw new Error('LocalProcessTransport: not connected; call connect() first');
    }

    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });

      if (options.input !== undefined) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
