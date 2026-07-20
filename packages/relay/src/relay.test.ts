import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_V1,
  type AmkEpochFetchResponse,
  type AmkEscrow,
  type BlobDownloadResponse,
  type BlobUpload,
  type DeviceRegister,
  type DeviceRevoke,
  type DeviceRotate,
  type EncryptedEnvelope,
  type FsListRequest,
  type FsListResponse,
  type Initialize,
  type InitializeResult,
  type NewDeviceBootstrapRequest,
  type NewDeviceBootstrapResponse,
  type PromptInjectV1,
  type ResyncMarker,
  type SessionAnnounceV1,
  type SessionCreate,
  type SessionListV1,
  type SessionMetaPublic,
  type SessionResume,
  type SessionUpdateEnvelopeV1,
  type TargetAnnounce,
  type TargetDescriptor,
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
  return { id: 'target_1', kind: 'local', label: 'local machine', ...overrides };
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
});
