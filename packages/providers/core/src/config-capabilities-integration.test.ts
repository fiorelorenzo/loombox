import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';
import type { ConfigOptionChangeEvent } from './config-options';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'config-acp-agent.mjs',
);

let activeClient: AcpClient | undefined;

function makeClient(): AcpClient {
  const client = new AcpClient({ command: process.execPath, args: [FIXTURE_PATH] });
  activeClient = client;
  return client;
}

afterEach(() => {
  activeClient?.close();
  activeClient = undefined;
});

describe('AcpClient: capability flags from a real initialize handshake (issue #180)', () => {
  it('derives the full feature-flag set from the agent-advertised capabilities', async () => {
    const client = makeClient();
    await client.initialize();

    expect(client.getFeatureFlags()).toEqual({
      supportsImages: true,
      supportsAudio: false,
      supportsEmbeddedContext: true,
      supportsResume: true,
      supportsMcpServerPicker: true,
      supportsAdditionalDirectories: false,
      supportsSessionDelete: true,
      supportsPermissions: false,
      supportsPlans: true,
    });
  });
});

describe('AcpClient: config-option state from a real initialize + session/set_config_option (issue #179)', () => {
  it('seeds a new session from the initialize config-option catalog', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    expect(client.configOptions.get(sessionId)).toEqual([
      {
        category: 'model',
        current: 'sonnet',
        choices: [
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'haiku', name: 'Haiku' },
        ],
      },
      {
        category: 'mode',
        current: 'default',
        choices: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    ]);
  });

  it('round-trips a user-driven change through session/set_config_option, re-deriving the full list wholesale', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const events: ConfigOptionChangeEvent[] = [];
    client.configOptions.on('changed', (event: ConfigOptionChangeEvent) => events.push(event));

    const options = await client.setConfigOption(sessionId, 'model', 'haiku');

    expect(options.find((o) => o.category === 'model')?.current).toBe('haiku');
    // The 'mode' category, untouched by this change, is still present: a
    // wholesale re-derivation, not a lost sibling.
    expect(options.find((o) => o.category === 'mode')).toBeDefined();
    expect(client.configOptions.get(sessionId)).toEqual(options);

    const seededEvent = events[0]!;
    expect(seededEvent.unprompted).toBe(false); // newSession's own seed
    const ackEvent = events.at(-1)!;
    expect(ackEvent.unprompted).toBe(false); // a user-driven ack, not a surprise
  });

  it('flags an unprompted config_option_update (e.g. an automatic fallback) separately from a user ack', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const events: ConfigOptionChangeEvent[] = [];
    client.configOptions.on('changed', (event: ConfigOptionChangeEvent) => events.push(event));

    await client.prompt(sessionId, 'trigger-fallback');

    const unprompted = events.find((event) => event.unprompted);
    expect(unprompted).toBeDefined();
    expect(unprompted?.options.find((o) => o.category === 'model')?.current).toBe('haiku');
    expect(client.configOptions.current(sessionId, 'model')).toBe('haiku');
  });
});
