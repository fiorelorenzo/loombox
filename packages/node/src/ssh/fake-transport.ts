import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';

export type FakeExecHandler = (
  command: string,
  options: RemoteExecOptions,
) => RemoteExecResult | Promise<RemoteExecResult>;

export interface FakeTransportOptions {
  /** Called for every `exec()`; defaults to a handler returning `{ stdout: '', stderr: '', exitCode: 0 }` for anything. */
  onExec?: FakeExecHandler;
  /** If set, `connect()` rejects with this error instead of succeeding — for exercising unreachable-host/auth-failure paths. */
  connectError?: Error;
}

/**
 * A scriptable {@link RemoteTransport} for pure decision-logic tests (verify
 * & persist's failure-path classification, capability-detection branching)
 * that don't need a real process behind them — see `LocalProcessTransport`
 * for the "prove the mechanism for real" counterpart.
 */
export class FakeTransport implements RemoteTransport {
  readonly calls: string[] = [];
  private connected = false;

  constructor(private readonly options: FakeTransportOptions = {}) {}

  async connect(): Promise<void> {
    if (this.options.connectError) {
      throw this.options.connectError;
    }
    this.connected = true;
  }

  async exec(command: string, options: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    if (!this.connected) {
      throw new Error('FakeTransport: not connected; call connect() first');
    }
    this.calls.push(command);
    const handler = this.options.onExec ?? (() => ({ stdout: '', stderr: '', exitCode: 0 }));
    return handler(command, options);
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
