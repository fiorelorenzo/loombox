import { readFile } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { Client, type ConnectConfig } from 'ssh2';

import { wrapForLoginShell } from './login-shell';
import type { PortForwardTransport } from './port-forward-transport';
import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';
import type { ShellChannel, ShellChannelOptions, ShellTransport } from './shell-transport';

/**
 * Connection recipe for a real `ssh:` target (SPEC.md §5.2, §10: "a
 * maintained Node SSH library"; `ssh2` is that library — the maintained,
 * widely-used pure-JS/optional-native-accel SSH2 client for Node). Auth
 * tries, in order: an explicit private key (`privateKeyPath`), then the
 * running user's `ssh-agent` (`SSH_AUTH_SOCK`, matching SPEC §7.23's
 * autodetect: "picks up your keys and ssh-agent"), then an explicit
 * password if given. At least one of these must actually be usable or
 * `connect()` rejects with an auth-failure-shaped error.
 */
export interface Ssh2TransportConfig {
  host: string;
  port?: number;
  username: string;
  /** Path to a private key file on this node's machine (not the remote). */
  privateKeyPath?: string;
  passphrase?: string;
  /** Explicit password auth; last resort, after key/agent. */
  password?: string;
  /** Overrides `$SSH_AUTH_SOCK` autodetection; set `false` to disable agent auth entirely. */
  agent?: string | false;
  readyTimeoutMs?: number;
  /**
   * Whether `exec()` wraps every command through {@link wrapForLoginShell}
   * (issue #73's non-interactive-shell PATH fix). Defaults to `true`; set
   * `false` only for a remote known not to have `bash` (the wrapper's login
   * shell) — an unsupported, unusual host in this wave.
   */
  loginShell?: boolean;
}

/**
 * Real SSH transport, `RemoteTransport` implemented over `ssh2` (issue #80).
 * Every other mechanism in `packages/node/src/ssh/` is written against the
 * `RemoteTransport` interface and tested via `LocalProcessTransport`/
 * `FakeTransport` instead of this class directly — see `remote-transport.ts`'s
 * doc comment for why.
 *
 * `exec()` sends every command through {@link wrapForLoginShell} rather than
 * literally as-is (issue #73): `ssh2`'s `Client.exec`, like `ssh host cmd`,
 * runs a single non-login, non-interactive remote shell, which does not
 * source the profile lines a runtime manager's PATH activation typically
 * lives behind (SPEC §9). This is the one seam where that fix lives — every
 * caller above it (`RemoteProcessRunner`, `SshExecutionTarget`,
 * `verifySshTarget`, ...) keeps sending plain commands and gets the fix for
 * free.
 */
export class Ssh2Transport implements RemoteTransport, PortForwardTransport, ShellTransport {
  private client: Client | undefined;

  constructor(private readonly config: Ssh2TransportConfig) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const privateKey = this.config.privateKeyPath
      ? await readFile(this.config.privateKeyPath)
      : undefined;
    const agent =
      this.config.agent === false ? undefined : (this.config.agent ?? process.env.SSH_AUTH_SOCK);

    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port ?? 22,
      username: this.config.username,
      readyTimeout: this.config.readyTimeoutMs ?? 10_000,
      ...(privateKey ? { privateKey, passphrase: this.config.passphrase } : {}),
      ...(agent ? { agent } : {}),
      ...(this.config.password ? { password: this.config.password } : {}),
    };

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      client.on('ready', () => resolve());
      client.on('error', (error: Error) => reject(error));
      client.connect(connectConfig);
    });
    this.client = client;
  }

  async exec(command: string, options: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    const client = this.client;
    if (!client) {
      throw new Error('Ssh2Transport: not connected; call connect() first');
    }

    const loginShell = this.config.loginShell ?? true;
    const wrappedCommand = loginShell ? wrapForLoginShell(command) : command;

    return new Promise((resolve, reject) => {
      client.exec(wrappedCommand, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', (code: number | null) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
        stream.on('error', reject);

        if (options.input !== undefined) {
          stream.end(options.input);
        } else {
          stream.end();
        }
      });
    });
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = undefined;
  }

  /**
   * Opens a "direct-tcpip" channel over this connection (issue #92): `ssh2`'s
   * `Client.forwardOut`, the same wire mechanism an interactive `ssh -L`
   * uses, riding this transport's single already-open connection rather than
   * spawning a second SSH process per tunnel.
   */
  async openForwardChannel(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
  ): Promise<Duplex> {
    const client = this.client;
    if (!client) {
      throw new Error('Ssh2Transport: not connected; call connect() first');
    }

    return new Promise((resolve, reject) => {
      client.forwardOut(srcHost, srcPort, dstHost, dstPort, (err, stream) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(stream);
      });
    });
  }

  /**
   * Opens an interactive shell with a remote PTY allocated (issue #172's
   * `ssh:` terminal backend, SPEC §16 grounding): `ssh2`'s `Client.shell()`
   * with `PseudoTtyOptions`, the same wire mechanism a plain `ssh host`
   * (no command) uses. Wraps the raw `ClientChannel` into the small
   * {@link ShellChannel} contract this directory's terminal adapter
   * (`./ssh-pty-adapter.ts`) needs — `stdout` and `stderr` both feed the
   * same `onData` (a real PTY has no separate stderr stream; `ssh2` still
   * exposes one for protocol completeness, and a remote login shell with a
   * pty allocated writes everything to the one merged stream anyway, but
   * this covers the rare case something writes to the channel's stderr sub-
   * stream directly).
   */
  async openShellChannel(options: ShellChannelOptions): Promise<ShellChannel> {
    const client = this.client;
    if (!client) {
      throw new Error('Ssh2Transport: not connected; call connect() first');
    }

    const stream = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
      client.shell(
        { term: 'xterm-256color', cols: options.cols, rows: options.rows },
        (err, shellStream) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve(shellStream);
        },
      );
    });

    return {
      onData(listener) {
        const onData = (chunk: Buffer): void => listener(new Uint8Array(chunk));
        stream.on('data', onData);
        stream.stderr.on('data', onData);
        return () => {
          stream.off('data', onData);
          stream.stderr.off('data', onData);
        };
      },
      onClose(listener) {
        // `ssh2`'s `exit` event carries the process's return code when the
        // remote side reports one (SPEC §16: SSH2 makes this optional); a
        // remote shell exiting normally always sends it. `close` is the
        // channel-teardown event that always fires (whether or not `exit`
        // did) — used as the fallback so a caller is always told the
        // channel ended, even against a remote that skips `exit`.
        let exitCode: number | undefined;
        const onExit = (code: number | null): void => {
          exitCode = code ?? undefined;
        };
        const onClose = (): void => listener({ exitCode: exitCode ?? 0 });
        stream.on('exit', onExit);
        stream.on('close', onClose);
        return () => {
          stream.off('exit', onExit);
          stream.off('close', onClose);
        };
      },
      write(data) {
        stream.write(typeof data === 'string' ? data : Buffer.from(data));
      },
      resize(cols, rows) {
        stream.setWindow(rows, cols, 0, 0);
      },
      end() {
        stream.end();
      },
    };
  }
}
