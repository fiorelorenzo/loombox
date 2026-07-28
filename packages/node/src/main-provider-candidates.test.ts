import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PROVIDER_REQUIREMENTS } from '@loombox/supervisor';

/**
 * The composition root's provider wiring, mocked at the `createNode` seam.
 *
 * This exists because of a real escape: `NodeDaemon` grew a per-target provider
 * probe with full unit coverage, every one of those tests injected
 * `providerCandidates` explicitly, and `main.ts` never passed it at all. The
 * option defaults to `[]` and the probe is a documented no-op when empty, so
 * every test passed while every production target announced `providers: []` —
 * which a client correctly reads as "no agent CLI installed here" and refuses
 * to start a session on. I only found it by asking the deployed relay what the
 * real devbox node had announced.
 *
 * So this asserts the wiring itself, not the probe: that `start()` hands the
 * daemon a non-empty candidate list, and that the list is the supervisor's own
 * spawnable set rather than a duplicate maintained here.
 */
const createNode = vi.hoisted(() => vi.fn());

vi.mock('./node-daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./node-daemon')>();
  return { ...actual, createNode };
});

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'loombox-main-candidates-'));
  createNode.mockReset();
  createNode.mockImplementation(() => ({
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    sendTargetAnnounce: vi.fn(),
  }));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('main: provider candidate wiring', () => {
  it('hands the daemon the supervisor own spawnable provider set, not an empty list', async () => {
    const { start } = await import('./main');

    await start({
      env: {
        LOOMBOX_RELAY_URL: 'wss://relay.invalid/ws',
        LOOMBOX_NODE_ID: 'candidate-test-node',
        LOOMBOX_AUTH_TOKEN: 'acct-candidates',
        LOOMBOX_AMK: Buffer.alloc(32, 7).toString('base64'),
        LOOMBOX_NODE_STATE_DIR: stateDir,
      },
      argv: [],
      resolveAccountId: async (_relayUrl, authToken) => authToken,
    });

    expect(createNode).toHaveBeenCalled();
    const options = createNode.mock.calls[0]?.[0] as
      { providerCandidates?: { id: string; requiredCommand: string }[] } | undefined;

    expect(options?.providerCandidates ?? []).not.toHaveLength(0);
    // Identity with the supervisor's set is the invariant that matters: it is
    // what makes "advertised" and "spawnable" the same set by construction.
    expect(options?.providerCandidates).toEqual([...DEFAULT_PROVIDER_REQUIREMENTS]);
  });
});
