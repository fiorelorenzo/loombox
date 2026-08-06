import { describe, expect, it } from 'vitest';
import {
  mcpServerVarDeclV1,
  parseMcpServerConfigV1,
  safeParseMcpServerConfigV1,
} from './mcp-servers';

describe('mcpServerVarDeclV1', () => {
  it('accepts a literal value', () => {
    expect(mcpServerVarDeclV1.parse({ name: 'A', value: 'x' })).toEqual({ name: 'A', value: 'x' });
  });

  it('accepts a secret reference', () => {
    expect(mcpServerVarDeclV1.parse({ name: 'A', secret: 'github-token' })).toEqual({
      name: 'A',
      secret: 'github-token',
    });
  });

  it('rejects both a value and a secret on the same entry', () => {
    expect(
      mcpServerVarDeclV1.safeParse({ name: 'A', value: 'x', secret: 'github-token' }).success,
    ).toBe(false);
  });

  it('rejects neither a value nor a secret', () => {
    expect(mcpServerVarDeclV1.safeParse({ name: 'A' }).success).toBe(false);
  });
});

describe('mcpServerConfigV1', () => {
  it('parses a stdio server config', () => {
    const config = {
      name: 'filesystem',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: [],
    };
    expect(parseMcpServerConfigV1(config)).toEqual(config);
  });

  it('parses an http server config with a header secret reference', () => {
    const config = {
      name: 'tracker',
      transport: 'http' as const,
      url: 'https://tracker.example/mcp',
      headers: [{ name: 'Authorization', secret: 'tracker-token' }],
    };
    expect(parseMcpServerConfigV1(config)).toEqual(config);
  });

  it('parses an sse server config', () => {
    const config = {
      name: 'events',
      transport: 'sse' as const,
      url: 'https://events.example/mcp',
      headers: [],
    };
    expect(parseMcpServerConfigV1(config)).toEqual(config);
  });

  it('rejects an unknown transport', () => {
    expect(
      safeParseMcpServerConfigV1({ name: 'x', transport: 'websocket', url: 'wss://x' }).success,
    ).toBe(false);
  });

  it('rejects a stdio config missing command', () => {
    expect(
      safeParseMcpServerConfigV1({ name: 'x', transport: 'stdio', args: [], env: [] }).success,
    ).toBe(false);
  });
});
