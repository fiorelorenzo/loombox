import { createServer, createConnection, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { PortForwardRuleManager } from './port-forward-rules';
import type { PortForwardTransport } from './port-forward-transport';
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

async function connectAndWait(host: string, port: number): Promise<Socket> {
  const socket = createConnection({ host, port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Same shape as `port-forward-tunnel.test.ts`'s own fake — a real local TCP
 * connection to a stand-in "remote" echo server, so the rule manager's own
 * bookkeeping (create/list/remove, tunnel lifecycle) is exercised for real
 * with no `ssh2`/Docker involved. */
class FakePortForwardTransport implements PortForwardTransport {
  readonly calls: Array<{ dstHost: string; dstPort: number }> = [];

  constructor(private readonly portsByRemote: Map<number, number>) {}

  async openForwardChannel(
    _srcHost: string,
    _srcPort: number,
    dstHost: string,
    dstPort: number,
  ): Promise<Duplex> {
    this.calls.push({ dstHost, dstPort });
    const localPort = this.portsByRemote.get(dstPort);
    if (!localPort) {
      throw new Error(`FakePortForwardTransport: nothing listens on remote port ${dstPort}`);
    }
    return createConnection({ host: '127.0.0.1', port: localPort });
  }
}

describe('PortForwardRuleManager (hermetic, issue #93)', () => {
  let echoServer: Server;
  let echoPort: number;
  let fakeTransport: FakePortForwardTransport;
  let manager: PortForwardRuleManager;

  beforeEach(async () => {
    echoServer = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', () => resolve()));
    const address = echoServer.address();
    echoPort = typeof address === 'object' && address ? address.port : 0;
    fakeTransport = new FakePortForwardTransport(new Map([[echoPort, echoPort]]));
    manager = new PortForwardRuleManager(async () => fakeTransport);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
  });

  it('creates a rule, proxies traffic to the remote port, and lists it', async () => {
    const rule = await manager.create({ targetId: 'devbox', remotePort: echoPort });

    expect(rule.targetId).toBe('devbox');
    expect(rule.remotePort).toBe(echoPort);
    expect(rule.localPort).toBeGreaterThan(0);
    expect(rule.origin).toBe('manual');

    const socket = await connectAndWait(rule.localHost, rule.localPort);
    const echoed = await writeAndExpect(socket, 'manual rule traffic');
    expect(echoed).toBe('manual rule traffic');
    socket.destroy();

    expect(manager.list()).toEqual([rule]);
    expect(manager.list('devbox')).toEqual([rule]);
    expect(manager.list('some-other-target')).toEqual([]);
    expect(manager.get(rule.id)).toEqual(rule);
  });

  it('removes a rule and tears the tunnel down so the local port refuses new connections', async () => {
    const rule = await manager.create({ targetId: 'devbox', remotePort: echoPort });

    await manager.remove(rule.id);

    expect(manager.list()).toEqual([]);
    expect(manager.get(rule.id)).toBeUndefined();

    const afterRemove = createConnection({ host: rule.localHost, port: rule.localPort });
    await new Promise<void>((resolve) => {
      afterRemove.once('error', () => resolve());
      afterRemove.once('connect', () => resolve());
    });
    expect(afterRemove.destroyed || !afterRemove.readable).toBe(true);
  });

  it('throws removing an unknown rule id', async () => {
    await expect(manager.remove('no-such-rule')).rejects.toThrow(/no rule/i);
  });

  it('supports several independent rules for the same target at once', async () => {
    const server2 = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    const address2 = server2.address();
    const echoPort2 = typeof address2 === 'object' && address2 ? address2.port : 0;
    fakeTransport = new FakePortForwardTransport(
      new Map([
        [echoPort, echoPort],
        [echoPort2, echoPort2],
      ]),
    );
    manager = new PortForwardRuleManager(async () => fakeTransport);

    const ruleA = await manager.create({ targetId: 'devbox', remotePort: echoPort });
    const ruleB = await manager.create({ targetId: 'devbox', remotePort: echoPort2 });

    expect(ruleA.id).not.toBe(ruleB.id);
    expect(manager.list('devbox')).toHaveLength(2);

    await manager.remove(ruleA.id);
    expect(manager.list('devbox')).toHaveLength(1);
    expect(manager.list('devbox')[0]).toEqual(ruleB);

    await manager.remove(ruleB.id);
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });

  it('finds an active rule by its remote destination (used by the auto-detector, issue #94)', async () => {
    const rule = await manager.create({ targetId: 'devbox', remotePort: echoPort });
    expect(manager.findByRemote('devbox', '127.0.0.1', echoPort)).toEqual(rule);
    expect(manager.findByRemote('devbox', '127.0.0.1', 65000)).toBeUndefined();
    expect(manager.findByRemote('other-target', '127.0.0.1', echoPort)).toBeUndefined();
  });

  it('removeAllForTarget tears down every rule for one target only (decommission cleanup, issue #90)', async () => {
    const server2 = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    const address2 = server2.address();
    const echoPort2 = typeof address2 === 'object' && address2 ? address2.port : 0;
    fakeTransport = new FakePortForwardTransport(
      new Map([
        [echoPort, echoPort],
        [echoPort2, echoPort2],
      ]),
    );
    manager = new PortForwardRuleManager(async () => fakeTransport);

    await manager.create({ targetId: 'devbox', remotePort: echoPort });
    const otherTargetRule = await manager.create({ targetId: 'other', remotePort: echoPort2 });

    await manager.removeAllForTarget('devbox');

    expect(manager.list('devbox')).toEqual([]);
    expect(manager.list('other')).toEqual([otherTargetRule]);

    await manager.remove(otherTargetRule.id);
    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});

// Real-sshd integration (issue #93's acceptance: "runs against the
// Dockerized SSH fixture with something listening on a remote port").
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  'PortForwardRuleManager (Dockerized sshd fixture, issue #93)',
  () => {
    let fixture: DockerSshdFixture;
    let transport: Ssh2Transport;
    let manager: PortForwardRuleManager;

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
      manager = new PortForwardRuleManager(async () => transport);
    });

    afterEach(async () => {
      await transport.close();
    });

    it('creates a manual rule reachable locally, then tears it down cleanly on removal', async () => {
      const rule = await manager.create({
        targetId: 'devbox',
        remoteHost: '127.0.0.1',
        remotePort: fixture.echoPort,
      });

      const socket = await connectAndWait(rule.localHost, rule.localPort);
      const echoed = await writeAndExpect(socket, 'hello over a manual rule');
      expect(echoed).toBe('hello over a manual rule');
      socket.destroy();

      await manager.remove(rule.id);

      const afterRemove = createConnection({ host: rule.localHost, port: rule.localPort });
      await new Promise<void>((resolve) => {
        afterRemove.once('error', () => resolve());
        afterRemove.once('connect', () => resolve());
      });
      expect(afterRemove.destroyed || !afterRemove.readable).toBe(true);
    });
  },
);
