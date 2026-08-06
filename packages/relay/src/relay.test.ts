import { afterEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_CAPABILITY,
  PROTOCOL_V1,
  buildIdentityMismatch,
  type AmkEpochFetchResponse,
  type AmkEscrow,
  type BlobDownloadResponse,
  type BlobRef,
  type BlobUpload,
  type BuildIdentityV1,
  type DeviceRegister,
  type DeviceRevoke,
  type DeviceRotate,
  type EncryptedEnvelope,
  type FsListRequest,
  type FsListResponse,
  type FsReadRequest,
  type FsReadResponse,
  type Initialize,
  type InitializeResult,
  type LeaseRelease,
  type LeaseReleaseResult,
  type LeaseRequest,
  type LeaseResult,
  type NewDeviceBootstrapRequest,
  type NewDeviceBootstrapResponse,
  type PromptInjectV1,
  type ProvisionProgress,
  type ProvisionTargetRequest,
  type ProvisionTargetResult,
  type ResyncMarker,
  type SessionAnnounceV1,
  type SessionArchiveRequest,
  type SessionArchiveResponse,
  type SessionCreate,
  type SessionForkRequest,
  type SessionForkResponse,
  type SessionListV1,
  type SessionMetaPublic,
  type SessionResume,
  type SessionUpdateEnvelopeV1,
  type SshDiscoveryRequest,
  type SshDiscoveryResponse,
  type DecommissionTargetRequest,
  type DecommissionTargetResponse,
  type TargetUpdateRequest,
  type TargetUpdateResponse,
  type TargetAnnounce,
  type TargetDescriptor,
  type TargetFsListRequest,
  type TargetFsListResponse,
  type TargetList,
  type TargetListRequest,
  type TargetStatus,
  type TerminalClose,
  type TerminalClosed,
  type TerminalInput,
  type TerminalOpen,
  type TerminalOpened,
  type TerminalOutput,
  type TerminalResize,
  type CheckpointCreate,
  type CheckpointList,
  type CheckpointListResult,
  type CheckpointResult,
  type CheckpointRestore,
  type CheckpointRestorePreview,
  type CheckpointRestorePreviewResult,
  type CheckpointRestoreResult,
  type PermissionPolicyGet,
  type PermissionPolicyResult,
  type PermissionPolicySet,
  type PermissionPolicyViolation,
  type RunCancel,
  type RunExit,
  type RunOutput,
  type RunStart,
  type RunStarted,
  type TestRunnerConfigDetect,
  type TestRunnerConfigDetected,
  type TestRunnerConfigGet,
  type TestRunnerConfigResult,
  type TestRunnerConfigSet,
  type TrackerSnapshotRequest,
  type TrackerSnapshotResponse,
  type TrackerWriteRequest,
  type TrackerWriteResponse,
} from '@loombox/protocol';

import { startRelay } from './relay';
import { createInMemoryRelayStore } from './store';

type Close = () => Promise<void>;

let closers: Close[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/**
 * A relay reply to one request can be more than one frame (e.g. a resync
 * marker plus several replayed envelopes), and the underlying transport can
 * deliver them to the client in one synchronous burst. A naive "attach a
 * `{ once: true }` listener per `nextMessage()` call" helper loses frames
 * that arrive in the gap between one listener firing and the next being
 * attached. So every socket gets ONE persistent collector for its whole
 * lifetime (attached at `connect()` time, before any frame can possibly
 * arrive) that buffers frames into a queue; `nextMessage()` just drains it.
 */
const messageQueues = new WeakMap<WebSocket, Record<string, unknown>[]>();
const messageWaiters = new WeakMap<WebSocket, Array<(msg: Record<string, unknown>) => void>>();

function attachCollector(socket: WebSocket): void {
  messageQueues.set(socket, []);
  messageWaiters.set(socket, []);
  socket.addEventListener('message', (event) => {
    const parsed = JSON.parse(event.data.toString()) as Record<string, unknown>;
    const waiters = messageWaiters.get(socket);
    const nextWaiter = waiters?.shift();
    if (nextWaiter) {
      nextWaiter(parsed);
      return;
    }
    messageQueues.get(socket)?.push(parsed);
  });
}

/** Opens a WebSocket and resolves once it's open. */
async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  attachCollector(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('ws connect error')), { once: true });
  });
  closers.push(async () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });
  return socket;
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

/** Resolves with the next parsed frame received on the socket (may not conform to `WireMessageV1`, e.g. `update_required`). */
function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const queued = messageQueues.get(socket)?.shift();
  if (queued) return Promise.resolve(queued);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    const waiters = messageWaiters.get(socket) ?? [];
    messageWaiters.set(socket, waiters);
    waiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

interface CloseInfo {
  code: number;
  reason: string;
}

function waitForClose(socket: WebSocket, timeoutMs = 2000): Promise<CloseInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        const closeEvent = event as unknown as CloseInfo;
        resolve({ code: closeEvent.code, reason: closeEvent.reason });
      },
      { once: true },
    );
  });
}

function fakeBase64(seed: string): string {
  return Buffer.from(seed).toString('base64');
}

function fakeEnvelope(seed: string, resourceId = 'res'): EncryptedEnvelope {
  return {
    resourceId,
    iv: fakeBase64(`${seed}-iv`),
    ciphertext: fakeBase64(`${seed}-ct`),
    alg: 'AES-256-GCM',
  };
}

interface InitOptions {
  role: 'node' | 'client';
  deviceId: string;
  authToken: string;
  devicePublicKey?: string;
  /** Issue #655: this peer's own build identity, sent on `initialize` — omitted (the default) exercises the pre-#655 "no build identity at all" compat case every other test already relies on. */
  buildIdentity?: BuildIdentityV1;
}

/** Connects, sends `initialize`, and returns the socket plus the negotiated `initialize_result`. */
async function initConnection(
  url: string,
  opts: InitOptions,
): Promise<{ socket: WebSocket; result: InitializeResult }> {
  const socket = await connect(url);
  const initialize: Initialize = {
    type: 'initialize',
    protocolVersion: PROTOCOL_V1,
    role: opts.role,
    authToken: opts.authToken,
    deviceId: opts.deviceId,
    devicePublicKey: opts.devicePublicKey ?? fakeBase64(`${opts.deviceId}-pubkey`),
    ...(opts.buildIdentity ? { buildIdentity: opts.buildIdentity } : {}),
  };
  send(socket, initialize);
  const result = (await nextMessage(socket)) as unknown as InitializeResult;
  return { socket, result };
}

function makeSessionMeta(overrides: Partial<SessionMetaPublic> = {}): SessionMetaPublic {
  return {
    id: 'sess_1',
    nodeId: 'node_1',
    targetId: 'target_1',
    accountId: 'acct_1',
    provider: 'claude',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTarget(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return { id: 'target_1', kind: 'local', label: 'local machine', providers: [], ...overrides };
}

describe('relay v1', () => {
  describe('initialize + version negotiation', () => {
    it('negotiates protocol v1 and returns capabilities', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { result } = await initConnection(url, {
        role: 'client',
        deviceId: 'd1',
        authToken: 't1',
      });
      expect(result.type).toBe('initialize_result');
      expect(result.negotiatedVersion).toBe(PROTOCOL_V1);
      expect(Array.isArray(result.capabilities)).toBe(true);
      expect(result.capabilities.length).toBeGreaterThan(0);
    });

    it('advertises the heartbeat capability, which is what lets a peer arm a pong deadline', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { result } = await initConnection(url, {
        role: 'node',
        deviceId: 'd1',
        authToken: 't1',
      });
      expect(result.capabilities).toContain(HEARTBEAT_CAPABILITY);
    });

    it.each(['node', 'client'] as const)(
      'answers a %s ping with a pong echoing the same nonce (issue #511)',
      async (role) => {
        const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
        closers.push(close);

        const { socket } = await initConnection(url, { role, deviceId: 'd1', authToken: 't1' });
        send(socket, { type: 'ping', protocolVersion: PROTOCOL_V1, nonce: 'probe-7' });

        expect(await nextMessage(socket)).toMatchObject({ type: 'pong', nonce: 'probe-7' });
      },
    );

    it('closes an unsupported-version peer with an update-required notice instead of silently dropping it', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const socket = await connect(url);
      // A fake old-version client: `protocolVersion` outside anything this relay build supports.
      send(socket, {
        type: 'initialize',
        protocolVersion: 99,
        role: 'client',
        authToken: 't',
        deviceId: 'd',
      });

      const notice = await nextMessage(socket);
      expect(notice.type).toBe('update_required');

      const closeEvent = await waitForClose(socket);
      expect(closeEvent.code).toBe(4400);
    });

    it('closes a connection whose first frame is not initialize', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const socket = await connect(url);
      send(socket, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });

      const closeEvent = await waitForClose(socket);
      expect(closeEvent.code).toBe(4401);
    });

    it("echoes this relay's own buildIdentity in initialize_result when configured (issue #655)", async () => {
      const relayBuildIdentity: BuildIdentityV1 = { version: '0.4.1', commit: 'relay-sha' };
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        buildIdentity: relayBuildIdentity,
      });
      closers.push(close);

      const { result } = await initConnection(url, {
        role: 'client',
        deviceId: 'd1',
        authToken: 't1',
      });
      expect(result.buildIdentity).toEqual(relayBuildIdentity);
    });

    it('omits buildIdentity from initialize_result when the relay is not configured with one (dev/hermetic default)', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { result } = await initConnection(url, {
        role: 'node',
        deviceId: 'd1',
        authToken: 't1',
      });
      expect(result.buildIdentity).toBeUndefined();
    });

    it('still connects a peer that sends no buildIdentity at all (issue #655: a pre-#655 node/client must keep working)', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        buildIdentity: { version: '0.4.1', commit: 'relay-sha' },
      });
      closers.push(close);

      // `initConnection` omits `buildIdentity` unless explicitly given —
      // exactly the pre-#655 peer shape.
      const { result } = await initConnection(url, {
        role: 'node',
        deviceId: 'd1',
        authToken: 't1',
      });
      expect(result.type).toBe('initialize_result');
      expect(result.negotiatedVersion).toBe(PROTOCOL_V1);
    });
  });

  describe('target registry (#66 relay side) and session_create routing', () => {
    it('routes session_create to the node that announced the requested target', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_a',
      });
      const announce: TargetAnnounce = {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'target_ssh', kind: 'ssh', label: 'devbox' })],
      };
      send(node, announce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_a',
      });
      const create: SessionCreate = {
        type: 'session_create',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_new',
        targetId: 'target_ssh',
        provider: 'claude',
        privateEnvelope: fakeEnvelope('title'),
      };
      send(client, create);

      const received = (await nextMessage(node)) as unknown as SessionCreate;
      expect(received).toEqual(create);
    });

    it('does not route session_create to a target owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget()],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'session_create',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_intruder',
        targetId: 'target_1',
        provider: 'claude',
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionCreate);

      // The node must not receive it; prove the relay is still alive with a benign round trip instead.
      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });
  });

  describe('target_list_request/target_list (#383): account-scoped client-facing target discovery', () => {
    it("returns the requesting account's announced targets, marked reachable while the announcing node is still connected", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [
          makeTarget({ id: 'local', kind: 'local', label: 'This machine' }),
          makeTarget({ id: 'ssh_devbox', kind: 'ssh', label: 'devbox' }),
        ],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_1',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.type).toBe('target_list');
      expect(response.requestId).toBe('req_1');
      expect(response.targets).toHaveLength(2);
      expect(response.targets).toEqual(
        expect.arrayContaining([
          {
            nodeId: 'node_1',
            targetId: 'local',
            label: 'This machine',
            kind: 'local',
            reachable: true,
            providers: [],
          },
          {
            nodeId: 'node_1',
            targetId: 'ssh_devbox',
            label: 'devbox',
            kind: 'ssh',
            reachable: true,
            providers: [],
          },
        ]),
      );
    });

    it("carries a sample's hostname/platform/arch and loadPercent through to the client, rather than stripping them (issue #516 follow-up)", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'Local' })],
      } satisfies TargetAnnounce);
      // The store drops a sample for a target it has not seen announced yet
      // (`updateHealth`'s `nodeByTarget` guard), and the relay handles each
      // frame in its own async task, so the announce has to have landed first.
      await new Promise((resolve) => setTimeout(resolve, 50));
      send(node, {
        type: 'target_status',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        samples: [
          {
            targetId: 'local',
            cpuPercent: 42,
            loadPercent: 42,
            memPercent: 31,
            memUsedBytes: 5_000_000_000,
            memTotalBytes: 16_000_000_000,
            diskPercent: 35,
            diskUsedBytes: 175_000_000_000,
            diskTotalBytes: 500_000_000_000,
            healthy: true,
            sampledAt: 1_700_000_000_000,
            hostname: 'devbox',
            platform: 'linux',
            arch: 'x64',
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_health',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      // Zod's `.object()` strips keys its schema does not know, so a relay
      // build older than the node's silently drops these and the UI shows an
      // em dash for load and no machine identity at all - which is exactly
      // what a stale prod container did, with nothing anywhere reporting it.
      // This is the assertion that would have caught it.
      expect(response.targets[0]?.health).toMatchObject({
        loadPercent: 42,
        hostname: 'devbox',
        platform: 'linux',
        arch: 'x64',
      });
    });

    it("carries a target's providers array through to the client, byte-for-byte, rather than stripping it (#516-class defect)", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [
          makeTarget({
            id: 'local',
            kind: 'local',
            label: 'Local',
            providers: ['claude', 'ohmypi'],
          }),
        ],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_providers',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      // Zod's `.object()` strips keys its schema does not know, so a relay
      // (or a `targetListEntry` schema) that has fallen behind the node's
      // `providers` probe would silently drop it here, and the web picker
      // would fall back to guessing what a target can run - exactly the
      // #521-class defect this pins against.
      expect(response.targets[0]?.providers).toEqual(['claude', 'ohmypi']);
    });

    it('carries an empty providers array through as [], not dropped, coerced to undefined, or defaulted to something non-empty', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'Local', providers: [] })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_no_providers',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      // An empty array is a meaningful, distinct state (a reachable target
      // with no agent CLI installed) - not the same as "unknown"/absent, so
      // this must survive as `[]`, never `undefined` and never a fallback.
      expect(response.targets[0]?.providers).toEqual([]);
      expect(response.targets[0]).toHaveProperty('providers');
    });

    it("never returns another account's targets", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget()],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_intruder',
      } satisfies TargetListRequest);

      const response = (await nextMessage(intruder)) as unknown as TargetList;
      expect(response.type).toBe('target_list');
      expect(response.targets).toEqual([]);

      // The owning account still sees its own target, proving isolation isn't just an empty relay.
      const { socket: owner } = await initConnection(url, {
        role: 'client',
        deviceId: 'owner-device',
        authToken: 'acct_owner',
      });
      send(owner, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_owner',
      } satisfies TargetListRequest);
      const ownerResponse = (await nextMessage(owner)) as unknown as TargetList;
      expect(ownerResponse.targets).toHaveLength(1);
    });

    it('marks a target unreachable once its announcing node disconnects, without dropping it from the list', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget()],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      node.close();
      await waitForClose(node);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_1',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.targets).toHaveLength(1);
      expect(response.targets[0]?.reachable).toBe(false);
    });
  });

  describe('build identity on target_list (#655): "what version is each connected peer running", answered over the wire', () => {
    it("carries the announcing node's buildIdentity through to the client, sourced from that node's own initialize", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const nodeBuildIdentity: BuildIdentityV1 = { version: '0.5.1', commit: 'node-sha' };
      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
        buildIdentity: nodeBuildIdentity,
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'Local' })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_build',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.targets[0]?.build).toEqual(nodeBuildIdentity);
    });

    it('omits build from a target_list entry when the owning node sent no buildIdentity — an older node still connects and lists', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
        // no buildIdentity — the pre-#655 shape.
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'Local' })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_no_build',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.targets[0]?.build).toBeUndefined();
    });

    it('drives two peers with deliberately different build identities and surfaces the mismatch — same protocol, different build, allowed AND surfaced (issue #655, the outcome that does not exist today)', async () => {
      const relayBuildIdentity: BuildIdentityV1 = { version: '0.4.1', commit: 'relay-sha' };
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        buildIdentity: relayBuildIdentity,
      });
      closers.push(close);

      // Peer A: built from the exact same commit the relay is serving.
      const { socket: nodeSame, result: nodeSameResult } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-same-device',
        authToken: 'acct_1',
        buildIdentity: { ...relayBuildIdentity },
      });
      // Peer B: same protocolVersion (PROTOCOL_V1, unchanged), but a
      // different commit — built a week and fifty PRs apart, #655's own
      // incident. Both peers must be ALLOWED to connect (outcome 2 is never
      // a refusal): asserted below via `result.type`/`negotiatedVersion`,
      // never an `update_required`/close.
      const { socket: nodeDrifted, result: nodeDriftedResult } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-drifted-device',
        authToken: 'acct_1',
        buildIdentity: { version: relayBuildIdentity.version, commit: 'drifted-sha' },
      });
      expect(nodeSameResult.type).toBe('initialize_result');
      expect(nodeSameResult.negotiatedVersion).toBe(PROTOCOL_V1);
      expect(nodeDriftedResult.type).toBe('initialize_result');
      expect(nodeDriftedResult.negotiatedVersion).toBe(PROTOCOL_V1);

      send(nodeSame, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_same',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'Same build' })],
      } satisfies TargetAnnounce);
      send(nodeDrifted, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_drifted',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'Drifted build' })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client, result: clientResult } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      // This is the client's own baseline for "what is actually being
      // served" — `TargetStatusView`'s `relayBuildIdentity` prop comes from
      // exactly this field on the real `RelayClient`.
      expect(clientResult.buildIdentity).toEqual(relayBuildIdentity);

      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_mismatch',
      } satisfies TargetListRequest);
      const response = (await nextMessage(client)) as unknown as TargetList;

      const sameEntry = response.targets.find((t) => t.nodeId === 'node_same');
      const driftedEntry = response.targets.find((t) => t.nodeId === 'node_drifted');
      expect(sameEntry?.reachable).toBe(true);
      expect(driftedEntry?.reachable).toBe(true);

      // Outcome 1: same protocol, same build — nothing to surface.
      expect(buildIdentityMismatch(clientResult.buildIdentity, sameEntry?.build)).toBe(false);
      // Outcome 2, the middle one, the one that doesn't exist before this
      // change: same protocol, different build — allowed (both peers
      // connected above) AND surfaced (this is true).
      expect(buildIdentityMismatch(clientResult.buildIdentity, driftedEntry?.build)).toBe(true);
    });
  });

  describe('target_status (#253/#269): per-target resource sampling attached to target_list', () => {
    it("attaches a node's latest target_status sample to the matching target_list entry", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'local', kind: 'local', label: 'This machine' })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      send(node, {
        type: 'target_status',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        samples: [
          {
            targetId: 'local',
            cpuPercent: 42,
            memPercent: 60,
            memUsedBytes: 6_000_000_000,
            memTotalBytes: 10_000_000_000,
            diskPercent: 30,
            diskUsedBytes: 30_000_000_000,
            diskTotalBytes: 100_000_000_000,
            healthy: true,
            sampledAt: 1_700_000_000_000,
          },
        ],
      } satisfies TargetStatus);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_1',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.targets).toHaveLength(1);
      expect(response.targets[0]?.health).toEqual({
        cpuPercent: 42,
        memPercent: 60,
        memUsedBytes: 6_000_000_000,
        memTotalBytes: 10_000_000_000,
        diskPercent: 30,
        diskUsedBytes: 30_000_000_000,
        diskTotalBytes: 100_000_000_000,
        healthy: true,
        sampledAt: 1_700_000_000_000,
      });
    });

    it('omits health from a target_list entry that has never received a target_status sample', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget()],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_1',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.targets).toHaveLength(1);
      expect(response.targets[0]?.health).toBeUndefined();
    });

    it('ignores a target_status sample for a targetId this node never announced (never lets a stray/stale claim slip through)', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget({ id: 'local' })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      send(node, {
        type: 'target_status',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        samples: [
          {
            targetId: 'never-announced',
            cpuPercent: 1,
            memPercent: 1,
            memUsedBytes: 1,
            memTotalBytes: 1,
            diskPercent: 1,
            diskUsedBytes: 1,
            diskTotalBytes: 1,
            healthy: true,
            sampledAt: 1,
          },
        ],
      } satisfies TargetStatus);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Still alive and unaffected — the benign round trip below proves the
      // relay didn't choke on the stray sample, and the announced target's
      // own entry never picked up a phantom health reading either.
      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_1',
      } satisfies TargetListRequest);

      const response = (await nextMessage(client)) as unknown as TargetList;
      expect(response.targets).toHaveLength(1);
      expect(response.targets[0]?.targetId).toBe('local');
      expect(response.targets[0]?.health).toBeUndefined();
    });

    it("never leaks one account's target_status sample into another account's target_list, even for the same targetId", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: ownerNode } = await initConnection(url, {
        role: 'node',
        deviceId: 'owner-node-device',
        authToken: 'acct_owner',
      });
      send(ownerNode, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_owner',
        targets: [makeTarget({ id: 'shared_id', kind: 'local', label: "owner's box" })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));
      send(ownerNode, {
        type: 'target_status',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_owner',
        samples: [
          {
            targetId: 'shared_id',
            cpuPercent: 77,
            memPercent: 77,
            memUsedBytes: 1,
            memTotalBytes: 1,
            diskPercent: 77,
            diskUsedBytes: 1,
            diskTotalBytes: 1,
            healthy: true,
            sampledAt: 1,
          },
        ],
      } satisfies TargetStatus);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // A different account happens to announce a target under the exact
      // same id — it must never see the owner's health reading attached.
      const { socket: otherNode } = await initConnection(url, {
        role: 'node',
        deviceId: 'other-node-device',
        authToken: 'acct_other',
      });
      send(otherNode, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_other',
        targets: [makeTarget({ id: 'shared_id', kind: 'local', label: "other's box" })],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'target_list_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_intruder',
      } satisfies TargetListRequest);

      const response = (await nextMessage(intruder)) as unknown as TargetList;
      expect(response.targets).toHaveLength(1);
      expect(response.targets[0]?.nodeId).toBe('node_other');
      // The owner's later target_announce for the same id re-pointed
      // `nodeByTarget['shared_id']` at `node_owner` already before this — so
      // this assertion also guards that re-announcing doesn't retroactively
      // grant `node_other`'s account the owner's stale health reading.
      expect(response.targets[0]?.health).toBeUndefined();
    });
  });

  describe('session announce/list (account-scoped, SessionMetaPublic only)', () => {
    it("lists only the caller account's sessions, never another account's title/path", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const privateEnvelope = fakeEnvelope('secret-title');
      const meta = makeSessionMeta({ id: 'sess_a', accountId: 'acct_1' });
      const announce: SessionAnnounceV1 = {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope,
      };
      send(node, announce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: owner } = await initConnection(url, {
        role: 'client',
        deviceId: 'owner-device',
        authToken: 'acct_1',
      });
      send(owner, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const ownerList = (await nextMessage(owner)) as unknown as SessionListV1;
      expect(ownerList.sessions).toHaveLength(1);
      expect(ownerList.sessions[0]?.session).toEqual(meta);
      expect(ownerList.sessions[0]?.privateEnvelope).toEqual(privateEnvelope);
      // Structural guard: SessionMetaPublic must never carry a title/projectPath field.
      expect(Object.keys(ownerList.sessions[0]?.session ?? {})).not.toContain('title');
      expect(Object.keys(ownerList.sessions[0]?.session ?? {})).not.toContain('projectPath');

      const { socket: stranger } = await initConnection(url, {
        role: 'client',
        deviceId: 'stranger-device',
        authToken: 'acct_2',
      });
      send(stranger, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const strangerList = (await nextMessage(stranger)) as unknown as SessionListV1;
      expect(strangerList.sessions).toEqual([]);
    });
  });

  describe('session_update fan-out to subscribed clients', () => {
    it('delivers a session_update, relay-assigned seq, only to a client that resumed the session', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_live', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: subscriber } = await initConnection(url, {
        role: 'client',
        deviceId: 'subscriber-device',
        authToken: 'acct_1',
      });
      send(subscriber, {
        type: 'session_resume',
        sessionId: 'sess_live',
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      const resumeReply = (await nextMessage(subscriber)) as unknown as SessionAnnounceV1;
      expect(resumeReply.type).toBe('session_announce');

      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });
      // bystander never resumes sess_live

      const envelope = fakeEnvelope('chunk-1');
      const update = {
        type: 'session_update',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_live',
        seq: 0, // the relay assigns the real seq; the sender's own seq is ignored
        envelope,
      } satisfies SessionUpdateEnvelopeV1;
      send(node, update);

      const received = (await nextMessage(subscriber)) as unknown as SessionUpdateEnvelopeV1;
      expect(received.type).toBe('session_update');
      expect(received.seq).toBe(1);
      expect(received.envelope).toEqual(envelope);

      // bystander gets nothing: prove liveness with a direct control round trip instead.
      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderList = (await nextMessage(bystander)) as unknown as SessionListV1;
      expect(bystanderList.type).toBe('session_list');
    });
  });

  describe('prompt_inject routed to the owning node', () => {
    it('forwards a client prompt_inject to the node owning that session', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_prompt', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const prompt: PromptInjectV1 = {
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_prompt',
        promptId: 'prompt_1',
        envelope: fakeEnvelope('do the thing'),
      };
      send(client, prompt);

      const received = (await nextMessage(node)) as unknown as PromptInjectV1;
      expect(received).toEqual(prompt);
    });

    it('ignores a prompt_inject for an unknown session instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'prompt_inject',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        promptId: 'prompt_2',
        envelope: fakeEnvelope('hello'),
      } satisfies PromptInjectV1);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });
  });

  describe('fs_list_request/fs_list_response (SPEC §7.4/§7.25; issue #171/#160) — routed and fanned out exactly like prompt_inject/blob_ref, always blind', () => {
    it('routes a client fs_list_request to the node owning that session, byte-for-byte, never inspecting the envelope', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_fs_list', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      // Not real AES-GCM output — deliberately garbage bytes, so this proves
      // the relay forwards the envelope opaquely rather than requiring it to
      // be decryptable (it never attempts to decrypt anything, ever).
      const request: FsListRequest = {
        type: 'fs_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_fs_list',
        targetId: 'target_1',
        requestId: 'req_1',
        envelope: fakeEnvelope('src/index.ts'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as FsListRequest;
      expect(received).toEqual(request);
      // The relay-visible frame carries only routing metadata + the opaque
      // envelope — never a `path` field.
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
      );
    });

    it('ignores an fs_list_request for an unknown session instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'fs_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        targetId: 'target_1',
        requestId: 'req_orphan',
        envelope: fakeEnvelope('some-path'),
      } satisfies FsListRequest);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });

    it("fans fs_list_response out to the session's subscribed client, byte-for-byte, never inspecting the envelope", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_fs_list_reply', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      // Subscribe (session_resume, same as the session_update fan-out
      // model) — fs_list_response is fanned out through the exact same
      // per-session subscriber list blob_ref/permission_request use.
      send(client, {
        type: 'session_resume',
        sessionId: 'sess_fs_list_reply',
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      const response: FsListResponse = {
        type: 'fs_list_response',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_fs_list_reply',
        requestId: 'req_2',
        envelope: fakeEnvelope('README.md,src'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as FsListResponse;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });
  });

  describe('fs_read_request/fs_read_response (issue #737) — routed and fanned out exactly like fs_list_request/fs_list_response, always blind', () => {
    it('routes a client fs_read_request to the node owning that session, byte-for-byte, never inspecting the envelope', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_fs_read', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: FsReadRequest = {
        type: 'fs_read_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_fs_read',
        targetId: 'target_1',
        requestId: 'req_1',
        envelope: fakeEnvelope('src/index.ts'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as FsReadRequest;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'targetId', 'type'].sort(),
      );
    });

    it('ignores an fs_read_request for an unknown session instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'fs_read_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        targetId: 'target_1',
        requestId: 'req_orphan',
        envelope: fakeEnvelope('some-path'),
      } satisfies FsReadRequest);

      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });

    it("fans fs_read_response out to the session's subscribed client, byte-for-byte, never inspecting the envelope", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_fs_read_reply', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId: 'sess_fs_read_reply',
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      const response: FsReadResponse = {
        type: 'fs_read_response',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_fs_read_reply',
        requestId: 'req_2',
        envelope: fakeEnvelope('export {};'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as FsReadResponse;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });
  });

  describe("target_fs_list_request/target_fs_list_response (SPEC §7.25; issue #474) — the directory picker's target-scoped sibling of fs_list, routed directly by nodeId like provision_target_request", () => {
    it("routes target_fs_list_request to the node identified by nodeId, scoped to the requester's account, byte-for-byte, never inspecting the envelope", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_dirpicker',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      // Deliberately garbage "ciphertext" bytes — proves the relay forwards
      // the envelope opaquely rather than requiring it to be decryptable.
      const request: TargetFsListRequest = {
        type: 'target_fs_list_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_dirpicker',
        targetId: 'local',
        requestId: 'req_dir_1',
        envelope: fakeEnvelope('/home/lorenzo'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TargetFsListRequest;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'nodeId', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
      );
    });

    it('ignores a target_fs_list_request for an unknown node instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'target_fs_list_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_nonexistent',
        targetId: 'local',
        requestId: 'req_orphan',
        envelope: fakeEnvelope('some-path'),
      } satisfies TargetFsListRequest);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });

    it('does not route target_fs_list_request to a node owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_foreign',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'target_fs_list_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_foreign',
        targetId: 'local',
        requestId: 'req_intruder',
        envelope: fakeEnvelope('some-path'),
      } satisfies TargetFsListRequest);

      // The owner's node must not receive it; prove the relay is still
      // alive with a benign round trip instead.
      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });

    it('delivers target_fs_list_response back to the requesting client only, byte-for-byte, never inspecting the envelope', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_dirpicker_reply',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      // A second, uninvolved client on the SAME account — must never see
      // this request's reply.
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: TargetFsListRequest = {
        type: 'target_fs_list_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_dirpicker_reply',
        targetId: 'local',
        requestId: 'req_dir_2',
        envelope: fakeEnvelope('/home/lorenzo'),
      };
      send(requester, request);
      await nextMessage(node); // the node's own copy of the request

      const response: TargetFsListResponse = {
        type: 'target_fs_list_response',
        protocolVersion: PROTOCOL_V1,
        targetId: 'local',
        requestId: request.requestId,
        envelope: fakeEnvelope('projects,README.md'),
      };
      send(node, response);
      const received = (await nextMessage(requester)) as unknown as TargetFsListResponse;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'targetId', 'type'].sort(),
      );

      // The bystander never received it — prove it's still alive and its
      // next frame is the benign one we send now, not a leaked response.
      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderNext = (await nextMessage(bystander)) as unknown as SessionListV1;
      expect(bystanderNext.type).toBe('session_list');
    });

    it('cleans up an abandoned routing entry after its TTL, freeing the requestId for reuse', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        targetFsListRequestTtlMs: 50,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_dirpicker_ttl',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_1',
      });
      const request: TargetFsListRequest = {
        type: 'target_fs_list_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_dirpicker_ttl',
        targetId: 'local',
        requestId: 'req_dir_ttl',
        envelope: fakeEnvelope('/home/lorenzo'),
      };
      send(firstClient, request);
      await nextMessage(node);

      // Never send a response — simulate an abandoned request and let it
      // expire on its own.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_1',
      });
      send(secondClient, request);
      await nextMessage(node);

      const response: TargetFsListResponse = {
        type: 'target_fs_list_response',
        protocolVersion: PROTOCOL_V1,
        targetId: 'local',
        requestId: request.requestId,
        envelope: fakeEnvelope('projects'),
      };
      send(node, response);
      const received = (await nextMessage(secondClient)) as unknown as TargetFsListResponse;
      expect(received).toEqual(response);

      // The expired-and-abandoned firstClient must not have received it.
      send(firstClient, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const firstClientNext = await nextMessage(firstClient);
      expect(firstClientNext.type).toBe('session_list');
    });
  });

  describe("ssh_discovery_request/ssh_discovery_response (redesign v2 §3.2; issue #475) — the add-target wizard's candidate picker, routed directly by nodeId like provision_target_request, but with plain fields (no envelope) since a discovered alias/hostname/user is routing-adjacent metadata, not a secret", () => {
    it("routes ssh_discovery_request to the node identified by nodeId, scoped to the requester's account, byte-for-byte", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: SshDiscoveryRequest = {
        type: 'ssh_discovery_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco',
        requestId: 'req_sshdisco_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as SshDiscoveryRequest;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['nodeId', 'protocolVersion', 'requestId', 'type'].sort(),
      );
    });

    it('ignores an ssh_discovery_request for an unknown node instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'ssh_discovery_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_nonexistent',
        requestId: 'req_sshdisco_orphan',
      } satisfies SshDiscoveryRequest);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });

    it('does not route ssh_discovery_request to a node owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_foreign',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'ssh_discovery_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_foreign',
        requestId: 'req_sshdisco_intruder',
      } satisfies SshDiscoveryRequest);

      // The owner's node must not receive it; prove the relay is still
      // alive with a benign round trip instead.
      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });

    it('delivers ssh_discovery_response back to the requesting client only, byte-for-byte', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_reply',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      // A second, uninvolved client on the SAME account — must never see
      // this request's reply.
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: SshDiscoveryRequest = {
        type: 'ssh_discovery_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_reply',
        requestId: 'req_sshdisco_2',
      };
      send(requester, request);
      await nextMessage(node); // the node's own copy of the request

      const response: SshDiscoveryResponse = {
        type: 'ssh_discovery_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_reply',
        requestId: request.requestId,
        result: {
          outcome: 'ok',
          candidates: [{ alias: 'devbox', hostName: '100.87.202.117', identityFiles: [] }],
          agent: { available: false, identities: [] },
          requiresManualEntry: false,
        },
      };
      send(node, response);
      const received = (await nextMessage(requester)) as unknown as SshDiscoveryResponse;
      expect(received).toEqual(response);

      // The bystander never received it — prove it's still alive and its
      // next frame is the benign one we send now, not a leaked response.
      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderNext = (await nextMessage(bystander)) as unknown as SessionListV1;
      expect(bystanderNext.type).toBe('session_list');
    });

    it('cleans up an abandoned routing entry after its TTL, freeing the requestId for reuse', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        sshDiscoveryRequestTtlMs: 50,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_ttl',
        targets: [{ id: 'local', kind: 'local', label: 'This machine', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_1',
      });
      const request: SshDiscoveryRequest = {
        type: 'ssh_discovery_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_ttl',
        requestId: 'req_sshdisco_ttl',
      };
      send(firstClient, request);
      await nextMessage(node);

      // Never send a response — simulate an abandoned request and let it
      // expire on its own.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_1',
      });
      send(secondClient, request);
      await nextMessage(node);

      const response: SshDiscoveryResponse = {
        type: 'ssh_discovery_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_sshdisco_ttl',
        requestId: request.requestId,
        result: {
          outcome: 'ok',
          candidates: [],
          agent: { available: false, identities: [] },
          requiresManualEntry: true,
        },
      };
      send(node, response);
      const received = (await nextMessage(secondClient)) as unknown as SshDiscoveryResponse;
      expect(received).toEqual(response);

      // The expired-and-abandoned firstClient must not have received it.
      send(firstClient, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const firstClientNext = await nextMessage(firstClient);
      expect(firstClientNext.type).toBe('session_list');
    });
  });

  describe('decommission_target_request/decommission_target_response (redesign v2 §3.3 Remove/Edit; issue #476) — routed directly by nodeId like provision_target_request/ssh_discovery_request, plain fields (no envelope)', () => {
    it("routes decommission_target_request to the node identified by nodeId, scoped to the requester's account, byte-for-byte", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: DecommissionTargetRequest = {
        type: 'decommission_target_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission',
        targetId: 'ssh:devbox',
        requestId: 'req_decommission_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as DecommissionTargetRequest;
      expect(received).toEqual(request);
    });

    it('ignores a decommission_target_request for an unknown node instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'decommission_target_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_nonexistent',
        targetId: 'ssh:devbox',
        requestId: 'req_decommission_orphan',
      } satisfies DecommissionTargetRequest);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });

    it('does not route decommission_target_request to a node owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_foreign',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'decommission_target_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_foreign',
        targetId: 'ssh:devbox',
        requestId: 'req_decommission_intruder',
      } satisfies DecommissionTargetRequest);

      // The owner's node must not receive it; prove the relay is still
      // alive with a benign round trip instead.
      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });

    it('delivers decommission_target_response back to the requesting client only, byte-for-byte', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_reply',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      // A second, uninvolved client on the SAME account — must never see
      // this request's reply.
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: DecommissionTargetRequest = {
        type: 'decommission_target_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_reply',
        targetId: 'ssh:devbox',
        requestId: 'req_decommission_2',
      };
      send(requester, request);
      await nextMessage(node); // the node's own copy of the request

      const response: DecommissionTargetResponse = {
        type: 'decommission_target_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_reply',
        targetId: 'ssh:devbox',
        requestId: request.requestId,
        ok: true,
        result: {
          unitWasInstalled: true,
          unitStopped: true,
          unitDisabled: true,
          deviceKeyRevoked: true,
          filesRemoved: false,
        },
        message: 'decommissioned "ssh:devbox"',
      };
      send(node, response);
      const received = (await nextMessage(requester)) as unknown as DecommissionTargetResponse;
      expect(received).toEqual(response);

      // The bystander never received it — prove it's still alive and its
      // next frame is the benign one we send now, not a leaked response.
      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderNext = (await nextMessage(bystander)) as unknown as SessionListV1;
      expect(bystanderNext.type).toBe('session_list');
    });

    it('cleans up an abandoned routing entry after its TTL, freeing the requestId for reuse', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        decommissionTargetRequestTtlMs: 50,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_ttl',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_1',
      });
      const request: DecommissionTargetRequest = {
        type: 'decommission_target_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_ttl',
        targetId: 'ssh:devbox',
        requestId: 'req_decommission_ttl',
      };
      send(firstClient, request);
      await nextMessage(node);

      // Never send a response — simulate an abandoned request and let it
      // expire on its own.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_1',
      });
      send(secondClient, request);
      await nextMessage(node);

      const response: DecommissionTargetResponse = {
        type: 'decommission_target_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_decommission_ttl',
        targetId: 'ssh:devbox',
        requestId: request.requestId,
        ok: false,
        message: 'unknown target "ssh:devbox"',
      };
      send(node, response);
      const received = (await nextMessage(secondClient)) as unknown as DecommissionTargetResponse;
      expect(received).toEqual(response);

      // The expired-and-abandoned firstClient must not have received it.
      send(firstClient, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const firstClientNext = await nextMessage(firstClient);
      expect(firstClientNext.type).toBe('session_list');
    });
  });

  describe('target_update_request/target_update_response (redesign v2 §3.3 Update; issue #476) — same direct-by-nodeId routing shape as decommission_target_request', () => {
    it("routes target_update_request to the node identified by nodeId, scoped to the requester's account, byte-for-byte", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: TargetUpdateRequest = {
        type: 'target_update_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update',
        targetId: 'ssh:devbox',
        requestId: 'req_update_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TargetUpdateRequest;
      expect(received).toEqual(request);
    });

    it('does not route target_update_request to a node owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_foreign',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'target_update_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_foreign',
        targetId: 'ssh:devbox',
        requestId: 'req_update_intruder',
      } satisfies TargetUpdateRequest);

      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });

    it('delivers target_update_response back to the requesting client only, byte-for-byte', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_reply',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: TargetUpdateRequest = {
        type: 'target_update_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_reply',
        targetId: 'ssh:devbox',
        requestId: 'req_update_2',
      };
      send(requester, request);
      await nextMessage(node); // the node's own copy of the request

      const response: TargetUpdateResponse = {
        type: 'target_update_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_reply',
        targetId: 'ssh:devbox',
        requestId: request.requestId,
        ok: true,
        status: 'current',
        remoteVersion: '2.0.0',
        installedVersion: '2.0.0',
        message: '"ssh:devbox" is now at 2.0.0',
      };
      send(node, response);
      const received = (await nextMessage(requester)) as unknown as TargetUpdateResponse;
      expect(received).toEqual(response);

      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderNext = (await nextMessage(bystander)) as unknown as SessionListV1;
      expect(bystanderNext.type).toBe('session_list');
    });

    it('cleans up an abandoned routing entry after its TTL, freeing the requestId for reuse', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        targetUpdateRequestTtlMs: 50,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_ttl',
        targets: [{ id: 'ssh:devbox', kind: 'ssh', label: 'Dev box', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_1',
      });
      const request: TargetUpdateRequest = {
        type: 'target_update_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_ttl',
        targetId: 'ssh:devbox',
        requestId: 'req_update_ttl',
      };
      send(firstClient, request);
      await nextMessage(node);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_1',
      });
      send(secondClient, request);
      await nextMessage(node);

      const response: TargetUpdateResponse = {
        type: 'target_update_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_update_ttl',
        targetId: 'ssh:devbox',
        requestId: request.requestId,
        ok: false,
        message: 'target updates are not configured on this node',
      };
      send(node, response);
      const received = (await nextMessage(secondClient)) as unknown as TargetUpdateResponse;
      expect(received).toEqual(response);

      send(firstClient, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const firstClientNext = await nextMessage(firstClient);
      expect(firstClientNext.type).toBe('session_list');
    });
  });

  describe('tracker_snapshot_request/_response and tracker_write_request/_response (issue #697) — re-addressed by nodeId + projectPath, same direct-by-nodeId request shape as target_update_request and the same single-shot pendingAccountRequests response shape as tracker_mode_response, always blind', () => {
    it("routes a tracker_snapshot_request to the node identified by nodeId, scoped to the requester's account, byte-for-byte, never inspecting the envelope", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker',
        targets: [{ id: 'local', kind: 'local', label: 'local', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: TrackerSnapshotRequest = {
        type: 'tracker_snapshot_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker',
        projectPath: '/home/dev/proj',
        requestId: 'req_tracker_snap_1',
        envelope: fakeEnvelope('snapshot-request'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TrackerSnapshotRequest;
      expect(received).toEqual(request);
      // No `sessionId`/`targetId` on the wire at all — the pre-#697 shape is gone.
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'nodeId', 'projectPath', 'protocolVersion', 'requestId', 'type'].sort(),
      );
    });

    it('does not route a tracker_snapshot_request to a node owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_foreign',
        targets: [{ id: 'local', kind: 'local', label: 'local', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'tracker_snapshot_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_foreign',
        projectPath: '/home/dev/proj',
        requestId: 'req_tracker_snap_intruder',
        envelope: fakeEnvelope('snapshot-request-intruder'),
      } satisfies TrackerSnapshotRequest);

      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });

    it('delivers tracker_snapshot_response back to the requesting client only, byte-for-byte', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_reply',
        targets: [{ id: 'local', kind: 'local', label: 'local', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: TrackerSnapshotRequest = {
        type: 'tracker_snapshot_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_reply',
        projectPath: '/home/dev/proj',
        requestId: 'req_tracker_snap_2',
        envelope: fakeEnvelope('snapshot-request-2'),
      };
      send(requester, request);
      await nextMessage(node); // the node's own copy of the request

      const response: TrackerSnapshotResponse = {
        type: 'tracker_snapshot_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_reply',
        projectPath: '/home/dev/proj',
        requestId: request.requestId,
        envelope: fakeEnvelope('snapshot-response-2'),
      };
      send(node, response);
      const received = (await nextMessage(requester)) as unknown as TrackerSnapshotResponse;
      expect(received).toEqual(response);

      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderNext = (await nextMessage(bystander)) as unknown as SessionListV1;
      expect(bystanderNext.type).toBe('session_list');
    });

    it('routes a tracker_write_request to the node and its tracker_write_response back to the requesting client only, byte-for-byte', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_write',
        targets: [{ id: 'local', kind: 'local', label: 'local', providers: [] }],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });

      const request: TrackerWriteRequest = {
        type: 'tracker_write_request',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_write',
        projectPath: '/home/dev/proj',
        requestId: 'req_tracker_write_1',
        envelope: fakeEnvelope('write-request'),
      };
      send(requester, request);
      const receivedRequest = (await nextMessage(node)) as unknown as TrackerWriteRequest;
      expect(receivedRequest).toEqual(request);

      const response: TrackerWriteResponse = {
        type: 'tracker_write_response',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_tracker_write',
        projectPath: '/home/dev/proj',
        requestId: request.requestId,
        envelope: fakeEnvelope('write-response'),
      };
      send(node, response);
      const received = (await nextMessage(requester)) as unknown as TrackerWriteResponse;
      expect(received).toEqual(response);
    });
  });

  describe('interactive PTY terminals (SPEC §7.5; issues #172/#173/#174) — routed and fanned out exactly like fs_list_request/fs_list_response, always blind', () => {
    /** Boots a relay, a `node`-role connection that has already announced `sessionId`, and a `client`-role connection subscribed to it (`session_resume`) — the shared setup every terminal test below needs. */
    async function bootstrapAnnouncedSession(
      sessionId: string,
    ): Promise<{ url: string; node: WebSocket; client: WebSocket }> {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: sessionId, accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId,
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      return { url, node, client };
    }

    it('routes a client terminal_open to the owning node, byte-for-byte, never inspecting the envelope (cols/rows stay opaque)', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_open');

      const request: TerminalOpen = {
        type: 'terminal_open',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_open',
        targetId: 'target_1',
        terminalId: 'term_1',
        requestId: 'req_open_1',
        envelope: fakeEnvelope('80x24'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TerminalOpen;
      expect(received).toEqual(request);
      // The relay-visible frame carries only routing metadata + the opaque
      // envelope — never a plaintext cols/rows field.
      expect(Object.keys(received).sort()).toEqual(
        [
          'envelope',
          'protocolVersion',
          'requestId',
          'sessionId',
          'targetId',
          'terminalId',
          'type',
        ].sort(),
      );
    });

    it('fans terminal_opened out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_opened');

      const response: TerminalOpened = {
        type: 'terminal_opened',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_opened',
        terminalId: 'term_1',
        requestId: 'req_open_1',
        envelope: fakeEnvelope('ok'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as TerminalOpened;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'terminalId', 'type'].sort(),
      );
    });

    it('routes a client terminal_input (typed keystrokes) to the owning node, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_input');

      const request: TerminalInput = {
        type: 'terminal_input',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_input',
        terminalId: 'term_1',
        envelope: fakeEnvelope('rm -rf secrets/'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TerminalInput;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
      );
      // The relay never learns what was typed: the only place "rm -rf
      // secrets/" could appear on this frame is inside the opaque envelope,
      // and this frame carries nothing else.
      expect(JSON.stringify(Object.keys(received))).not.toContain('secrets');
    });

    it("fans terminal_output out to the session's subscribed client, byte-for-byte, never inspecting the envelope (the shell's actual output stays opaque)", async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_output');

      const response: TerminalOutput = {
        type: 'terminal_output',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_output',
        terminalId: 'term_1',
        envelope: fakeEnvelope('$ cat ~/.ssh/id_ed25519'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as TerminalOutput;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
      );
    });

    it('routes a client terminal_resize to the owning node, byte-for-byte, never inspecting the envelope (the new cols/rows stay opaque)', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_resize');

      const request: TerminalResize = {
        type: 'terminal_resize',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_resize',
        terminalId: 'term_1',
        envelope: fakeEnvelope('120x40'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TerminalResize;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
      );
    });

    it('routes a client terminal_close to the owning node — no envelope, since closing carries no content', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_close');

      const request: TerminalClose = {
        type: 'terminal_close',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_close',
        terminalId: 'term_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TerminalClose;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
      );
    });

    it('fans terminal_closed out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_closed');

      const response: TerminalClosed = {
        type: 'terminal_closed',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_term_closed',
        terminalId: 'term_1',
        envelope: fakeEnvelope('exited:0'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as TerminalClosed;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'sessionId', 'terminalId', 'type'].sort(),
      );
    });

    it('ignores a terminal_open/terminal_input/terminal_resize/terminal_close for an unknown session instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });

      send(client, {
        type: 'terminal_open',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        targetId: 'target_1',
        terminalId: 'term_orphan',
        requestId: 'req_orphan',
        envelope: fakeEnvelope('80x24'),
      } satisfies TerminalOpen);
      send(client, {
        type: 'terminal_input',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        terminalId: 'term_orphan',
        envelope: fakeEnvelope('x'),
      } satisfies TerminalInput);
      send(client, {
        type: 'terminal_resize',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        terminalId: 'term_orphan',
        envelope: fakeEnvelope('80x24'),
      } satisfies TerminalResize);
      send(client, {
        type: 'terminal_close',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        terminalId: 'term_orphan',
      } satisfies TerminalClose);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });

    it('proves no terminal bytes are ever visible to the relay: every routed/fanned-out frame is exactly {routing fields, envelope} — never a decrypted field', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_term_blind');

      const frames: Array<[WebSocket, WebSocket, unknown]> = [
        [
          client,
          node,
          {
            type: 'terminal_open',
            protocolVersion: PROTOCOL_V1,
            sessionId: 'sess_term_blind',
            targetId: 'target_1',
            terminalId: 'term_blind',
            requestId: 'req_blind_open',
            envelope: fakeEnvelope('secret-cols-rows'),
          } satisfies TerminalOpen,
        ],
        [
          node,
          client,
          {
            type: 'terminal_opened',
            protocolVersion: PROTOCOL_V1,
            sessionId: 'sess_term_blind',
            terminalId: 'term_blind',
            requestId: 'req_blind_open',
            envelope: fakeEnvelope('ok'),
          } satisfies TerminalOpened,
        ],
        [
          client,
          node,
          {
            type: 'terminal_input',
            protocolVersion: PROTOCOL_V1,
            sessionId: 'sess_term_blind',
            terminalId: 'term_blind',
            envelope: fakeEnvelope('super-secret-command'),
          } satisfies TerminalInput,
        ],
        [
          node,
          client,
          {
            type: 'terminal_output',
            protocolVersion: PROTOCOL_V1,
            sessionId: 'sess_term_blind',
            terminalId: 'term_blind',
            envelope: fakeEnvelope('super-secret-output'),
          } satisfies TerminalOutput,
        ],
      ];

      for (const [from, to, frame] of frames) {
        send(from, frame);
        const received = await nextMessage(to);
        expect(received).toEqual(frame);
        // Every key on the relay-visible frame is either declared routing
        // metadata or the opaque `envelope` — nothing else ever rides along.
        for (const key of Object.keys(received)) {
          expect([
            'type',
            'protocolVersion',
            'sessionId',
            'terminalId',
            'targetId',
            'requestId',
            'envelope',
          ]).toContain(key);
        }
      }
    });
  });

  describe('test_runner_config_get/_set/_detect and their replies (SPEC §7.15; issue #245) — routed and fanned out exactly like fs_list_request/fs_list_response, always blind', () => {
    /** Boots a relay, a `node`-role connection that has already announced `sessionId`, and a `client`-role connection subscribed to it (`session_resume`) — same shared setup the terminal tests above use. */
    async function bootstrapAnnouncedSession(
      sessionId: string,
    ): Promise<{ url: string; node: WebSocket; client: WebSocket }> {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: sessionId, accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId,
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      return { url, node, client };
    }

    it('routes a client test_runner_config_get to the owning node — no envelope, since asking carries no content', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_runnercfg_get');

      const request: TestRunnerConfigGet = {
        type: 'test_runner_config_get',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_runnercfg_get',
        requestId: 'req_get_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TestRunnerConfigGet;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client test_runner_config_set to the owning node, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_runnercfg_set');

      const request: TestRunnerConfigSet = {
        type: 'test_runner_config_set',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_runnercfg_set',
        requestId: 'req_set_1',
        envelope: fakeEnvelope('pnpm test'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TestRunnerConfigSet;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client test_runner_config_detect to the owning node — no envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_runnercfg_detect');

      const request: TestRunnerConfigDetect = {
        type: 'test_runner_config_detect',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_runnercfg_detect',
        requestId: 'req_detect_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as TestRunnerConfigDetect;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans test_runner_config_result out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_runnercfg_result');

      const response: TestRunnerConfigResult = {
        type: 'test_runner_config_result',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_runnercfg_result',
        requestId: 'req_get_1',
        envelope: fakeEnvelope('{"commands":{"test":"pnpm test"}}'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as TestRunnerConfigResult;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans test_runner_config_detected out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_runnercfg_detected');

      const response: TestRunnerConfigDetected = {
        type: 'test_runner_config_detected',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_runnercfg_detected',
        requestId: 'req_detect_1',
        envelope: fakeEnvelope('{"suggestions":{"test":"pnpm test"}}'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as TestRunnerConfigDetected;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });
  });

  describe('permission_policy_get/_set and their replies/violations (SPEC §7.17; issue #751) — routed and fanned out exactly like fs_list_request/fs_list_response, always blind', () => {
    /** Same shared setup the terminal/test_runner_config describe blocks above use. */
    async function bootstrapAnnouncedSession(
      sessionId: string,
    ): Promise<{ url: string; node: WebSocket; client: WebSocket }> {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: sessionId, accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId,
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      return { url, node, client };
    }

    it('routes a client permission_policy_get to the owning node — no envelope, since asking carries no content', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_permpolicy_get');

      const request: PermissionPolicyGet = {
        type: 'permission_policy_get',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_permpolicy_get',
        requestId: 'req_get_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as PermissionPolicyGet;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client permission_policy_set to the owning node, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_permpolicy_set');

      const request: PermissionPolicySet = {
        type: 'permission_policy_set',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_permpolicy_set',
        requestId: 'req_set_1',
        envelope: fakeEnvelope('{"policy":{"command":{"allow":[],"deny":["rm -rf *"]}}}'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as PermissionPolicySet;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans permission_policy_result out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_permpolicy_result');

      const response: PermissionPolicyResult = {
        type: 'permission_policy_result',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_permpolicy_result',
        requestId: 'req_get_1',
        envelope: fakeEnvelope('{"policy":{"command":{"allow":[],"deny":[]}}}'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as PermissionPolicyResult;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans permission_policy_violation out to the subscribed client, byte-for-byte, never inspecting the envelope — no requestId, node-initiated', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_permpolicy_violation');

      const response: PermissionPolicyViolation = {
        type: 'permission_policy_violation',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_permpolicy_violation',
        envelope: fakeEnvelope(
          '{"reason":{"kind":"permission_policy","dimension":"command","rule":"rm *","matched":"rm -rf /"}}',
        ),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as PermissionPolicyViolation;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'sessionId', 'type'].sort(),
      );
    });
  });

  describe('checkpoint_create/_list/_restore_preview/_restore and their replies (SPEC §7.20; issue #603) — routed and fanned out exactly like test_runner_config_get/_set/_detect above, always blind', () => {
    /** Same shared setup the terminal/test_runner_config describe blocks above use. */
    async function bootstrapAnnouncedSession(
      sessionId: string,
    ): Promise<{ url: string; node: WebSocket; client: WebSocket }> {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: sessionId, accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId,
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      return { url, node, client };
    }

    it('routes a client checkpoint_create to the owning node, byte-for-byte, never inspecting the envelope (the label stays opaque)', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_create');

      const request: CheckpointCreate = {
        type: 'checkpoint_create',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_create',
        requestId: 'req_create_1',
        envelope: fakeEnvelope('before refactor'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as CheckpointCreate;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client checkpoint_list to the owning node — no envelope, since asking carries no content', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_list');

      const request: CheckpointList = {
        type: 'checkpoint_list',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_list',
        requestId: 'req_list_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as CheckpointList;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client checkpoint_restore_preview to the owning node — checkpointId is a plain opaque id, no envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_preview');

      const request: CheckpointRestorePreview = {
        type: 'checkpoint_restore_preview',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_preview',
        requestId: 'req_preview_1',
        checkpointId: 'cp_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as CheckpointRestorePreview;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['checkpointId', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client checkpoint_restore to the owning node — checkpointId and confirm are plain fields, no envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_restore');

      const request: CheckpointRestore = {
        type: 'checkpoint_restore',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_restore',
        requestId: 'req_restore_1',
        checkpointId: 'cp_1',
        confirm: true,
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as CheckpointRestore;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['checkpointId', 'confirm', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans checkpoint_result out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_result');

      const response: CheckpointResult = {
        type: 'checkpoint_result',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_result',
        requestId: 'req_create_1',
        envelope: fakeEnvelope('{"outcome":"ok","checkpoint":{"id":"cp_1"}}'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as CheckpointResult;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans checkpoint_list_result out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_list_result');

      const response: CheckpointListResult = {
        type: 'checkpoint_list_result',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_list_result',
        requestId: 'req_list_1',
        envelope: fakeEnvelope('{"outcome":"ok","checkpoints":[]}'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as CheckpointListResult;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans checkpoint_restore_preview_result out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_preview_result');

      const response: CheckpointRestorePreviewResult = {
        type: 'checkpoint_restore_preview_result',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_preview_result',
        requestId: 'req_preview_1',
        envelope: fakeEnvelope(
          '{"outcome":"ok","preview":{"checkpointId":"cp_1","commitsSinceCheckpoint":0,"hasUncommittedChangesToDiscard":true,"isWorkInPlace":false}}',
        ),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as CheckpointRestorePreviewResult;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans checkpoint_restore_result out to the subscribed client, byte-for-byte, never inspecting the envelope (what a restore actually discarded stays opaque)', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_checkpoint_restore_result');

      const response: CheckpointRestoreResult = {
        type: 'checkpoint_restore_result',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_checkpoint_restore_result',
        requestId: 'req_restore_1',
        envelope: fakeEnvelope(
          '{"outcome":"ok","result":{"checkpointId":"cp_1","discardedUncommittedChanges":true,"commitsPreserved":0}}',
        ),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as CheckpointRestoreResult;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'sessionId', 'type'].sort(),
      );
    });
  });

  describe('run_start/run_cancel and run_started/run_output/run_exit (SPEC §7.15; issue #244) — routed and fanned out exactly like terminal_open/terminal_output, always blind', () => {
    /** Same shared setup the terminal/test_runner_config describe blocks above use. */
    async function bootstrapAnnouncedSession(
      sessionId: string,
    ): Promise<{ url: string; node: WebSocket; client: WebSocket }> {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: sessionId, accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId,
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      return { url, node, client };
    }

    it('routes a client run_start to the owning node, byte-for-byte, never inspecting the envelope (which kind ran stays opaque)', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_run_start');

      const request: RunStart = {
        type: 'run_start',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_run_start',
        targetId: 'target_1',
        runId: 'run_1',
        requestId: 'req_run_start_1',
        envelope: fakeEnvelope('test'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as RunStart;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        [
          'envelope',
          'protocolVersion',
          'requestId',
          'runId',
          'sessionId',
          'targetId',
          'type',
        ].sort(),
      );
    });

    it('fans run_started out to the subscribed client, byte-for-byte, never inspecting the envelope', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_run_started');

      const response: RunStarted = {
        type: 'run_started',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_run_started',
        runId: 'run_1',
        requestId: 'req_run_start_1',
        envelope: fakeEnvelope('ok'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as RunStarted;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'requestId', 'runId', 'sessionId', 'type'].sort(),
      );
    });

    it("fans run_output out to the session's subscribed client, byte-for-byte, never inspecting the envelope (the run's actual output stays opaque)", async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_run_output');

      const response: RunOutput = {
        type: 'run_output',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_run_output',
        runId: 'run_1',
        envelope: fakeEnvelope('FAIL src/secret.test.ts'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as RunOutput;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'runId', 'sessionId', 'type'].sort(),
      );
    });

    it('fans run_exit out to the subscribed client, byte-for-byte, never inspecting the envelope (pass/fail/exit code stay opaque)', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_run_exit');

      const response: RunExit = {
        type: 'run_exit',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_run_exit',
        runId: 'run_1',
        envelope: fakeEnvelope('{"outcome":"fail","exitCode":1}'),
      };
      send(node, response);

      const received = (await nextMessage(client)) as unknown as RunExit;
      expect(received).toEqual(response);
      expect(Object.keys(received).sort()).toEqual(
        ['envelope', 'protocolVersion', 'runId', 'sessionId', 'type'].sort(),
      );
    });

    it('routes a client run_cancel to the owning node — no envelope, since cancelling carries no content', async () => {
      const { node, client } = await bootstrapAnnouncedSession('sess_run_cancel');

      const request: RunCancel = {
        type: 'run_cancel',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_run_cancel',
        runId: 'run_1',
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as RunCancel;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'runId', 'sessionId', 'type'].sort(),
      );
    });

    it('ignores a run_start/run_cancel for an unknown session instead of throwing', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });

      send(client, {
        type: 'run_start',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        targetId: 'target_1',
        runId: 'run_orphan',
        requestId: 'req_orphan',
        envelope: fakeEnvelope('test'),
      } satisfies RunStart);
      send(client, {
        type: 'run_cancel',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_nonexistent',
        runId: 'run_orphan',
      } satisfies RunCancel);

      // the relay should still be responsive
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });
  });

  describe('device registry (#112): register / revoke / rotate', () => {
    it('registers a device at initialize and updates its label via device_register', async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_1',
        authToken: 'acct_1',
      });
      expect(store.devices.get('dev_1')?.accountId).toBe('acct_1');
      expect(store.devices.get('dev_1')?.status).toBe('active');

      send(socket, {
        type: 'device_register',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_1',
        devicePublicKey: fakeBase64('dev_1-pubkey'),
        label: 'My Phone',
      } satisfies DeviceRegister);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(store.devices.get('dev_1')?.label).toBe('My Phone');
    });

    it('revokes a device: the registry reflects it and the live connection is closed immediately', async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: victim } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_victim',
        authToken: 'acct_1',
      });
      const { socket: actor } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_actor',
        authToken: 'acct_1',
      });

      send(actor, {
        type: 'device_revoke',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_victim',
        newEpoch: 1,
        rewrappedAmk: [],
      } satisfies DeviceRevoke);

      await waitForClose(victim);
      expect(store.devices.get('dev_victim')?.status).toBe('revoked');

      // a revoked device can't reconnect
      const reconnectSocket = await connect(url);
      const initialize: Initialize = {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'client',
        authToken: 'acct_1',
        deviceId: 'dev_victim',
        devicePublicKey: fakeBase64('dev_victim-pubkey'),
      };
      send(reconnectSocket, initialize);
      const closeEvent = await waitForClose(reconnectSocket);
      expect(closeEvent.code).toBe(4403);
    });

    it('rotates a device public key', async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_1',
        authToken: 'acct_1',
      });
      const newKey = fakeBase64('rotated-key');
      send(socket, {
        type: 'device_rotate',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_1',
        newDevicePublicKey: newKey,
      } satisfies DeviceRotate);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(store.devices.get('dev_1')?.devicePublicKey).toBe(newKey);
    });
  });

  describe('AMK epoch rotation on revoke (#116): wrap-fan-out delivery', () => {
    it('bumps the account epoch and parks a rewrapped-AMK envelope only for each surviving device', async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: actor } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_actor',
        authToken: 'acct_1',
      });
      const { socket: victim } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_victim',
        authToken: 'acct_1',
      });
      const { socket: survivorX } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_survivor_x',
        authToken: 'acct_1',
      });
      const { socket: survivorY } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_survivor_y',
        authToken: 'acct_1',
      });

      const envelopeX = fakeEnvelope('for-x');
      const envelopeY = fakeEnvelope('for-y');
      send(actor, {
        type: 'device_revoke',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_victim',
        newEpoch: 1,
        rewrappedAmk: [
          { deviceId: 'dev_survivor_x', envelope: envelopeX },
          { deviceId: 'dev_survivor_y', envelope: envelopeY },
        ],
      } satisfies DeviceRevoke);

      await waitForClose(victim);
      expect(store.devices.get('dev_victim')?.status).toBe('revoked');
      expect(store.amkRotation.getCurrentEpoch('acct_1')).toBe(1);

      send(survivorX, {
        type: 'amk_epoch_fetch_request',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_survivor_x',
      });
      const responseX = (await nextMessage(survivorX)) as unknown as AmkEpochFetchResponse;
      expect(responseX.type).toBe('amk_epoch_fetch_response');
      expect(responseX.pending?.epoch).toBe(1);
      expect(responseX.pending?.fromDeviceId).toBe('dev_actor');
      expect(responseX.pending?.fromDevicePublicKey).toBe(fakeBase64('dev_actor-pubkey'));
      expect(responseX.pending?.envelope).toEqual(envelopeX);

      send(survivorY, {
        type: 'amk_epoch_fetch_request',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_survivor_y',
      });
      const responseY = (await nextMessage(survivorY)) as unknown as AmkEpochFetchResponse;
      // Y never sees X's envelope, and vice versa (proven by both bytes and identity).
      expect(responseY.pending?.envelope).toEqual(envelopeY);
      expect(responseY.pending?.envelope).not.toEqual(responseX.pending?.envelope);
    });

    it('a device with nothing pending gets pending: undefined, not another devices envelope', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_never_revoked',
        authToken: 'acct_1',
      });
      send(socket, {
        type: 'amk_epoch_fetch_request',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_never_revoked',
      });
      const response = (await nextMessage(socket)) as unknown as AmkEpochFetchResponse;
      expect(response.pending).toBeUndefined();
    });

    it("a device can't fetch another device's pending envelope by spoofing deviceId in the request", async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: actor } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_actor2',
        authToken: 'acct_1',
      });
      const { socket: victim } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_victim2',
        authToken: 'acct_1',
      });
      const { socket: survivor } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_survivor2',
        authToken: 'acct_1',
      });
      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_intruder2',
        authToken: 'acct_1',
      });

      send(actor, {
        type: 'device_revoke',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_victim2',
        newEpoch: 1,
        rewrappedAmk: [{ deviceId: 'dev_survivor2', envelope: fakeEnvelope('for-survivor2') }],
      } satisfies DeviceRevoke);
      await waitForClose(victim);

      // The intruder's own connection has deviceId `dev_intruder2`; asking
      // for `dev_survivor2`'s envelope by putting that id in the request
      // body must not work.
      send(intruder, {
        type: 'amk_epoch_fetch_request',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_survivor2',
      });
      const response = (await nextMessage(intruder)) as unknown as AmkEpochFetchResponse;
      expect(response.deviceId).toBe('dev_intruder2');
      expect(response.pending).toBeUndefined();

      // The real survivor still gets its own envelope.
      send(survivor, {
        type: 'amk_epoch_fetch_request',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_survivor2',
      });
      const survivorResponse = (await nextMessage(survivor)) as unknown as AmkEpochFetchResponse;
      expect(survivorResponse.pending).toBeDefined();
    });

    it('a revoked device is closed immediately and can never fetch (reconnect itself is rejected)', async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: actor } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_actor3',
        authToken: 'acct_1',
      });
      const { socket: victim } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_victim3',
        authToken: 'acct_1',
      });

      send(actor, {
        type: 'device_revoke',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_victim3',
        newEpoch: 1,
        rewrappedAmk: [],
      } satisfies DeviceRevoke);
      await waitForClose(victim);

      // The relay never parked anything under the revoked device's own id.
      expect(store.amkRotation.getPending('acct_1', 'dev_victim3')).toBeUndefined();

      // And it can't reconnect to ask (already covered above for the base
      // device-registry case, re-asserted here alongside the new fetch path).
      const reconnectSocket = await connect(url);
      send(reconnectSocket, {
        type: 'initialize',
        protocolVersion: PROTOCOL_V1,
        role: 'client',
        authToken: 'acct_1',
        deviceId: 'dev_victim3',
        devicePublicKey: fakeBase64('dev_victim3-pubkey'),
      } satisfies Initialize);
      const closeEvent = await waitForClose(reconnectSocket);
      expect(closeEvent.code).toBe(4403);
    });

    it('rejects a device_revoke whose newEpoch is not exactly one past the account current epoch', async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: actor } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_actor4',
        authToken: 'acct_1',
      });
      const { socket: victim } = await initConnection(url, {
        role: 'client',
        deviceId: 'dev_victim4',
        authToken: 'acct_1',
      });

      // Skips straight to epoch 2 without ever having advanced to 1.
      send(actor, {
        type: 'device_revoke',
        protocolVersion: PROTOCOL_V1,
        deviceId: 'dev_victim4',
        newEpoch: 2,
        rewrappedAmk: [],
      } satisfies DeviceRevoke);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Rejected wholesale: the device stays active, un-revoked, un-closed.
      expect(store.devices.get('dev_victim4')?.status).toBe('active');
      expect(store.amkRotation.getCurrentEpoch('acct_1')).toBe(0);
      expect(victim.readyState).toBe(WebSocket.OPEN);
    });

    it('account isolation: a pending envelope never crosses accounts even for a colliding deviceId', () => {
      const store = createInMemoryRelayStore();
      store.amkRotation.putPending('acct_a', 'dev_shared_id', {
        epoch: 1,
        fromDeviceId: 'dev_a_actor',
        envelope: fakeEnvelope('acct-a-payload'),
      });
      expect(store.amkRotation.getPending('acct_b', 'dev_shared_id')).toBeUndefined();
      expect(store.amkRotation.getPending('acct_a', 'dev_shared_id')?.envelope).toEqual(
        fakeEnvelope('acct-a-payload'),
      );
    });
  });

  describe('blob store (#99): ciphertext in, ciphertext out', () => {
    it('round-trips an uploaded ciphertext blob byte-for-byte by opaque ref', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_blob', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const blobEnvelope = fakeEnvelope('totally-opaque-not-real-crypto', 'blob');
      send(client, {
        type: 'blob_upload',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_blob',
        ref: 'ref_1',
        envelope: blobEnvelope,
      } satisfies BlobUpload);
      await new Promise((resolve) => setTimeout(resolve, 50));

      send(client, {
        type: 'blob_download',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_blob',
        ref: 'ref_1',
      });
      const response = (await nextMessage(client)) as unknown as BlobDownloadResponse;
      expect(response.type).toBe('blob_download_response');
      expect(response.envelope).toEqual(blobEnvelope);
    });

    it('serves blob_download to the executing host (node role) so it can fetch a client-uploaded attachment (#156)', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_blob_node', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // A client uploads the attachment ciphertext.
      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const blobEnvelope = fakeEnvelope('opaque-attachment', 'blob');
      send(client, {
        type: 'blob_upload',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_blob_node',
        ref: 'att_1',
        envelope: blobEnvelope,
      } satisfies BlobUpload);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The executing host (node role) fetches it back.
      send(node, {
        type: 'blob_download',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_blob_node',
        ref: 'att_1',
      });
      const response = (await nextMessage(node)) as unknown as BlobDownloadResponse;
      expect(response.type).toBe('blob_download_response');
      expect(response.envelope).toEqual(blobEnvelope);
    });

    it('does not respond to a download for an unknown ref', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_blob_missing', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'blob_download',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_blob_missing',
        ref: 'ref_missing',
      });
      // no response for the unknown ref: prove it with a direct round trip next
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      expect(list.type).toBe('session_list');
    });
  });

  describe('resync replay after a simulated drop (#98/#254, seq continuity)', () => {
    it('replays a resync_marker for the evicted range then the still-buffered envelopes in seq order', async () => {
      const store = createInMemoryRelayStore({ ringBufferSize: 3 });
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_resync', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const envelopes = Array.from({ length: 5 }, (_, i) => fakeEnvelope(`chunk-${i + 1}`));
      for (const envelope of envelopes) {
        send(node, {
          type: 'session_update',
          protocolVersion: PROTOCOL_V1,
          sessionId: 'sess_resync',
          seq: 0,
          envelope,
        } satisfies SessionUpdateEnvelopeV1);
      }
      // synchronize: ensure the relay has processed all 5 session_updates before resyncing
      await new Promise((resolve) => setTimeout(resolve, 100));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'resync_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_resync',
        sinceSeq: 0,
      });

      const marker = (await nextMessage(client)) as unknown as ResyncMarker;
      expect(marker.type).toBe('resync_marker');
      expect(marker.dropped).toBe(true);
      expect(marker.fromSeq).toBe(1);
      expect(marker.toSeq).toBe(2);

      const replayed: SessionUpdateEnvelopeV1[] = [];
      for (let i = 0; i < 3; i++) {
        replayed.push((await nextMessage(client)) as unknown as SessionUpdateEnvelopeV1);
      }
      expect(replayed.map((m) => m.seq)).toEqual([3, 4, 5]);
      expect(replayed.map((m) => m.envelope)).toEqual([envelopes[2], envelopes[3], envelopes[4]]);
      // seq continuity: the replay picks up exactly where the marker's dropped range ends
      expect(replayed[0]?.seq).toBe(marker.toSeq + 1);
    });
  });

  describe('drop-oldest backpressure emitting a resync_marker (#98/#254)', () => {
    it('drops the oldest queued live updates under a burst and signals a resync_marker, keeping seq continuity for the tail', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        maxClientQueueDepth: 2,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_burst', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId: 'sess_burst',
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      const received: Array<Record<string, unknown>> = [];
      client.addEventListener('message', (event) => {
        received.push(JSON.parse(event.data.toString()) as Record<string, unknown>);
      });

      const burstSize = 50;
      for (let i = 1; i <= burstSize; i++) {
        send(node, {
          type: 'session_update',
          protocolVersion: PROTOCOL_V1,
          sessionId: 'sess_burst',
          seq: 0,
          envelope: fakeEnvelope(`chunk-${i}`),
        } satisfies SessionUpdateEnvelopeV1);
      }

      // let the burst fully arrive and drain settle
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(received.length).toBeLessThan(burstSize);
      expect(received.length).toBeGreaterThan(0);

      const markers = received.filter(
        (m) => m.type === 'resync_marker',
      ) as unknown as ResyncMarker[];
      const updates = received.filter(
        (m) => m.type === 'session_update',
      ) as unknown as SessionUpdateEnvelopeV1[];

      // at least one overflow happened, and every marker correctly signals the drop
      expect(markers.length).toBeGreaterThan(0);
      for (const marker of markers) {
        expect(marker.dropped).toBe(true);
        expect(marker.sessionId).toBe('sess_burst');
        expect(marker.fromSeq).toBeLessThanOrEqual(marker.toSeq);
      }

      // seq continuity for whatever updates did survive: strictly increasing, no duplicates/regressions
      for (let i = 1; i < updates.length; i++) {
        expect(updates[i]?.seq).toBeGreaterThan(updates[i - 1]?.seq ?? 0);
      }
      // drop-oldest: the very last update sent must still be the very last one delivered
      expect(updates.at(-1)?.seq).toBe(burstSize);
    });
  });

  describe('blob_ref file events bypass the session_update bounded queue (SPEC §7.16, issue #154)', () => {
    it('a saturated session_update queue that drops most updates still delivers a blob_ref, byte-for-byte, unaffected', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        maxClientQueueDepth: 1,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_blob_burst', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId: 'sess_blob_burst',
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client); // the session_announce reply from resume

      const received: Array<Record<string, unknown>> = [];
      client.addEventListener('message', (event) => {
        received.push(JSON.parse(event.data.toString()) as Record<string, unknown>);
      });

      // A burst big enough (at this depth) to genuinely overflow the
      // client's bounded queue and drop most of the updates, immediately
      // followed — on the very same node connection, processed dead last —
      // by ONE blob_ref file event.
      const burstSize = 50;
      for (let i = 1; i <= burstSize; i++) {
        send(node, {
          type: 'session_update',
          protocolVersion: PROTOCOL_V1,
          sessionId: 'sess_blob_burst',
          seq: 0,
          envelope: fakeEnvelope(`chunk-${i}`),
        } satisfies SessionUpdateEnvelopeV1);
      }
      const blobRefEnvelope = fakeEnvelope('attachment-metadata', 'sess_blob_burst:ref-1');
      send(node, {
        type: 'blob_ref',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_blob_burst',
        ref: 'ref-1',
        envelope: blobRefEnvelope,
      } satisfies BlobRef);

      // Same generous settle window the drop-oldest test above relies on.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The bound genuinely bit: most of the burst never survived as a
      // real session_update, and at least one resync_marker signaled it.
      const updates = received.filter((m) => m.type === 'session_update');
      const markers = received.filter((m) => m.type === 'resync_marker');
      expect(updates.length).toBeLessThan(burstSize);
      expect(markers.length).toBeGreaterThan(0);

      // The blob_ref is nonetheless delivered exactly once, byte-for-byte
      // the same opaque envelope sent — never dropped, never folded into a
      // resync marker, never gated behind the backlog it was queued after.
      const blobRefs = received.filter((m) => m.type === 'blob_ref');
      expect(blobRefs).toEqual([
        {
          type: 'blob_ref',
          protocolVersion: PROTOCOL_V1,
          sessionId: 'sess_blob_burst',
          ref: 'ref-1',
          envelope: blobRefEnvelope,
        },
      ]);
    });
  });

  describe('the relay never needs plaintext', () => {
    it('forwards and stores garbage ciphertext byte-for-byte without ever touching it', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_blind', accountId: 'acct_1' });
      // The "title" envelope is not real AES-GCM output — just opaque base64 the relay must never decode.
      const notReallyEncrypted = fakeEnvelope('this-is-not-valid-ciphertext- -garbage');
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: notReallyEncrypted,
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const list = (await nextMessage(client)) as unknown as SessionListV1;
      // Byte-for-byte round trip of opaque "ciphertext" the relay never attempted to interpret.
      expect(list.sessions[0]?.privateEnvelope).toEqual(notReallyEncrypted);
    });

    it('round-trips fs_list_request/fs_list_response garbage "ciphertext" byte-for-byte — a real directory path never has to be decryptable by the relay for routing/fan-out to work (SPEC §7.4/§8; issue #171/#160)', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_fs_list_blind', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_resume',
        sessionId: 'sess_fs_list_blind',
        protocolVersion: PROTOCOL_V1,
      } satisfies SessionResume);
      await nextMessage(client);

      // Deliberately not valid AES-GCM output — garbage the relay must
      // forward opaquely. If the relay ever attempted to JSON.parse or
      // decrypt this to route it, this test would hang/throw instead of
      // round-tripping.
      const notReallyEncryptedRequest = fakeEnvelope('this-is-not-a-real-envelope-either');
      send(client, {
        type: 'fs_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_fs_list_blind',
        targetId: 'target_1',
        requestId: 'req_blind',
        envelope: notReallyEncryptedRequest,
      } satisfies FsListRequest);
      const forwardedRequest = (await nextMessage(node)) as unknown as FsListRequest;
      expect(forwardedRequest.envelope).toEqual(notReallyEncryptedRequest);

      const notReallyEncryptedResponse = fakeEnvelope('also-not-a-real-envelope');
      send(node, {
        type: 'fs_list_response',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'sess_fs_list_blind',
        requestId: 'req_blind',
        envelope: notReallyEncryptedResponse,
      } satisfies FsListResponse);
      const forwardedResponse = (await nextMessage(client)) as unknown as FsListResponse;
      expect(forwardedResponse.envelope).toEqual(notReallyEncryptedResponse);
    });
  });

  describe('session_archive_request/session_archive_response (SPEC §7.2, issue #512): the row-menu archive action, account-checked and routed by sessionId like session_resume, published account-wide on success', () => {
    it('routes session_archive_request to the node owning that session, byte-for-byte, keeping requestId', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_archive_route', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: SessionArchiveRequest = {
        type: 'session_archive_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_archive_1',
        sessionId: 'sess_archive_route',
        removeWorktree: true,
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as SessionArchiveRequest;
      expect(received).toEqual(request);
      expect(Object.keys(received).sort()).toEqual(
        ['protocolVersion', 'removeWorktree', 'requestId', 'sessionId', 'type'].sort(),
      );
    });

    it('an archive request for an unknown sessionId gets outcome: "error" directly, without routing it anywhere', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_archive_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_archive_unknown',
        sessionId: 'sess_nonexistent',
        removeWorktree: false,
      } satisfies SessionArchiveRequest);

      const response = (await nextMessage(client)) as unknown as SessionArchiveResponse;
      expect(response.type).toBe('session_archive_response');
      expect(response.requestId).toBe('req_archive_unknown');
      expect(response.result.outcome).toBe('error');
    });

    it("archiving a foreign account's session is refused: outcome: 'error' comes back directly and it is never routed to the owning node", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      const meta = makeSessionMeta({ id: 'sess_archive_foreign', accountId: 'acct_owner' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, {
        type: 'session_archive_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_archive_intruder',
        sessionId: 'sess_archive_foreign',
        removeWorktree: true,
      } satisfies SessionArchiveRequest);

      const response = (await nextMessage(intruder)) as unknown as SessionArchiveResponse;
      expect(response.result.outcome).toBe('error');

      // The owning node must never have received it — assert directly
      // rather than only inferring it from relay liveness (a node
      // connection has no session_list_request-style benign round trip of
      // its own to prove aliveness with).
      await expect(nextMessage(node, 200)).rejects.toThrow(/timed out/);

      // Prove the relay itself is still alive and responsive.
      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const intruderNext = await nextMessage(intruder);
      expect(intruderNext.type).toBe('session_list');
    });

    it("archiving with outcome: 'ok' deletes the session from the relay store and reaches every client of the account, not just the requester", async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_archive_ok', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await store.sessions.get('sess_archive_ok')).toBeDefined();

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      // A second, uninvolved client on the SAME account — must ALSO see
      // the archive result, not just the requester (#512's whole point: a
      // second device holding the same board must drop the row too).
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: SessionArchiveRequest = {
        type: 'session_archive_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_archive_ok',
        sessionId: 'sess_archive_ok',
        removeWorktree: true,
      };
      send(requester, request);
      const forwarded = (await nextMessage(node)) as unknown as SessionArchiveRequest;
      expect(forwarded).toEqual(request);

      const response: SessionArchiveResponse = {
        type: 'session_archive_response',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        sessionId: 'sess_archive_ok',
        result: { outcome: 'ok' },
      };
      send(node, response);

      const requesterReply = (await nextMessage(requester)) as unknown as SessionArchiveResponse;
      expect(requesterReply).toEqual(response);
      const bystanderReply = (await nextMessage(bystander)) as unknown as SessionArchiveResponse;
      expect(bystanderReply).toEqual(response);

      expect(await store.sessions.get('sess_archive_ok')).toBeUndefined();
    });

    it("archiving with outcome: 'error' still reaches the requester but leaves the session in the relay store", async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      const meta = makeSessionMeta({ id: 'sess_archive_err', accountId: 'acct_1' });
      send(node, {
        type: 'session_announce',
        protocolVersion: PROTOCOL_V1,
        session: meta,
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionAnnounceV1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      send(requester, {
        type: 'session_archive_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_archive_err',
        sessionId: 'sess_archive_err',
        removeWorktree: true,
      } satisfies SessionArchiveRequest);
      await nextMessage(node);

      send(node, {
        type: 'session_archive_response',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_archive_err',
        sessionId: 'sess_archive_err',
        result: { outcome: 'error', message: 'git worktree remove failed: exit code 128' },
      } satisfies SessionArchiveResponse);

      const requesterReply = (await nextMessage(requester)) as unknown as SessionArchiveResponse;
      expect(requesterReply.result).toEqual({
        outcome: 'error',
        message: 'git worktree remove failed: exit code 128',
      });
      expect(await store.sessions.get('sess_archive_err')).toBeDefined();
    });
  });

  describe('session_fork_request/session_fork_response (design spec `2026-08-05-zed-parity-decisions.md` §3 C6-2, issue #746): routed by targetId like session_create (the forked session has no SessionRecord yet), replied to account-wide like session_archive_response', () => {
    it('routes session_fork_request to the node owning the target, byte-for-byte, keeping requestId', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget()],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      const request: SessionForkRequest = {
        type: 'session_fork_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_fork_1',
        sessionId: 'sess_fork_new',
        sourceSessionId: 'sess_source',
        targetId: 'target_1',
        provider: 'claude',
        privateEnvelope: fakeEnvelope('title'),
      };
      send(client, request);

      const received = (await nextMessage(node)) as unknown as SessionForkRequest;
      expect(received).toEqual(request);
    });

    it("a fork request for an unknown/foreign target gets outcome: 'error' directly, without routing it anywhere", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_1',
      });
      send(client, {
        type: 'session_fork_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_fork_unknown',
        sessionId: 'sess_fork_new',
        sourceSessionId: 'sess_source',
        targetId: 'target_nonexistent',
        provider: 'claude',
        privateEnvelope: fakeEnvelope('title'),
      } satisfies SessionForkRequest);

      const response = (await nextMessage(client)) as unknown as SessionForkResponse;
      expect(response.type).toBe('session_fork_response');
      expect(response.requestId).toBe('req_fork_unknown');
      expect(response.result.outcome).toBe('error');
    });

    it("forking with outcome: 'ok' reaches every client of the account, not just the requester, and leaves the relay store alone (no deletion, unlike archive)", async () => {
      const store = createInMemoryRelayStore();
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0, store });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_1',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [makeTarget()],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_1',
      });
      // A second, uninvolved client on the SAME account — must ALSO see the
      // fork's outcome, same "every device holding the same board" reasoning
      // session_archive_response's own broadcast test already establishes.
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_1',
      });

      const request: SessionForkRequest = {
        type: 'session_fork_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req_fork_ok',
        sessionId: 'sess_fork_ok',
        sourceSessionId: 'sess_source',
        targetId: 'target_1',
        provider: 'claude',
        privateEnvelope: fakeEnvelope('title'),
      };
      send(requester, request);
      const forwarded = (await nextMessage(node)) as unknown as SessionForkRequest;
      expect(forwarded).toEqual(request);

      const response: SessionForkResponse = {
        type: 'session_fork_response',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        sessionId: 'sess_fork_ok',
        result: { outcome: 'ok' },
      };
      send(node, response);

      const requesterReply = (await nextMessage(requester)) as unknown as SessionForkResponse;
      expect(requesterReply).toEqual(response);
      const bystanderReply = (await nextMessage(bystander)) as unknown as SessionForkResponse;
      expect(bystanderReply).toEqual(response);
    });
  });
});

describe('device escrow / new-device bootstrap (SPEC §8 path 2, §16; issues #114/#115)', () => {
  it('amk_escrow stores an opaque blob, and new_device_bootstrap_request returns the exact same blob for that account', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const { socket: firstDevice } = await initConnection(url, {
      role: 'client',
      deviceId: 'device-1',
      authToken: 'acct_escrow',
    });
    const wrappedAmk = fakeBase64('not-really-a-wrapped-amk-just-opaque-bytes');
    send(firstDevice, {
      type: 'amk_escrow',
      protocolVersion: PROTOCOL_V1,
      wrappedAmk,
    } satisfies AmkEscrow);
    // amk_escrow has no reply; give the relay a beat to process it before the second device asks.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { socket: newDevice } = await initConnection(url, {
      role: 'client',
      deviceId: 'device-2',
      authToken: 'acct_escrow',
    });
    send(newDevice, {
      type: 'new_device_bootstrap_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: 'device-2',
      devicePublicKey: fakeBase64('device-2-pubkey'),
    } satisfies NewDeviceBootstrapRequest);

    const response = (await nextMessage(newDevice)) as unknown as NewDeviceBootstrapResponse;
    expect(response.type).toBe('new_device_bootstrap_response');
    // Byte-for-byte the exact same opaque blob that was escrowed — the relay never touches it.
    expect(response.wrappedAmk).toBe(wrappedAmk);
  });

  it('never returns another account’s escrowed blob', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const { socket: accountAFirstDevice } = await initConnection(url, {
      role: 'client',
      deviceId: 'a-device-1',
      authToken: 'acct_a',
    });
    send(accountAFirstDevice, {
      type: 'amk_escrow',
      protocolVersion: PROTOCOL_V1,
      wrappedAmk: fakeBase64('acct-a-wrapped-amk'),
    } satisfies AmkEscrow);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A different account bootstraps a new device — it must never see acct_a's blob.
    const { socket: accountBNewDevice } = await initConnection(url, {
      role: 'client',
      deviceId: 'b-device-1',
      authToken: 'acct_b',
    });
    send(accountBNewDevice, {
      type: 'new_device_bootstrap_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: 'b-device-1',
      devicePublicKey: fakeBase64('b-device-1-pubkey'),
    } satisfies NewDeviceBootstrapRequest);

    // acct_b has never escrowed anything itself, so the relay has nothing to
    // hand back — assert no `new_device_bootstrap_response` ever arrives
    // (in particular, never acct_a's blob).
    let sawResponse = false;
    await Promise.race([
      nextMessage(accountBNewDevice, 300)
        .then(() => {
          sawResponse = true;
        })
        .catch(() => undefined),
    ]);
    expect(sawResponse).toBe(false);
  });

  it('a second escrow for the same account overwrites the first (re-escrow after a fresh AMK)', async () => {
    const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
    closers.push(close);

    const { socket: device } = await initConnection(url, {
      role: 'client',
      deviceId: 'device-1',
      authToken: 'acct_overwrite',
    });
    send(device, {
      type: 'amk_escrow',
      protocolVersion: PROTOCOL_V1,
      wrappedAmk: fakeBase64('old-wrapped-amk'),
    } satisfies AmkEscrow);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const freshBlob = fakeBase64('new-wrapped-amk');
    send(device, {
      type: 'amk_escrow',
      protocolVersion: PROTOCOL_V1,
      wrappedAmk: freshBlob,
    } satisfies AmkEscrow);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const { socket: newDevice } = await initConnection(url, {
      role: 'client',
      deviceId: 'device-2',
      authToken: 'acct_overwrite',
    });
    send(newDevice, {
      type: 'new_device_bootstrap_request',
      protocolVersion: PROTOCOL_V1,
      deviceId: 'device-2',
      devicePublicKey: fakeBase64('device-2-pubkey'),
    } satisfies NewDeviceBootstrapRequest);

    const response = (await nextMessage(newDevice)) as unknown as NewDeviceBootstrapResponse;
    expect(response.wrappedAmk).toBe(freshBlob);
  });

  describe('session-ownership leases (SPEC §9; issues #82/#104)', () => {
    it('grants an unheld session, denies a conflicting node while it is live, and grants again after an explicit release', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: nodeA } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-a',
        authToken: 'acct_lease',
      });
      const { socket: nodeB } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-b',
        authToken: 'acct_lease',
      });

      send(nodeA, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-a-1',
        sessionId: 'sess_lease_1',
        nodeId: 'node_a',
        action: 'acquire',
      } satisfies LeaseRequest);
      const granted = (await nextMessage(nodeA)) as unknown as LeaseResult;
      expect(granted.requestId).toBe('req-a-1');
      expect(granted.result.outcome).toBe('granted');

      // A second node's acquire is denied while the lease is live, naming the current holder.
      send(nodeB, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-b-1',
        sessionId: 'sess_lease_1',
        nodeId: 'node_b',
        action: 'acquire',
      } satisfies LeaseRequest);
      const denied = (await nextMessage(nodeB)) as unknown as LeaseResult;
      expect(denied.requestId).toBe('req-b-1');
      expect(denied.result).toEqual({
        outcome: 'denied',
        heldBy: 'node_a',
        expiresAt: (granted.result as { outcome: 'granted'; expiresAt: number }).expiresAt,
      });

      // node A releases; only then can node B acquire.
      send(nodeA, {
        type: 'lease_release',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-a-release',
        sessionId: 'sess_lease_1',
        nodeId: 'node_a',
      } satisfies LeaseRelease);
      const releaseResult = (await nextMessage(nodeA)) as unknown as LeaseReleaseResult;
      expect(releaseResult.released).toBe(true);

      send(nodeB, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-b-2',
        sessionId: 'sess_lease_1',
        nodeId: 'node_b',
        action: 'acquire',
      } satisfies LeaseRequest);
      const grantedAfterRelease = (await nextMessage(nodeB)) as unknown as LeaseResult;
      expect(grantedAfterRelease.result.outcome).toBe('granted');
    });

    it('renew extends only for the current holder; a non-holder renew is denied without granting', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: nodeA } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-a2',
        authToken: 'acct_lease_renew',
      });
      const { socket: nodeB } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-b2',
        authToken: 'acct_lease_renew',
      });

      send(nodeA, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        sessionId: 'sess_lease_2',
        nodeId: 'node_a',
        action: 'acquire',
        ttlMs: 5_000,
      } satisfies LeaseRequest);
      await nextMessage(nodeA);

      // A non-holder's renew is denied and never grants it the lease.
      send(nodeB, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-2',
        sessionId: 'sess_lease_2',
        nodeId: 'node_b',
        action: 'renew',
      } satisfies LeaseRequest);
      const foreignRenew = (await nextMessage(nodeB)) as unknown as LeaseResult;
      expect(foreignRenew.result.outcome).toBe('denied');
      if (foreignRenew.result.outcome === 'denied') {
        expect(foreignRenew.result.heldBy).toBe('node_a');
      }

      // The actual holder's renew succeeds.
      send(nodeA, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-3',
        sessionId: 'sess_lease_2',
        nodeId: 'node_a',
        action: 'renew',
        ttlMs: 5_000,
      } satisfies LeaseRequest);
      const renewed = (await nextMessage(nodeA)) as unknown as LeaseResult;
      expect(renewed.result.outcome).toBe('granted');
    });

    it('clamps a requested ttlMs to leaseTtlMs.max, and a lease past its expiry is granted to a different node without needing a release (lazy expiry)', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        leaseTtlMs: { default: 30_000, max: 50 },
      });
      closers.push(close);

      const { socket: nodeA } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-a4',
        authToken: 'acct_lease_clamp',
      });
      const { socket: nodeB } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-b4',
        authToken: 'acct_lease_clamp',
      });

      send(nodeA, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-1',
        sessionId: 'sess_lease_4',
        nodeId: 'node_a',
        // Asks for a much longer TTL than the relay's configured max — the
        // relay clamps it down rather than trusting the caller's value.
        ttlMs: 60_000,
        action: 'acquire',
      } satisfies LeaseRequest);
      const granted = (await nextMessage(nodeA)) as unknown as LeaseResult;
      expect(granted.result.outcome).toBe('granted');
      if (granted.result.outcome === 'granted') {
        expect(granted.result.expiresAt).toBeLessThan(Date.now() + 1_000);
      }

      // Still live: a conflicting acquire is denied.
      send(nodeB, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-2',
        sessionId: 'sess_lease_4',
        nodeId: 'node_b',
        action: 'acquire',
      } satisfies LeaseRequest);
      const stillDenied = (await nextMessage(nodeB)) as unknown as LeaseResult;
      expect(stillDenied.result.outcome).toBe('denied');

      await new Promise((resolve) => setTimeout(resolve, 80));

      send(nodeB, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-3',
        sessionId: 'sess_lease_4',
        nodeId: 'node_b',
        action: 'acquire',
      } satisfies LeaseRequest);
      const grantedAfterExpiry = (await nextMessage(nodeB)) as unknown as LeaseResult;
      expect(grantedAfterExpiry.result.outcome).toBe('granted');
    });

    it('scopes leases per account: two accounts can each hold a lease for the same sessionId without contending', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: nodeAcctA } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-acct-a',
        authToken: 'acct_isolated_a',
      });
      const { socket: nodeAcctB } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-acct-b',
        authToken: 'acct_isolated_b',
      });

      send(nodeAcctA, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-a',
        sessionId: 'sess_shared_id',
        nodeId: 'node_x',
        action: 'acquire',
      } satisfies LeaseRequest);
      const grantedA = (await nextMessage(nodeAcctA)) as unknown as LeaseResult;
      expect(grantedA.result.outcome).toBe('granted');

      // A different account's node acquiring the exact same sessionId is
      // unaffected — the relay scopes leases per (accountId, sessionId).
      send(nodeAcctB, {
        type: 'lease_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-b',
        sessionId: 'sess_shared_id',
        nodeId: 'node_y',
        action: 'acquire',
      } satisfies LeaseRequest);
      const grantedB = (await nextMessage(nodeAcctB)) as unknown as LeaseResult;
      expect(grantedB.result.outcome).toBe('granted');
    });

    it('releasing a lease this node does not hold is a no-op, reported as released: false', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'device-node-noop-release',
        authToken: 'acct_lease_noop',
      });

      send(node, {
        type: 'lease_release',
        protocolVersion: PROTOCOL_V1,
        requestId: 'req-noop',
        sessionId: 'sess_never_leased',
        nodeId: 'node_ghost',
      } satisfies LeaseRelease);
      const result = (await nextMessage(node)) as unknown as LeaseReleaseResult;
      expect(result.released).toBe(false);
    });
  });

  describe('provision_target routing (#410): zero-touch add-target wizard wire-through', () => {
    function makeProvisionRequest(
      overrides: Partial<ProvisionTargetRequest> = {},
    ): ProvisionTargetRequest {
      return {
        type: 'provision_target_request',
        protocolVersion: PROTOCOL_V1,
        requestId: 'preq_1',
        nodeId: 'node_1',
        targetId: 'target_new',
        host: { host: 'devbox.example.com' },
        ...overrides,
      };
    }

    it("routes provision_target_request to the node identified by nodeId, scoped to the requester's account", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_a',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: client } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-device',
        authToken: 'acct_a',
      });
      const request = makeProvisionRequest();
      send(client, request);

      const received = (await nextMessage(node)) as unknown as ProvisionTargetRequest;
      expect(received).toEqual(request);
    });

    it('does not route provision_target_request to a node owned by another account', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_owner',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: intruder } = await initConnection(url, {
        role: 'client',
        deviceId: 'intruder-device',
        authToken: 'acct_other',
      });
      send(intruder, makeProvisionRequest({ requestId: 'preq_intruder' }));

      // The owner's node must not receive it; prove the relay is still
      // alive with a benign round trip instead (same technique as the
      // session_create cross-account test above).
      send(intruder, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const response = (await nextMessage(intruder)) as unknown as SessionListV1;
      expect(response.type).toBe('session_list');
    });

    it('streams provision_progress and provision_target_result back to the requesting client only', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_a',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: requester } = await initConnection(url, {
        role: 'client',
        deviceId: 'requester-device',
        authToken: 'acct_a',
      });
      // A second, uninvolved client on the SAME account — must never see
      // this request's progress/result.
      const { socket: bystander } = await initConnection(url, {
        role: 'client',
        deviceId: 'bystander-device',
        authToken: 'acct_a',
      });

      const request = makeProvisionRequest();
      send(requester, request);
      await nextMessage(node); // the node's own copy of the request

      const progress: ProvisionProgress = {
        type: 'provision_progress',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        step: 'verify_and_persist',
        status: 'ok',
        message: 'verified',
      };
      send(node, progress);
      const receivedProgress = (await nextMessage(requester)) as unknown as ProvisionProgress;
      expect(receivedProgress).toEqual(progress);

      const result: ProvisionTargetResult = {
        type: 'provision_target_result',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        ok: true,
        message: 'paired',
      };
      send(node, result);
      const receivedResult = (await nextMessage(requester)) as unknown as ProvisionTargetResult;
      expect(receivedResult).toEqual(result);

      // The bystander never received either — prove it's still alive and
      // its next frame is the benign one we send now, not a leaked
      // progress/result.
      send(bystander, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const bystanderNext = await nextMessage(bystander);
      expect(bystanderNext.type).toBe('session_list');
    });

    it("account isolation: another account's client can't target this node, and never sees this request's progress", async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: nodeA } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-a-device',
        authToken: 'acct_a',
      });
      send(nodeA, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_a',
        targets: [],
      } satisfies TargetAnnounce);

      const { socket: nodeB } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-b-device',
        authToken: 'acct_b',
      });
      send(nodeB, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_b',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: clientA } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-a-device',
        authToken: 'acct_a',
      });
      const { socket: clientB } = await initConnection(url, {
        role: 'client',
        deviceId: 'client-b-device',
        authToken: 'acct_b',
      });

      const requestA = makeProvisionRequest({ requestId: 'preq_a', nodeId: 'node_a' });
      send(clientA, requestA);
      await nextMessage(nodeA);

      const progress: ProvisionProgress = {
        type: 'provision_progress',
        protocolVersion: PROTOCOL_V1,
        requestId: requestA.requestId,
        nodeId: 'node_a',
        targetId: requestA.targetId,
        step: 'runtime_bootstrap',
        status: 'started',
        message: 'installing runtime',
      };
      send(nodeA, progress);
      const receivedByA = (await nextMessage(clientA)) as unknown as ProvisionProgress;
      expect(receivedByA).toEqual(progress);

      // clientB never subscribed to requestA — prove it stays quiet by
      // racing a benign round trip against it.
      send(clientB, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const clientBNext = await nextMessage(clientB);
      expect(clientBNext.type).toBe('session_list');

      // nodeB, forwarding a spoofed reply for account A's requestId, is
      // rejected (account mismatch) rather than delivered to clientA.
      send(nodeB, { ...progress, message: 'spoofed from acct_b' } satisfies ProvisionProgress);
      send(clientA, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const clientANext = (await nextMessage(clientA)) as unknown as SessionListV1;
      expect(clientANext.type).toBe('session_list');
    });

    it('cleans up the routing entry once the final result is delivered: a reused requestId starts fresh', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_a',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_a',
      });
      const request = makeProvisionRequest({ requestId: 'preq_reused' });
      send(firstClient, request);
      await nextMessage(node);

      const result: ProvisionTargetResult = {
        type: 'provision_target_result',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        ok: true,
        message: 'paired',
      };
      send(node, result);
      expect(await nextMessage(firstClient)).toEqual(result);

      // A stray progress reusing the now-cleaned-up requestId must not
      // reach the original (still-connected) client.
      send(node, {
        type: 'provision_progress',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        step: 'target_identity',
        status: 'started',
        message: 'stray, should be dropped',
      } satisfies ProvisionProgress);

      // A second client reuses the exact same requestId for a brand-new
      // provisioning attempt — this only makes sense if the old entry is
      // truly gone, not still routing to firstClient.
      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_a',
      });
      send(secondClient, request);
      await nextMessage(node);

      const secondProgress: ProvisionProgress = {
        type: 'provision_progress',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        step: 'target_identity',
        status: 'ok',
        message: 'fresh attempt',
      };
      send(node, secondProgress);
      const receivedBySecond = (await nextMessage(secondClient)) as unknown as ProvisionProgress;
      expect(receivedBySecond).toEqual(secondProgress);

      // firstClient's next frame must be the benign one we send now, never
      // the stray/second progress meant for someone else's request.
      send(firstClient, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const firstClientNext = await nextMessage(firstClient);
      expect(firstClientNext.type).toBe('session_list');
    });

    it('cleans up the routing entry on the requesting client’s disconnect: a reused requestId works for a fresh client', async () => {
      const { url, close } = await startRelay({ host: '127.0.0.1', port: 0 });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_a',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_a',
      });
      const request = makeProvisionRequest({ requestId: 'preq_disconnect' });
      send(firstClient, request);
      await nextMessage(node);

      firstClient.close();
      await waitForClose(firstClient);

      // A second client reuses the disconnected client's requestId.
      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_a',
      });
      send(secondClient, request);
      await nextMessage(node);

      const progress: ProvisionProgress = {
        type: 'provision_progress',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        step: 'mint_node_token',
        status: 'ok',
        message: 'token minted',
      };
      send(node, progress);
      const received = (await nextMessage(secondClient)) as unknown as ProvisionProgress;
      expect(received).toEqual(progress);
    });

    it('cleans up an abandoned routing entry after its TTL, freeing the requestId for reuse', async () => {
      const { url, close } = await startRelay({
        host: '127.0.0.1',
        port: 0,
        provisionRequestTtlMs: 50,
      });
      closers.push(close);

      const { socket: node } = await initConnection(url, {
        role: 'node',
        deviceId: 'node-device',
        authToken: 'acct_a',
      });
      send(node, {
        type: 'target_announce',
        protocolVersion: PROTOCOL_V1,
        nodeId: 'node_1',
        targets: [],
      } satisfies TargetAnnounce);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { socket: firstClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'first-client-device',
        authToken: 'acct_a',
      });
      const request = makeProvisionRequest({ requestId: 'preq_ttl' });
      send(firstClient, request);
      await nextMessage(node);

      // Never send a result — simulate an abandoned/crashed run and let it
      // expire on its own.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const { socket: secondClient } = await initConnection(url, {
        role: 'client',
        deviceId: 'second-client-device',
        authToken: 'acct_a',
      });
      send(secondClient, request);
      await nextMessage(node);

      const progress: ProvisionProgress = {
        type: 'provision_progress',
        protocolVersion: PROTOCOL_V1,
        requestId: request.requestId,
        nodeId: 'node_1',
        targetId: request.targetId,
        step: 'resident_node_install',
        status: 'ok',
        message: 'installed',
      };
      send(node, progress);
      const received = (await nextMessage(secondClient)) as unknown as ProvisionProgress;
      expect(received).toEqual(progress);

      // The expired-and-abandoned firstClient must not have received it.
      send(firstClient, { type: 'session_list_request', protocolVersion: PROTOCOL_V1 });
      const firstClientNext = await nextMessage(firstClient);
      expect(firstClientNext.type).toBe('session_list');
    });
  });
});
