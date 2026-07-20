import { createServer, createConnection, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { openPortForwardTunnel, type PortForwardTunnel } from './port-forward-tunnel';
import type { PortForwardTransport } from './port-forward-transport';
import { supportsPortForward } from './port-forward-transport';
import { Ssh2Transport } from './ssh2-transport';

async function writeAndExpect(socket: Socket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.length >= payload.length) resolve(received);
    });
    socket.on('error', reject);
    socket.write(payload);
  });
}

/**
 * A scriptable {@link PortForwardTransport} for the control-logic tests
 * (issue #92's "testable via the fake transport for the control logic"):
 * `openForwardChannel` opens a *real* local TCP connection to
 * `fakeRemoteServer` (a real in-process `net.Server` standing in for "the
 * remote destination"), so `port-forward-tunnel.ts`'s own logic — listener
 * setup, per-connection channel opening, piping both directions, close/
 * teardown of live connections — is exercised for real, with no `ssh2`/
 * Docker involved at all.
 */
class FakePortForwardTransport implements PortForwardTransport {
  readonly calls: Array<{ srcHost: string; srcPort: number; dstHost: string; dstPort: number }> =
    [];
  failNext = false;

  constructor(private readonly remotePort: number) {}

  async openForwardChannel(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
  ): Promise<Duplex> {
    this.calls.push({ srcHost, srcPort, dstHost, dstPort });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('FakePortForwardTransport: simulated forward failure');
    }
    return createConnection({ host: '127.0.0.1', port: this.remotePort });
  }
}

describe('supportsPortForward', () => {
  it('detects a transport with openForwardChannel', () => {
    expect(supportsPortForward(new FakePortForwardTransport(1))).toBe(true);
  });

  it('rejects a transport without it', () => {
    expect(supportsPortForward({ exec: async () => ({}) })).toBe(false);
    expect(supportsPortForward(null)).toBe(false);
    expect(supportsPortForward(42)).toBe(false);
  });
});

describe('openPortForwardTunnel (hermetic, control logic against a fake transport + a real local echo server)', () => {
  let echoServer: Server;
  let echoPort: number;
  let fakeTransport: FakePortForwardTransport;
  let tunnel: PortForwardTunnel | undefined;

  beforeEach(async () => {
    echoServer = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', () => resolve()));
    const address = echoServer.address();
    echoPort = typeof address === 'object' && address ? address.port : 0;
    fakeTransport = new FakePortForwardTransport(echoPort);
  });

  afterEach(async () => {
    await tunnel?.close();
    tunnel = undefined;
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  });

  it('proxies a local connection to the remote destination and back', async () => {
    tunnel = await openPortForwardTunnel(fakeTransport, {
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
    });

    expect(tunnel.localPort).toBeGreaterThan(0);

    const socket = createConnection({ host: tunnel.localHost, port: tunnel.localPort });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    const echoed = await writeAndExpect(socket, 'hello through the tunnel');
    expect(echoed).toBe('hello through the tunnel');
    socket.destroy();

    expect(fakeTransport.calls).toHaveLength(1);
    expect(fakeTransport.calls[0]).toMatchObject({ dstHost: '127.0.0.1', dstPort: echoPort });
  });

  it('shares one transport across multiple simultaneous tunneled connections', async () => {
    tunnel = await openPortForwardTunnel(fakeTransport, {
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
    });

    const sockets = await Promise.all(
      [1, 2, 3].map(async () => {
        const socket = createConnection({ host: tunnel!.localHost, port: tunnel!.localPort });
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve());
          socket.once('error', reject);
        });
        return socket;
      }),
    );

    const results = await Promise.all(sockets.map((s, i) => writeAndExpect(s, `msg-${i}`)));
    expect(results).toEqual(['msg-0', 'msg-1', 'msg-2']);
    expect(fakeTransport.calls).toHaveLength(3);

    sockets.forEach((s) => s.destroy());
  });

  it('reports a per-connection forward failure via onConnectionError without killing the tunnel', async () => {
    const onConnectionError = vi.fn();
    fakeTransport.failNext = true;
    tunnel = await openPortForwardTunnel(fakeTransport, {
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
      onConnectionError,
    });

    const firstSocket = createConnection({ host: tunnel.localHost, port: tunnel.localPort });
    await new Promise<void>((resolve) => firstSocket.once('close', () => resolve()));
    await vi.waitFor(() => expect(onConnectionError).toHaveBeenCalledTimes(1));

    // The tunnel itself is still alive for a subsequent, successful connection.
    const secondSocket = createConnection({ host: tunnel.localHost, port: tunnel.localPort });
    await new Promise<void>((resolve, reject) => {
      secondSocket.once('connect', () => resolve());
      secondSocket.once('error', reject);
    });
    const echoed = await writeAndExpect(secondSocket, 'still alive');
    expect(echoed).toBe('still alive');
    secondSocket.destroy();
  });

  it('close() stops accepting new connections and tears down active ones', async () => {
    tunnel = await openPortForwardTunnel(fakeTransport, {
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
    });
    const { localHost, localPort } = tunnel;

    const socket = createConnection({ host: localHost, port: localPort });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(tunnel!.activeConnections).toBe(1));

    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await tunnel.close();
    await socketClosed;

    // A fresh connection attempt after close() is refused, not hung.
    const afterClose = createConnection({ host: localHost, port: localPort });
    await new Promise<void>((resolve) => {
      afterClose.once('error', () => resolve());
      afterClose.once('connect', () => resolve());
    });
    expect(afterClose.destroyed || !afterClose.readable).toBe(true);

    // Idempotent.
    await expect(tunnel.close()).resolves.toBeUndefined();
    tunnel = undefined;
  });

  it('defaults to binding 127.0.0.1 and picks a free port when localPort is omitted', async () => {
    tunnel = await openPortForwardTunnel(fakeTransport, {
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
    });
    expect(tunnel.localHost).toBe('127.0.0.1');
    expect(Number.isInteger(tunnel.localPort)).toBe(true);
    expect(tunnel.localPort).toBeGreaterThan(0);
  });
});

// Real-sshd integration (issue #92's "integration test uses a simple TCP
// echo server on the remote side of the Dockerized SSH fixture"), proving
// the *real* ssh2 forwardOut path, not just the fake control-logic path
// above.
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  'openPortForwardTunnel (Dockerized sshd fixture, issues #70/#92)',
  () => {
    let fixture: DockerSshdFixture;
    let transport: Ssh2Transport;

    beforeAll(async () => {
      fixture = await startDockerSshdFixture();
    }, 120_000);

    afterAll(async () => {
      await fixture?.stop();
    }, 30_000);

    beforeEach(async () => {
      transport = new Ssh2Transport({
        host: fixture.host,
        port: fixture.port,
        username: fixture.username,
        privateKeyPath: fixture.privateKeyPath,
      });
      await transport.connect();
    });

    afterEach(async () => {
      await transport.close();
    });

    it('proxies real TCP traffic to the remote socat echo server over a real SSH direct-tcpip channel', async () => {
      const tunnel = await openPortForwardTunnel(transport, {
        remoteHost: '127.0.0.1',
        remotePort: fixture.echoPort,
      });

      try {
        const socket = createConnection({ host: tunnel.localHost, port: tunnel.localPort });
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve());
          socket.once('error', reject);
        });

        const echoed = await writeAndExpect(socket, 'hello over a real tunnel');
        expect(echoed).toBe('hello over a real tunnel');
        socket.destroy();
      } finally {
        await tunnel.close();
      }
    });
  },
);
