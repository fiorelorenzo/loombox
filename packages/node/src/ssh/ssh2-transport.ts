import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig } from 'ssh2';

import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';

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
}

/** Real SSH transport, `RemoteTransport` implemented over `ssh2` (issue #80). Every other mechanism in `packages/node/src/ssh/` is written against the `RemoteTransport` interface and tested via `LocalProcessTransport`/`FakeTransport` instead of this class directly — see `remote-transport.ts`'s doc comment for why. */
export class Ssh2Transport implements RemoteTransport {
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

    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
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
}
