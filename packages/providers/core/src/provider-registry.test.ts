import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient } from './client';
import { ProviderRegistry, RESERVED_PROVIDER_IDS } from './provider-registry';
import type { AcpProviderModule } from './provider-registry';
import type { AcpTranscriptUpdate } from './types';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

let activeClient: AcpClient | undefined;

afterEach(() => {
  activeClient?.close();
  activeClient = undefined;
});

describe('ProviderRegistry: register/lookup', () => {
  it('looks up a registered module by its provider id', () => {
    const registry = new ProviderRegistry();
    const stub: AcpProviderModule = { id: 'stub', spawnConfig: () => ({ command: 'x', args: [] }) };

    expect(registry.lookup('stub')).toBeUndefined();
    registry.register(stub);
    expect(registry.lookup('stub')).toBe(stub);
  });

  it('replaces a module registered under an id it already holds', () => {
    const registry = new ProviderRegistry();
    const first: AcpProviderModule = { id: 'dup', spawnConfig: () => ({ command: 'a', args: [] }) };
    const second: AcpProviderModule = {
      id: 'dup',
      spawnConfig: () => ({ command: 'b', args: [] }),
    };

    registry.register(first);
    registry.register(second);

    expect(registry.lookup('dup')).toBe(second);
  });

  it('reserves the "gemini" id (unregistered by default) so a future module needs no core API change', () => {
    const registry = new ProviderRegistry();
    expect(RESERVED_PROVIDER_IDS).toContain('gemini');
    expect(registry.lookup('gemini')).toBeUndefined();

    // Registering under the reserved id works with the same plain API as any other.
    registry.register({ id: 'gemini', spawnConfig: () => ({ command: 'gemini-acp', args: [] }) });
    expect(registry.lookup('gemini')?.id).toBe('gemini');
  });
});

describe('ProviderRegistry: enrich', () => {
  const sampleUpdate: AcpTranscriptUpdate = {
    kind: 'agent_message_chunk',
    turnId: 't1',
    messageId: 'm1',
    text: 'hi',
  };

  it('invokes the module enrich hook for every incoming update when one is supplied', () => {
    const registry = new ProviderRegistry();
    const calls: Array<{ update: AcpTranscriptUpdate; raw: unknown }> = [];
    registry.register({
      id: 'with-enrich',
      spawnConfig: () => ({ command: 'x', args: [] }),
      enrich(update, raw) {
        calls.push({ update, raw });
        return { ...update, text: `${update.kind === 'agent_message_chunk' ? update.text : ''}!` };
      },
    });

    const raw = { sessionUpdate: 'agent_message_chunk', messageId: 'm1' };
    const enriched = registry.enrich('with-enrich', sampleUpdate, raw);

    expect(calls).toEqual([{ update: sampleUpdate, raw }]);
    expect(enriched).toEqual({ ...sampleUpdate, text: 'hi!' });
  });

  it('is skipped (pure pass-through) when the module supplies no enrich hook', () => {
    const registry = new ProviderRegistry();
    registry.register({ id: 'no-enrich', spawnConfig: () => ({ command: 'x', args: [] }) });

    const enriched = registry.enrich('no-enrich', sampleUpdate, { anything: true });
    expect(enriched).toBe(sampleUpdate);
  });

  it('is a pass-through for an id with no module registered at all', () => {
    const registry = new ProviderRegistry();
    expect(registry.enrich('nobody-registered', sampleUpdate, {})).toBe(sampleUpdate);
  });
});

describe('ProviderRegistry: generic-tier fallback session', () => {
  it('a stub module supplying neither enrich nor UI wiring still lets a session run fully through the generic tier', async () => {
    const registry = new ProviderRegistry();
    const stub: AcpProviderModule = {
      id: 'stub-generic',
      // Deliberately ignores opts.cwd for the spawn itself (matching
      // client.test.ts's pattern): the fixture agent doesn't need a real
      // cwd to run, only session/new's cwd argument does.
      spawnConfig: () => ({ command: process.execPath, args: [FIXTURE_PATH] }),
    };
    registry.register(stub);

    const module = registry.lookup('stub-generic');
    expect(module).toBeDefined();

    const spawnConfig = module!.spawnConfig({ cwd: '/tmp/loombox-registry-test' });
    const client = new AcpClient(spawnConfig);
    activeClient = client;

    const updates: unknown[] = [];
    let turnEnded = false;
    client.on('update', (update: unknown) =>
      updates.push(registry.enrich(module!.id, update as AcpTranscriptUpdate, update)),
    );
    client.on('turn_end', () => {
      turnEnded = true;
    });

    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-registry-test');
    await client.prompt(sessionId, 'hi there');

    expect(turnEnded).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe('ProviderRegistry: live wiring into AcpClient (issue #181)', () => {
  it('runs a module enrich hook over every v1 transcript_update, while leaving the legacy v0 update event untouched', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'shout',
      spawnConfig: () => ({ command: process.execPath, args: [FIXTURE_PATH] }),
      enrich(update) {
        return update.kind === 'agent_message_chunk'
          ? { ...update, text: update.text.toUpperCase() }
          : update;
      },
    });

    const client = new AcpClient(
      { command: process.execPath, args: [FIXTURE_PATH] },
      { registry, providerId: 'shout' },
    );
    activeClient = client;

    const v0Updates: unknown[] = [];
    client.on('update', (update: unknown) => v0Updates.push(update));

    await client.initialize();
    const sessionId = await client.newSession('/tmp/loombox-registry-enrich-test');
    await client.prompt(sessionId, 'hi there');

    // v1 pipeline: each chunk's own delta is uppercased by the registered
    // module before the reducer appends it, so the coalesced item ends up
    // fully uppercased.
    const state = client.getTranscriptState(sessionId);
    const message = state.items.find((item) => item.type === 'message');
    expect(message).toMatchObject({ text: 'HELLO WORLD' });

    // v0 pipeline: untouched pass-through, exactly as every existing consumer expects.
    expect(v0Updates.at(-1)).toMatchObject({ text: 'Hello world' });
  });
});
