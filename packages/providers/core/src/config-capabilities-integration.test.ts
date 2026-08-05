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

describe('AcpClient: config-option state from a real session/new + session/set_config_option (issue #179/#705/#707)', () => {
  it("seeds a new session from session/new's wire-shaped config-option catalog, folding `modes` into the `mode` category rather than duplicating it (issue #705), and retaining each entry's wire id/type for a later set_config_option request (issue #707)", async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const options = client.configOptions.get(sessionId);
    expect(options).toEqual([
      {
        category: 'mode',
        current: 'default',
        id: 'mode',
        type: 'select',
        choices: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      {
        category: 'model',
        current: 'anthropic/claude-sonnet-5',
        id: 'model',
        type: 'select',
        choices: [
          { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' },
          { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ],
      },
      {
        // The wire entry's own id is "thinking", its category is
        // "thought_level" — the exact divergence issue #707 needs a
        // caller of setConfigOption to never have to reason about: the
        // catalogue keeps both.
        category: 'thought_level',
        current: 'auto',
        id: 'thinking',
        type: 'select',
        choices: [
          { id: 'off', name: 'Off' },
          { id: 'auto', name: 'Auto' },
        ],
      },
      {
        category: 'reasoning_style_v3',
        current: 'balanced',
        id: 'reasoning_style_v3',
        type: 'select',
        choices: [
          { id: 'balanced', name: 'Balanced' },
          { id: 'aggressive', name: 'Aggressive' },
        ],
      },
    ]);
    // Exactly one 'mode' entry: the fixture's session/new sends both a
    // configOptions 'mode' category AND a modes object (mirroring a real
    // omp acp response) — a second, modes-derived entry would mean
    // ConfigBar renders two mode pickers for one selection.
    expect(options.filter((option) => option.category === 'mode')).toHaveLength(1);
  });

  it("round-trips a user-driven change through session/set_config_option, sourcing configId from the category's own wire id ('thinking'), not the category string itself ('thought_level') — the real omp acp binary rejects the category as configId outright (issue #707)", async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const events: ConfigOptionChangeEvent[] = [];
    client.configOptions.on('changed', (event: ConfigOptionChangeEvent) => events.push(event));

    const options = await client.setConfigOption(sessionId, 'thought_level', 'off');

    expect(options.find((o) => o.category === 'thought_level')?.current).toBe('off');
    // Every other category, untouched by this change, is still present: a
    // wholesale re-derivation off the response's real `configOptions`
    // field, not a lost sibling.
    expect(options.find((o) => o.category === 'mode')).toBeDefined();
    expect(options.find((o) => o.category === 'model')).toBeDefined();
    expect(client.configOptions.get(sessionId)).toEqual(options);

    const seededEvent = events[0]!;
    expect(seededEvent.unprompted).toBe(false); // newSession's own seed
    const ackEvent = events.at(-1)!;
    expect(ackEvent.unprompted).toBe(false); // a user-driven ack, not a surprise
  });

  it('sets an option in a category this client has never hardcoded a name for, unmodified — the unrecognized-category passthrough guarantee (issue #179) holds through a real set_config_option round trip, not just the read side', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    const options = await client.setConfigOption(sessionId, 'reasoning_style_v3', 'aggressive');

    expect(options.find((o) => o.category === 'reasoning_style_v3')?.current).toBe('aggressive');
  });

  it('a rejected session/set_config_option is visible, not silent: the real binary answers an unsupported value with a JSON-RPC error, and this client rejects rather than swallowing it (issue #707)', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    await expect(
      client.setConfigOption(sessionId, 'thought_level', 'not-a-real-thinking-level'),
    ).rejects.toThrow(/Unsupported value/);

    // Rejected, not silently applied: the catalogue still shows the
    // pre-attempt value.
    expect(client.configOptions.current(sessionId, 'thought_level')).toBe('auto');
  });

  it('throws before sending a request for a category the session catalogue never advertised, rather than guessing a configId/type from the caller-supplied category', async () => {
    const client = makeClient();
    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-config-test');

    await expect(client.setConfigOption(sessionId, 'not_a_real_category', 'x')).rejects.toThrow(
      /no catalogue entry for category "not_a_real_category"/,
    );
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
