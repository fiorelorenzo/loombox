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

describe('AcpClient: config-option state from a real session/new + session/set_config_option (issue #179/#705)', () => {
  it("seeds a new session from session/new's wire-shaped config-option catalog, folding `modes` into the `mode` category rather than duplicating it (issue #705)", async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const options = client.configOptions.get(sessionId);
    expect(options).toEqual([
      {
        category: 'mode',
        current: 'default',
        choices: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      {
        category: 'model',
        current: 'anthropic/claude-sonnet-5',
        choices: [
          { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
          { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ],
      },
      {
        category: 'thought_level',
        current: 'auto',
        choices: [
          { id: 'off', name: 'Off' },
          { id: 'auto', name: 'Auto' },
        ],
      },
    ]);
    // Exactly one 'mode' entry: the fixture's session/new sends both a
    // configOptions 'mode' category AND a modes object (mirroring a real
    // omp acp response) — a second, modes-derived entry would mean
    // ConfigBar renders two mode pickers for one selection.
    expect(options.filter((option) => option.category === 'mode')).toHaveLength(1);
  });

  it('round-trips a user-driven change through session/set_config_option, re-deriving the full list wholesale', async () => {
    // session/set_config_option's own request/response wire shape is a
    // separate, still-open bug (see the fixture's header comment and the
    // follow-up issue) — this exercises the client's current behavior
    // against that endpoint, unaffected by #705's session/new/
    // config_option_update fix above.
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

  it('flags an unprompted config_option_update (e.g. an automatic fallback) separately from a user ack, wire-mapped the same way session/new is (issue #705)', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const events: ConfigOptionChangeEvent[] = [];
    client.configOptions.on('changed', (event: ConfigOptionChangeEvent) => events.push(event));

    await client.prompt(sessionId, 'trigger-fallback');

    const unprompted = events.find((event) => event.unprompted);
    expect(unprompted).toBeDefined();
    expect(unprompted?.options.find((o) => o.category === 'model')?.current).toBe(
      'anthropic/claude-haiku-4-5',
    );
    expect(client.configOptions.current(sessionId, 'model')).toBe('anthropic/claude-haiku-4-5');
  });
});
