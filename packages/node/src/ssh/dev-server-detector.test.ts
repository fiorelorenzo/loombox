import { createServer, createConnection, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDevServerBanner, DevServerForwardDetector } from './dev-server-detector';
import { PortForwardRuleManager } from './port-forward-rules';
import type { PortForwardTransport } from './port-forward-transport';

describe('parseDevServerBanner', () => {
  it('parses a vite-style banner', () => {
    const match = parseDevServerBanner('  ➜  Local:   http://localhost:5173/');
    expect(match).toEqual({
      url: 'http://localhost:5173/',
      host: 'localhost',
      port: 5173,
      pathAndQuery: '/',
    });
  });

  it('parses a next.js-style banner', () => {
    const match = parseDevServerBanner('   - Local:        http://localhost:3000');
    expect(match).toMatchObject({ host: 'localhost', port: 3000 });
  });

  it('parses a 127.0.0.1 banner with a path', () => {
    const match = parseDevServerBanner('Local: http://127.0.0.1:4321/app?x=1');
    expect(match).toEqual({
      url: 'http://127.0.0.1:4321/app?x=1',
      host: '127.0.0.1',
      port: 4321,
      pathAndQuery: '/app?x=1',
    });
  });

  it('strips embedded ANSI color codes', () => {
    const match = parseDevServerBanner('  ➜  Local:   [32mhttp://localhost:5173/[39m');
    expect(match).toMatchObject({ host: 'localhost', port: 5173 });
  });

  it('ignores lines with no Local: banner', () => {
    expect(parseDevServerBanner('vite v5.0.0 ready in 300 ms')).toBeUndefined();
    expect(parseDevServerBanner('Compiled successfully!')).toBeUndefined();
  });

  it('ignores a Local: URL pointing at a non-loopback host', () => {
    expect(parseDevServerBanner('Local: http://192.168.1.5:3000/')).toBeUndefined();
  });

  it('ignores a malformed URL after Local:', () => {
    expect(parseDevServerBanner('Local: not-a-url')).toBeUndefined();
  });
});

/** Opens real local TCP connections to `remotePort`, standing in for the SSH
 * server's own "direct-tcpip" forwarding — fails until `listening` is set,
 * so tests can control exactly when the "remote dev server" becomes
 * reachable, proving the detector really probes rather than assuming. */
class FakeProbeTransport implements PortForwardTransport {
  listening = false;
  readonly openAttempts: Array<{ dstHost: string; dstPort: number }> = [];

  constructor(private readonly remotePort: number) {}

  async openForwardChannel(
    _srcHost: string,
    _srcPort: number,
    dstHost: string,
    dstPort: number,
  ): Promise<Duplex> {
    this.openAttempts.push({ dstHost, dstPort });
    if (!this.listening) {
      throw new Error('FakeProbeTransport: connection refused (nothing listening yet)');
    }
    return createConnection({ host: '127.0.0.1', port: this.remotePort });
  }
}

describe('DevServerForwardDetector (issue #94)', () => {
  let devServer: Server;
  let devServerPort: number;
  let transport: FakeProbeTransport;
  let ruleManager: PortForwardRuleManager;
  let detector: DevServerForwardDetector;

  beforeEach(async () => {
    devServer = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', () => resolve()));
    const address = devServer.address();
    devServerPort = typeof address === 'object' && address ? address.port : 0;
    transport = new FakeProbeTransport(devServerPort);
    ruleManager = new PortForwardRuleManager(async () => transport);
    detector = new DevServerForwardDetector(transport, ruleManager, {
      targetId: 'devbox',
      probeIntervalMs: 5,
      probeMaxAttempts: 10,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
  });

  it('ignores stdout lines with no dev-server banner', async () => {
    const result = await detector.feed('vite v5.0.0 ready in 320 ms');
    expect(result).toBeUndefined();
    expect(ruleManager.list()).toEqual([]);
  });

  it('detects a banner, probes reachability, and auto-forwards once the port is actually listening', async () => {
    // The banner arrives, but the port isn't reachable yet (a realistic
    // ordering issue #94 explicitly guards against — SPEC/§16: "PTY-output
    // URL sniff + probe, not port-table scan").
    const feedPromise = detector.feed(`  ➜  Local:   http://localhost:${devServerPort}/`);

    // Still refusing after a short delay: no rule created prematurely.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ruleManager.list()).toEqual([]);

    transport.listening = true;
    const forward = await feedPromise;

    expect(forward).toBeDefined();
    expect(forward!.rule.origin).toBe('auto');
    expect(forward!.rule.targetId).toBe('devbox');
    expect(forward!.rule.remotePort).toBe(devServerPort);
    expect(forward!.localUrl).toBe(`http://${forward!.rule.localHost}:${forward!.rule.localPort}/`);

    // The forwarded local port really works.
    const socket = createConnection({
      host: forward!.rule.localHost,
      port: forward!.rule.localPort,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      socket.on('error', reject);
      socket.write('hello dev server');
    });
    expect(echoed).toBe('hello dev server');
    socket.destroy();
  });

  it('preserves the banner path/query in the reported local URL', async () => {
    transport.listening = true;
    const forward = await detector.feed(`Local: http://localhost:${devServerPort}/app?x=1`);
    expect(forward!.localUrl).toBe(
      `http://${forward!.rule.localHost}:${forward!.rule.localPort}/app?x=1`,
    );
  });

  it('never creates a rule when the remote port never becomes reachable within the probe budget', async () => {
    const result = await detector.feed(`Local: http://localhost:${devServerPort}/`);
    expect(result).toBeUndefined();
    expect(ruleManager.list()).toEqual([]);
    expect(transport.openAttempts.length).toBe(10);
  });

  it('does not create a second rule for a banner it already forwarded', async () => {
    transport.listening = true;
    const first = await detector.feed(`Local: http://localhost:${devServerPort}/`);
    const second = await detector.feed(`Local: http://localhost:${devServerPort}/`);

    expect(second!.rule.id).toBe(first!.rule.id);
    expect(ruleManager.list()).toHaveLength(1);
  });

  it('calls onForward once a rule is auto-created', async () => {
    const onForward = vi.fn();
    detector = new DevServerForwardDetector(transport, ruleManager, {
      targetId: 'devbox',
      probeIntervalMs: 5,
      probeMaxAttempts: 10,
      onForward,
    });
    transport.listening = true;
    const forward = await detector.feed(`Local: http://localhost:${devServerPort}/`);
    expect(onForward).toHaveBeenCalledWith(forward);
  });
});
