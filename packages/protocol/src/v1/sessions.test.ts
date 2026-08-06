import { describe, expect, it } from 'vitest';
import {
  parseSessionPrivateMetaV1,
  safeParseSessionPrivateMetaV1,
  sessionAnnounceV1,
  sessionCreate,
  sessionListRequest,
  sessionListV1,
  sessionMetaPublic,
  sessionResume,
  sessionWithPrivateEnvelope,
} from './sessions';

const validPrivateEnvelope = {
  resourceId: 'session:sess-1',
  iv: 'aGVsbG8=',
  ciphertext: 'YWJjZA==',
  alg: 'AES-256-GCM' as const,
};

const validMetaPublic = {
  id: 'sess-1',
  nodeId: 'node-1',
  targetId: 'local',
  accountId: 'acct-1',
  provider: 'claude',
  createdAt: Date.now(),
};

describe('sessionMetaPublic', () => {
  it('parses valid public session metadata', () => {
    expect(sessionMetaPublic.parse(validMetaPublic)).toEqual(validMetaPublic);
  });

  it('accepts an optional seq', () => {
    expect(sessionMetaPublic.parse({ ...validMetaPublic, seq: 42 }).seq).toBe(42);
  });

  it('rejects a missing accountId', () => {
    const { accountId: _accountId, ...rest } = validMetaPublic;
    expect(() => sessionMetaPublic.parse(rest)).toThrow();
  });

  // The metadata-boundary invariant (SPEC §8's bridge bullet, docs/v1-plan.md):
  // the relay-indexable public schema must never carry the private fields.
  it('has no title or projectPath keys, even when the input smuggles them', () => {
    const withSmuggledFields = {
      ...validMetaPublic,
      title: 'secret title',
      projectPath: '/etc/passwd',
    };
    const parsed = sessionMetaPublic.parse(withSmuggledFields);
    expect(parsed).not.toHaveProperty('title');
    expect(parsed).not.toHaveProperty('projectPath');
    expect(Object.keys(parsed).sort()).toEqual(
      ['accountId', 'createdAt', 'id', 'nodeId', 'provider', 'targetId'].sort(),
    );
  });

  it('the schema shape itself declares no title/projectPath field', () => {
    const shapeKeys = Object.keys(sessionMetaPublic.shape);
    expect(shapeKeys).not.toContain('title');
    expect(shapeKeys).not.toContain('projectPath');
  });
});

describe('sessionWithPrivateEnvelope', () => {
  it('parses public meta plus its paired private envelope', () => {
    const valid = { session: validMetaPublic, privateEnvelope: validPrivateEnvelope };
    expect(sessionWithPrivateEnvelope.parse(valid)).toEqual(valid);
  });
});

describe('sessionCreate', () => {
  const valid = {
    type: 'session_create',
    protocolVersion: 1,
    sessionId: 'sess-1',
    targetId: 'local',
    provider: 'claude',
    privateEnvelope: validPrivateEnvelope,
  };

  it('parses a valid sessionCreate', () => {
    expect(sessionCreate.parse(valid)).toEqual(valid);
  });

  it('rejects a malformed privateEnvelope', () => {
    expect(() =>
      sessionCreate.parse({ ...valid, privateEnvelope: { ...validPrivateEnvelope, iv: 'x' } }),
    ).toThrow();
  });
});

describe('sessionAnnounceV1', () => {
  const valid = {
    type: 'session_announce',
    protocolVersion: 1,
    session: validMetaPublic,
    privateEnvelope: validPrivateEnvelope,
  };

  it('parses a valid sessionAnnounceV1', () => {
    expect(sessionAnnounceV1.parse(valid)).toEqual(valid);
  });

  it('rejects a malformed session', () => {
    const { id: _id, ...brokenSession } = validMetaPublic;
    expect(() => sessionAnnounceV1.parse({ ...valid, session: brokenSession })).toThrow();
  });
});

describe('sessionResume', () => {
  it('parses a valid sessionResume', () => {
    const valid = { type: 'session_resume', protocolVersion: 1, sessionId: 'sess-1' };
    expect(sessionResume.parse(valid)).toEqual(valid);
  });

  it('rejects a missing sessionId', () => {
    expect(() => sessionResume.parse({ type: 'session_resume', protocolVersion: 1 })).toThrow();
  });
});

describe('sessionListRequest', () => {
  it('parses a valid sessionListRequest', () => {
    const valid = { type: 'session_list_request', protocolVersion: 1 };
    expect(sessionListRequest.parse(valid)).toEqual(valid);
  });
});

describe('sessionListV1', () => {
  const valid = {
    type: 'session_list',
    protocolVersion: 1,
    sessions: [{ session: validMetaPublic, privateEnvelope: validPrivateEnvelope }],
  };

  it('parses a valid sessionListV1 with public meta + private envelope per session', () => {
    expect(sessionListV1.parse(valid)).toEqual(valid);
  });

  it('accepts an empty sessions array', () => {
    expect(sessionListV1.parse({ ...valid, sessions: [] }).sessions).toEqual([]);
  });

  it('never carries title/projectPath in the public part of any session entry', () => {
    const parsed = sessionListV1.parse(valid);
    for (const entry of parsed.sessions) {
      expect(entry.session).not.toHaveProperty('title');
      expect(entry.session).not.toHaveProperty('projectPath');
    }
  });
});

describe('sessionPrivateMetaV1', () => {
  it('accepts the shape both ends have always sent, with no worktree field', () => {
    const parsed = parseSessionPrivateMetaV1({ title: 'Refactor', projectPath: '/srv/app' });
    expect(parsed).toEqual({ title: 'Refactor', projectPath: '/srv/app' });
    expect(parsed.worktree).toBeUndefined();
  });

  it('carries SPEC 7.1s per-session worktree choice in both directions', () => {
    expect(
      parseSessionPrivateMetaV1({ title: 't', projectPath: '/p', worktree: true }).worktree,
    ).toBe(true);
    expect(
      parseSessionPrivateMetaV1({ title: 't', projectPath: '/p', worktree: false }).worktree,
    ).toBe(false);
  });

  it('rejects a non-boolean worktree rather than coercing it', () => {
    expect(
      safeParseSessionPrivateMetaV1({ title: 't', projectPath: '/p', worktree: 'yes' }).success,
    ).toBe(false);
  });

  it('still requires the two fields the relay boundary has always guaranteed', () => {
    expect(safeParseSessionPrivateMetaV1({ projectPath: '/p' }).success).toBe(false);
    expect(safeParseSessionPrivateMetaV1({ title: 't' }).success).toBe(false);
  });

  it('omitting mcpServerConfigs behaves like an older client that predates it (issue #750)', () => {
    const parsed = parseSessionPrivateMetaV1({ title: 't', projectPath: '/p' });
    expect(parsed.mcpServerConfigs).toBeUndefined();
  });

  it('carries a client-declared stdio server, secret-reference var and all, never a secret value', () => {
    const parsed = parseSessionPrivateMetaV1({
      title: 't',
      projectPath: '/p',
      mcpServerConfigs: [
        {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
        },
      ],
    });
    expect(parsed.mcpServerConfigs).toEqual([
      {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: [{ name: 'GITHUB_TOKEN', secret: 'github-token' }],
      },
    ]);
  });

  it('rejects a var decl carrying both a literal value and a secret name', () => {
    expect(
      safeParseSessionPrivateMetaV1({
        title: 't',
        projectPath: '/p',
        mcpServerConfigs: [
          {
            name: 'x',
            transport: 'stdio',
            command: 'x',
            args: [],
            env: [{ name: 'A', value: 'literal', secret: 'also-a-secret' }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('carries the fork boundary turn id (issue #746), and leaves it undefined on an ordinary create', () => {
    expect(
      parseSessionPrivateMetaV1({ title: 't', projectPath: '/p' }).forkFromTurnId,
    ).toBeUndefined();
    expect(
      parseSessionPrivateMetaV1({ title: 't', projectPath: '/p', forkFromTurnId: 'turn_5' })
        .forkFromTurnId,
    ).toBe('turn_5');
  });

  it('rejects an empty forkFromTurnId rather than accepting a meaningless boundary', () => {
    expect(
      safeParseSessionPrivateMetaV1({ title: 't', projectPath: '/p', forkFromTurnId: '' }).success,
    ).toBe(false);
  });

  it('carries the node-computed branch (issue #738), and leaves it undefined on a client-sent create with no opinion', () => {
    expect(parseSessionPrivateMetaV1({ title: 't', projectPath: '/p' }).branch).toBeUndefined();
    expect(
      parseSessionPrivateMetaV1({ title: 't', projectPath: '/p', branch: 'main' }).branch,
    ).toBe('main');
  });

  it('rejects an empty branch rather than accepting a meaningless value', () => {
    expect(
      safeParseSessionPrivateMetaV1({ title: 't', projectPath: '/p', branch: '' }).success,
    ).toBe(false);
  });
});
