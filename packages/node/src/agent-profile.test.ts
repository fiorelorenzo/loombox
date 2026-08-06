import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@loombox/providers-core';
import {
  evaluateAgentProfile,
  filterMcpServersForProfile,
  type AgentProfile,
} from './agent-profile';

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'prof_1',
    name: 'Ask First',
    deniedToolKinds: [],
    deniedToolNamePatterns: [],
    deniedMcpServers: [],
    ...overrides,
  };
}

describe('evaluateAgentProfile', () => {
  it('returns undefined (no restriction) when no profile is active', () => {
    expect(evaluateAgentProfile(undefined, { toolKind: 'execute', title: 'Bash' })).toBeUndefined();
  });

  it('returns undefined for a freshly created (all-empty) profile — denies nothing', () => {
    expect(
      evaluateAgentProfile(makeProfile(), { toolKind: 'execute', title: 'Bash' }),
    ).toBeUndefined();
  });

  it('denies a tool call whose toolKind is in deniedToolKinds', () => {
    const profile = makeProfile({ deniedToolKinds: ['execute'] });
    expect(evaluateAgentProfile(profile, { toolKind: 'execute', title: 'Bash' })).toEqual({
      matchedBy: 'tool-kind',
      toolKind: 'execute',
    });
  });

  it('lets a different kind through untouched', () => {
    const profile = makeProfile({ deniedToolKinds: ['execute'] });
    expect(evaluateAgentProfile(profile, { toolKind: 'read', title: 'Read file' })).toBeUndefined();
  });

  it('a tool call with no toolKind at all can never match a kind rule — no guessed promotion to "other"', () => {
    const profile = makeProfile({ deniedToolKinds: ['other'] });
    expect(evaluateAgentProfile(profile, { title: 'Mystery tool' })).toBeUndefined();
  });

  it('denies a tool call whose title matches a name pattern', () => {
    const profile = makeProfile({ deniedToolNamePatterns: ['Bash'] });
    expect(evaluateAgentProfile(profile, { toolKind: 'execute', title: 'Bash' })).toEqual({
      matchedBy: 'tool-name',
      rule: 'Bash',
      matched: 'Bash',
    });
  });

  it('name pattern supports the anchored `*`/`?` glob language, e.g. an MCP server title prefix', () => {
    const profile = makeProfile({ deniedToolNamePatterns: ['mcp__github__*'] });
    expect(
      evaluateAgentProfile(profile, { toolKind: 'other', title: 'mcp__github__create_issue' }),
    ).toEqual({
      matchedBy: 'tool-name',
      rule: 'mcp__github__*',
      matched: 'mcp__github__create_issue',
    });
  });

  it("a name pattern that never matches this agent's actual titles degrades quietly — no error, just no match", () => {
    const profile = makeProfile({ deniedToolNamePatterns: ['ThisToolDoesNotExist'] });
    expect(evaluateAgentProfile(profile, { toolKind: 'execute', title: 'Bash' })).toBeUndefined();
  });

  it('a denied kind this agent never sends also degrades quietly — no error', () => {
    const profile = makeProfile({ deniedToolKinds: ['delete', 'move'] });
    expect(evaluateAgentProfile(profile, { toolKind: 'execute', title: 'Bash' })).toBeUndefined();
  });

  it('kind rule wins even when a name pattern would also have matched — checked first, short-circuits', () => {
    const profile = makeProfile({
      deniedToolKinds: ['execute'],
      deniedToolNamePatterns: ['Bash'],
    });
    expect(evaluateAgentProfile(profile, { toolKind: 'execute', title: 'Bash' })).toEqual({
      matchedBy: 'tool-kind',
      toolKind: 'execute',
    });
  });

  it('a tool call with no title at all can never match a name rule', () => {
    const profile = makeProfile({ deniedToolNamePatterns: ['*'] });
    expect(evaluateAgentProfile(profile, { toolKind: 'read' })).toBeUndefined();
  });
});

describe('filterMcpServersForProfile', () => {
  const filesystem: McpServerConfig = {
    name: 'filesystem',
    transport: 'stdio',
    command: 'mcp-fs',
    args: [],
    env: [],
  };
  const github: McpServerConfig = {
    name: 'github',
    transport: 'stdio',
    command: 'mcp-gh',
    args: [],
    env: [],
  };

  it('passes every server through unchanged when no profile is active', () => {
    expect(filterMcpServersForProfile([filesystem, github], undefined)).toEqual([
      filesystem,
      github,
    ]);
  });

  it('passes every server through unchanged for a profile with no denied servers', () => {
    expect(filterMcpServersForProfile([filesystem, github], makeProfile())).toEqual([
      filesystem,
      github,
    ]);
  });

  it('drops exactly the servers named in deniedMcpServers, by exact name match', () => {
    const profile = makeProfile({ deniedMcpServers: ['github'] });
    expect(filterMcpServersForProfile([filesystem, github], profile)).toEqual([filesystem]);
  });

  it('a denied server name this account has nothing configured under degrades quietly', () => {
    const profile = makeProfile({ deniedMcpServers: ['no-such-server'] });
    expect(filterMcpServersForProfile([filesystem, github], profile)).toEqual([filesystem, github]);
  });
});
