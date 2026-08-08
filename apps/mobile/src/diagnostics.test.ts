import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDiagnostics, probeWebSocketRoundTrip, type DiagnosticsEnv } from './diagnostics';

function fakeEnv(overrides: Partial<DiagnosticsEnv> = {}): DiagnosticsEnv {
  return {
    isSecureContext: true,
    hasCryptoSubtle: true,
    locationHref: 'https://localhost/',
    localStorageRoundTrip: () => true,
    webSocketCtor: class {},
    ...overrides,
  };
}

describe('runDiagnostics', () => {
  it('passes every check against a secure-context env (the Android https://localhost / iOS capacitor://localhost claim this spike needs to confirm live)', () => {
    const results = runDiagnostics(fakeEnv());
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('fails isSecureContext and crypto.subtle together when the WebView is not a secure context, without masking the other checks', () => {
    const results = runDiagnostics(fakeEnv({ isSecureContext: false, hasCryptoSubtle: false }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.pass]));
    expect(byName['isSecureContext']).toBe(false);
    expect(byName['crypto.subtle present']).toBe(false);
    expect(byName['localStorage round-trip']).toBe(true);
  });

  it('reports localStorage failure independently (e.g. a WebView with storage disabled by policy)', () => {
    const results = runDiagnostics(fakeEnv({ localStorageRoundTrip: () => false }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.pass]));
    expect(byName['localStorage round-trip']).toBe(false);
    expect(byName['isSecureContext']).toBe(true);
  });

  it('always includes the observed origin, pass or fail, since that is what tells capacitor:// apart from https://localhost', () => {
    const results = runDiagnostics(fakeEnv({ locationHref: 'capacitor://localhost/' }));
    expect(results[0]).toEqual({
      name: 'origin',
      pass: true,
      detail: 'capacitor://localhost/',
    });
  });
});

/**
 * A minimal fake standing in for the DOM `WebSocket` — tests drive its
 * `on*` handlers directly rather than opening a real socket, so
 * {@link probeWebSocketRoundTrip}'s open/echo/error/close/timeout races are
 * exercised without any real network I/O.
 */
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

describe('probeWebSocketRoundTrip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes and echoes the reply once open fires and a message comes back', async () => {
    let created: FakeWebSocket | undefined;
    const ctor = vi.fn((url: string) => {
      created = new FakeWebSocket(url);
      return created;
    }) as unknown as typeof WebSocket;

    const pending = probeWebSocketRoundTrip(ctor, 'wss://example.test', 1000);
    created?.onopen?.();
    expect(created?.sent).toEqual(['loombox-diagnostics-probe']);
    created?.onmessage?.({ data: 'loombox-diagnostics-probe' });

    const result = await pending;
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('loombox-diagnostics-probe');
    expect(created?.closed).toBe(true);
  });

  it('fails when onerror fires before any message arrives', async () => {
    let created: FakeWebSocket | undefined;
    const ctor = vi.fn((url: string) => {
      created = new FakeWebSocket(url);
      return created;
    }) as unknown as typeof WebSocket;

    const pending = probeWebSocketRoundTrip(ctor, 'wss://example.test', 1000);
    created?.onerror?.();

    const result = await pending;
    expect(result).toEqual({ name: 'WebSocket round trip', pass: false, detail: 'onerror fired' });
  });

  it('fails on timeout when neither a message nor an error ever arrives', async () => {
    vi.useFakeTimers();
    const ctor = vi.fn(
      () => new FakeWebSocket('wss://example.test'),
    ) as unknown as typeof WebSocket;

    const pending = probeWebSocketRoundTrip(ctor, 'wss://example.test', 5000);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await pending;
    expect(result).toEqual({
      name: 'WebSocket round trip',
      pass: false,
      detail: 'timed out after 5000ms',
    });
  });

  it('never double-settles when close follows a successful message (the timeout/close/message race issue #281 needed resolved deterministically)', async () => {
    let created: FakeWebSocket | undefined;
    const ctor = vi.fn((url: string) => {
      created = new FakeWebSocket(url);
      return created;
    }) as unknown as typeof WebSocket;

    const pending = probeWebSocketRoundTrip(ctor, 'wss://example.test', 1000);
    created?.onmessage?.({ data: 'echo' });
    created?.onclose?.({ code: 1000 });

    const result = await pending;
    expect(result.pass).toBe(true);
  });
});
