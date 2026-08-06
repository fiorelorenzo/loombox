import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  McpPromptClientError,
  fetchMcpPromptText,
  fetchMcpServerPrompts,
} from './mcp-prompt-client';
import type { AcpMcpServerConfig } from './types';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'mcp-prompt-fixture-server.mjs',
);

function stdioServer(name: string, env: Record<string, string> = {}): AcpMcpServerConfig {
  return {
    name,
    command: process.execPath,
    args: [FIXTURE_PATH],
    env: Object.entries(env).map(([varName, value]) => ({ name: varName, value })),
  };
}

const UNREACHABLE_SERVER: AcpMcpServerConfig = {
  name: 'unreachable',
  command: 'this-binary-does-not-exist-anywhere',
  args: [],
};

describe('fetchMcpServerPrompts (issue #754, D5-2)', () => {
  it("reads a stdio server's declared prompts, name/description/arguments verbatim", async () => {
    const results = await fetchMcpServerPrompts([stdioServer('fixture-a')]);
    expect(results).toEqual([
      {
        name: 'fixture-a',
        prompts: [
          { name: 'greet', description: 'A static greeting, no arguments', arguments: undefined },
          {
            name: 'translate',
            description: 'Translate text into another tone/language',
            arguments: [
              { name: 'text', description: 'The text to translate', required: true },
              { name: 'tone', description: 'Optional target tone', required: false },
            ],
          },
        ],
      },
    ]);
  });

  it('a server with no prompts contributes nothing to the list (not an empty entry)', async () => {
    const results = await fetchMcpServerPrompts([
      stdioServer('fixture-empty', { MCP_FIXTURE_NO_PROMPTS: '1' }),
    ]);
    expect(results).toEqual([]);
  });

  it('an unreachable server does not break the list for the others — same call, mixed outcomes', async () => {
    const results = await fetchMcpServerPrompts([
      stdioServer('fixture-a'),
      UNREACHABLE_SERVER,
      stdioServer('fixture-empty', { MCP_FIXTURE_NO_PROMPTS: '1' }),
    ]);
    expect(results.map((r) => r.name)).toEqual(['fixture-a']);
  });

  it('an unreachable server alone yields an empty list, never a thrown error', async () => {
    await expect(fetchMcpServerPrompts([UNREACHABLE_SERVER])).resolves.toEqual([]);
  });

  it('two servers with different prompt catalogues are queried independently, never cross-contaminating', async () => {
    const results = await fetchMcpServerPrompts([stdioServer('a'), stdioServer('b')]);
    expect(results.map((r) => r.name).sort()).toEqual(['a', 'b']);
    expect(results.find((r) => r.name === 'a')!.prompts).toEqual(
      results.find((r) => r.name === 'b')!.prompts,
    );
  });
});

describe('fetchMcpPromptText (issue #754, D5-2)', () => {
  it('renders a zero-argument prompt', async () => {
    const text = await fetchMcpPromptText(stdioServer('fixture-a'), 'greet', {});
    expect(text).toBe('Hello there!');
  });

  it('renders a prompt with a required argument supplied', async () => {
    const text = await fetchMcpPromptText(stdioServer('fixture-a'), 'translate', {
      text: 'bonjour',
    });
    expect(text).toBe('Translate "bonjour".');
  });

  it('renders a prompt with both a required and an optional argument supplied', async () => {
    const text = await fetchMcpPromptText(stdioServer('fixture-a'), 'translate', {
      text: 'bonjour',
      tone: 'formal',
    });
    expect(text).toBe('Translate "bonjour" in a formal tone.');
  });

  it("rejects with McpPromptClientError when a required argument is missing — the server's own rejection, not a client-side guess", async () => {
    await expect(fetchMcpPromptText(stdioServer('fixture-a'), 'translate', {})).rejects.toThrow(
      McpPromptClientError,
    );
    await expect(fetchMcpPromptText(stdioServer('fixture-a'), 'translate', {})).rejects.toThrow(
      /missing required argument "text"/,
    );
  });

  it('rejects with McpPromptClientError, naming the server, for an unreachable server', async () => {
    await expect(fetchMcpPromptText(UNREACHABLE_SERVER, 'greet', {})).rejects.toMatchObject({
      serverName: 'unreachable',
    });
  });

  it('rejects for an unknown prompt name', async () => {
    await expect(
      fetchMcpPromptText(stdioServer('fixture-a'), 'does-not-exist', {}),
    ).rejects.toThrow(McpPromptClientError);
  });
});

/**
 * Real-server verification (issue #754's own acceptance line: "verified
 * against a real MCP server, not only a fixture") — `@modelcontextprotocol/
 * server-everything`, the official MCP reference/conformance server, whose
 * own `simple-prompt`/`args-prompt` are exactly the zero-argument/
 * required+optional-argument shapes the fixture above stands in for.
 * `npx`-fetched, so this is gated on the package actually being reachable
 * (mirrors this codebase's own `dockerAvailable`/`ompOnPath` `skipIf`
 * convention for a real dependency this devbox has but CI might not) —
 * skipped rather than failing CI red when it isn't.
 *
 * `stdio` only, deliberately: the `streamableHttp` transport was also
 * hand-verified against this same real server (raw `fetch` probes
 * recorded in this issue's own PR — `initialize`'s `Mcp-Session-Id`
 * response header carried forward, every POST answered as one SSE `data:`
 * line, `httpSession`'s exact behavior) and worked, but an automated
 * `npx … streamableHttp` server spun up per test run introduced a real,
 * reproducible flake under this package's own full-suite parallel load
 * (an intermittent `fetch failed` a bounded active-readiness poll did not
 * fully close) — the same class of environment-dependent flake this
 * project already excludes from CI elsewhere (`policy-enforced-pty.test.ts`
 * #793), so it stays a documented manual verification rather than a
 * committed test that would turn CI red on this box's own noise.
 */
const everythingServerAvailable = (() => {
  const result = spawnSync('npx', ['-y', '@modelcontextprotocol/server-everything', 'stdio'], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.1' } } })}\n`,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return result.status === 0 || result.stdout.includes('"protocolVersion"');
})();

describe.skipIf(!everythingServerAvailable)(
  'real-server verification: @modelcontextprotocol/server-everything (issue #754 acceptance)',
  () => {
    const stdioEverything: AcpMcpServerConfig = {
      name: 'everything',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything', 'stdio'],
    };

    it("reads the real server's own declared prompt catalogue over stdio, including its two-argument args-prompt", async () => {
      const results = await fetchMcpServerPrompts([stdioEverything], { timeoutMs: 30_000 });
      expect(results).toHaveLength(1);
      const names = results[0]!.prompts.map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(['simple-prompt', 'args-prompt', 'completable-prompt']),
      );
      const argsPrompt = results[0]!.prompts.find((p) => p.name === 'args-prompt')!;
      expect(argsPrompt.arguments).toEqual([
        { name: 'city', description: 'Name of the city', required: true },
        { name: 'state', description: undefined, required: false },
      ]);
    });

    it("renders the real server's simple-prompt (no arguments) over stdio", async () => {
      const text = await fetchMcpPromptText(
        stdioEverything,
        'simple-prompt',
        {},
        {
          timeoutMs: 30_000,
        },
      );
      expect(text).toBe('This is a simple prompt without arguments.');
    });

    it('renders args-prompt with its required argument, and rejects when it is missing, over stdio', async () => {
      const text = await fetchMcpPromptText(
        stdioEverything,
        'args-prompt',
        { city: 'Berlin' },
        { timeoutMs: 30_000 },
      );
      expect(text).toContain('Berlin');

      await expect(
        fetchMcpPromptText(stdioEverything, 'args-prompt', {}, { timeoutMs: 30_000 }),
      ).rejects.toThrow(McpPromptClientError);
    });
  },
);
