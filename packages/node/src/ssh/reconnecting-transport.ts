import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';

/**
 * Wraps a `RemoteTransport` factory with automatic reconnection (issue #71:
 * "a per-target connection pool that transparently re-establishes a dropped
 * SSH connection mid-session"). `RemoteTransport` stays the interface every
 * caller (`RemoteProcessRunner`, `RemoteAgentChildProcess`,
 * `verifySshTarget`, ...) already codes against — nothing above this wrapper
 * needs to know it exists; see `remote-transport.ts`'s doc comment.
 *
 * `createTransport` is called once for the initial `connect()` and again
 * every time a reconnect is needed. A fresh instance every time, never a
 * reused one: the production transport (`Ssh2Transport`) can't resurrect a
 * closed `ssh2` `Client`, so this is the one convention that keeps this
 * wrapper correct for every `RemoteTransport` implementation (the hermetic
 * doubles, `LocalProcessTransport`/`FakeTransport`, are equally happy either
 * way since they hold no OS-level connection).
 */
export type TransportConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** Queryable health/status for one pooled connection (issue #71's "the transport exposes a queryable health/status per host"). */
export interface TransportHealth {
  status: TransportConnectionStatus;
  /** Consecutive failed (re)connect attempts since the last successful connect; reset to 0 on every success. */
  attempts: number;
  /** The most recent connect/exec failure's message, if any. Cleared on a successful (re)connect. */
  lastError?: string;
  /** `Date.now()` of the last successful connect, if currently connected. */
  connectedSince?: number;
}

export interface ReconnectingTransportOptions {
  /** Delay before the first reconnect attempt, in ms (default 500). */
  initialBackoffMs?: number;
  /** Cap on the exponentially-growing backoff delay, in ms (default 10s). */
  maxBackoffMs?: number;
  /** Consecutive failed attempts before giving up and surfacing a permanent failure (default 5) — so a truly dead host fails cleanly instead of retrying forever. */
  maxAttempts?: number;
  /** Classifies whether a `connect()`/`exec()` failure is worth reconnecting over (a transient network blip) versus one that should propagate immediately (e.g. bad credentials). Defaults to {@link defaultIsRetryableError}. */
  isRetryableError?: (error: unknown) => boolean;
  /** Injectable delay for tests; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
]);

const RETRYABLE_MESSAGE = /closed|not connected|broken pipe|socket hang up|connection lost/i;

/**
 * Default retry classification: a `ssh2`/network-shaped transient failure
 * (dropped socket, refused/unreachable/timed-out connection) is retryable;
 * an auth rejection (`ssh2`'s `error.level === 'client-authentication'`,
 * mirroring `classifyConnectError` in `verify-and-persist.ts`) is not —
 * retrying with the same bad credentials would just fail again forever.
 */
export function defaultIsRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { level?: unknown }).level === 'client-authentication') return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;

  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_MESSAGE.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ReconnectingTransport implements RemoteTransport {
  private inner: RemoteTransport | undefined;
  private status: TransportConnectionStatus = 'disconnected';
  private attempts = 0;
  private lastError: string | undefined;
  private connectedSince: number | undefined;
  private reconnectPromise: Promise<RemoteTransport> | undefined;
  /** Bumped by `close()` so an in-flight reconnect attempt that resolves after `close()` was called discards its freshly-opened transport instead of resurrecting the connection. */
  private generation = 0;

  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly isRetryableError: (error: unknown) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly createTransport: () => RemoteTransport,
    options: ReconnectingTransportOptions = {},
  ) {
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.isRetryableError = options.isRetryableError ?? defaultIsRetryableError;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Queryable connection health (issue #71's acceptance criterion), a snapshot at call time. */
  getHealth(): TransportHealth {
    return {
      status: this.status,
      attempts: this.attempts,
      lastError: this.lastError,
      connectedSince: this.connectedSince,
    };
  }

  /** Establishes the connection if not already connected. Idempotent while connected; concurrent callers share one in-flight attempt. Failures are NOT retried at this layer directly — a `connect()`-time failure marks the transport `failed`, matching `RemoteTransport`'s existing "rejects with a descriptive error" contract; reconnection-with-backoff is what `exec()` does transparently once a session is actually underway (issue #71's "mid-session" scope). */
  async connect(): Promise<void> {
    if (this.status === 'connected') return;
    await this.reconnect();
  }

  async exec(command: string, options: RemoteExecOptions = {}): Promise<RemoteExecResult> {
    let transport = this.status === 'connected' && this.inner ? this.inner : await this.reconnect();
    // Bounds *this call's* reconnect-and-retry cycles (a repeatedly
    // flapping link, not just a single blip) separately from
    // `reconnectLoop`'s own per-attempt backoff budget — so a caller's
    // in-flight exec() still gives up cleanly rather than looping forever
    // if every fresh connection keeps immediately dying on first use.
    let execRetries = 0;

    for (;;) {
      try {
        const result = await transport.exec(command, options);
        this.attempts = 0;
        return result;
      } catch (error) {
        if (!this.isRetryableError(error)) throw error;

        // Only tear down the connection if it's still the one we think is
        // current: a concurrent exec() call may have already lost this same
        // race and reconnected out from under us (no `await` happens
        // between this check and the assignment, so it's race-free).
        if (this.inner === transport) {
          this.inner = undefined;
          this.status = 'disconnected';
          await transport.close().catch(() => {});
        }

        execRetries += 1;
        if (execRetries > this.maxAttempts) {
          this.status = 'failed';
          this.lastError = errorMessage(error);
          throw toError(error);
        }

        transport = await this.reconnect();
      }
    }
  }

  async close(): Promise<void> {
    this.generation += 1;
    const transport = this.inner;
    this.inner = undefined;
    this.status = 'disconnected';
    this.attempts = 0;
    this.lastError = undefined;
    this.connectedSince = undefined;
    if (transport) {
      await transport.close().catch(() => {});
    }
  }

  /** Dedups concurrent reconnect requests onto one in-flight backoff loop, so a mid-session drop noticed by two overlapping callers doesn't open two competing connections. */
  private async reconnect(): Promise<RemoteTransport> {
    if (this.reconnectPromise) return this.reconnectPromise;
    const generation = this.generation;
    const attempt = this.reconnectLoop(generation).finally(() => {
      if (this.reconnectPromise === attempt) this.reconnectPromise = undefined;
    });
    this.reconnectPromise = attempt;
    return attempt;
  }

  private backoffFor(attempt: number): number {
    const exp = this.initialBackoffMs * 2 ** (attempt - 1);
    return Math.min(exp, this.maxBackoffMs);
  }

  private async reconnectLoop(generation: number): Promise<RemoteTransport> {
    this.status = this.attempts > 0 ? 'reconnecting' : 'connecting';
    for (;;) {
      let transport: RemoteTransport;
      try {
        transport = this.createTransport();
        await transport.connect();
      } catch (error) {
        this.attempts += 1;
        this.lastError = errorMessage(error);
        if (!this.isRetryableError(error) || this.attempts >= this.maxAttempts) {
          this.status = 'failed';
          throw toError(error);
        }
        this.status = 'reconnecting';
        await this.sleep(this.backoffFor(this.attempts));
        continue;
      }

      if (generation !== this.generation) {
        // `close()` ran while this attempt was in flight — discard rather
        // than resurrect a connection the caller already gave up on, and
        // don't feed this into the retry-with-backoff loop above: giving up
        // was requested explicitly, so it isn't a transient failure to
        // retry through.
        await transport.close().catch(() => {});
        this.status = 'failed';
        throw new Error('ReconnectingTransport: closed during reconnect');
      }

      this.inner = transport;
      this.status = 'connected';
      this.attempts = 0;
      this.lastError = undefined;
      this.connectedSince = Date.now();
      return transport;
    }
  }
}
