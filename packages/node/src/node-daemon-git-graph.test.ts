import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type GitGraphRequestPayloadV1,
  type GitGraphResponsePayloadV1,
} from '@loombox/protocol';
import { deriveSessionKey, openJson, sealJson } from '@loombox/crypto';

import { NodeDaemon } from './node-daemon';
import { SessionManager } from './session-manager';
import type { Session } from './session-manager';

const execFileAsync = promisify(execFile);

/**
 * Daemon-level proof for issue #231's commit-graph wire pair: routing
 * through `NodeDaemon`'s own `resolveSessionRouting`, the real encrypted
 * envelope round trip (unlike `git_diff_request`, this request carries a
 * real payload — `ref`/`limit`/`offset` — so it is enveloped like
 * `git_branch_create_request`), and the bridge method's own outcome
 * mapping — all against a REAL local git repo via
 * `SessionManager.createSession`, never a mocked `Session`/git return.
 * Harness modeled on `node-daemon-git-branch.test.ts`'s own "bare,
 * never-connected NodeDaemon" convention.
 *
 * `computeCommitGraph` itself drives git through the same
 * `ExecutionTarget.exec('git', [...])` seam `computeWorktreeDiff`/
 * `listBranches` already use — proven target-agnostic there (issues
 * #206/#234), with no dedicated `ssh:`-target daemon test of their own
 * either; this pair adds no new target-dispatch logic of its own to
 * warrant one here.
 */

const AMK = new Uint8Array(32).fill(9);
const ACCOUNT_ID = 'acct-git-graph';

let stateDir: string;
let repoDir: string;

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-graph-daemon-state-'));
  repoDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-graph-daemon-repo-'));
  await execGit(repoDir, ['init', '-q', '-b', 'main']);
  await execGit(repoDir, ['config', 'user.email', 'test@loombox.dev']);
  await execGit(repoDir, ['config', 'user.name', 'loombox test']);
  await writeFile(path.join(repoDir, 'f.txt'), 'base\n');
  await execGit(repoDir, ['add', 'f.txt']);
  await execGit(repoDir, ['commit', '-q', '-m', 'base']);
  await writeFile(path.join(repoDir, 'g.txt'), 'second\n');
  await execGit(repoDir, ['add', 'g.txt']);
  await execGit(repoDir, ['commit', '-q', '-m', 'second commit']);
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

function bareDaemon(sessionManager: SessionManager): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-git-graph',
    deviceId: 'device-git-graph',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    sessionManager,
  });
}

/** This suite's only seam into the daemon's private commit-graph wire handler and bridge method — TS `private` is compile-time only, and neither is otherwise public. `relay` is narrowed to just `send` so a test can stub it and capture what the daemon would have sent over a real connection. */
interface DaemonInternals {
  relay: { send: (message: unknown) => void };
  computeCommitGraphForBridge(
    routing: { session: Session; targetId: string },
    payload: GitGraphRequestPayloadV1,
  ): Promise<GitGraphResponsePayloadV1>;
  handleGitGraphRequest(message: {
    type: 'git_graph_request';
    protocolVersion: typeof PROTOCOL_V1;
    sessionId: string;
    requestId: string;
    envelope: EncryptedEnvelope;
  }): void;
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

describe('NodeDaemon computeCommitGraphForBridge against a real repo (issue #231)', () => {
  it('threads ref/limit/offset through to a real page, honest topology and all', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    const node = bareDaemon(sessionManager);
    try {
      const page = await internals(node).computeCommitGraphForBridge(
        { session, targetId: 'local' },
        { ref: 'main', limit: 1, offset: 0 },
      );
      expect(page.outcome).toBe('ok');
      if (page.outcome === 'ok') {
        expect(page.commits).toHaveLength(1);
        expect(page.commits[0]?.subject).toBe('second commit');
        expect(page.nextOffset).toBe(1);
      }
    } finally {
      node.close();
    }
  });

  it('reports an empty graph, never an error, for an unborn HEAD', async () => {
    const emptyRepoDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-graph-daemon-empty-'));
    try {
      await execGit(emptyRepoDir, ['init', '-q', '-b', 'main']);
      const sessionManager = new SessionManager();
      const session = await sessionManager.createSession({
        projectPath: emptyRepoDir,
        provider: 'test',
        workInPlace: true,
      });
      const node = bareDaemon(sessionManager);
      try {
        const page = await internals(node).computeCommitGraphForBridge(
          { session, targetId: 'local' },
          {},
        );
        expect(page).toEqual({ outcome: 'ok', commits: [], nextOffset: null });
      } finally {
        node.close();
      }
    } finally {
      await rm(emptyRepoDir, { recursive: true, force: true });
    }
  });

  it('reports outcome: error for a ref that names no real commit, never throws', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    const node = bareDaemon(sessionManager);
    try {
      const page = await internals(node).computeCommitGraphForBridge(
        { session, targetId: 'local' },
        { ref: 'no-such-branch' },
      );
      expect(page.outcome).toBe('error');
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon git_graph_request wire handler: real encrypted envelope round trip (issue #231)', () => {
  async function sessionKey(sessionId: string) {
    return deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
  }

  it('handleGitGraphRequest decrypts the enveloped ref/limit/offset request and replies over a sealed git_graph_response', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    const node = bareDaemon(sessionManager);
    const sent: unknown[] = [];
    internals(node).relay.send = vi.fn((message: unknown) => {
      sent.push(message);
    });
    const key = await sessionKey(session.id);
    try {
      const requestPayload: GitGraphRequestPayloadV1 = { ref: 'main', limit: 10 };
      const envelope = await sealJson(session.id, requestPayload, key);
      internals(node).handleGitGraphRequest({
        type: 'git_graph_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-graph',
        envelope,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as { type: string; sessionId: string; envelope: EncryptedEnvelope };
      expect(response.type).toBe('git_graph_response');
      const payload = await openJson<GitGraphResponsePayloadV1>(session.id, response.envelope, key);
      expect(payload.outcome).toBe('ok');
      if (payload.outcome === 'ok') {
        expect(payload.commits.map((c) => c.subject)).toEqual(['second commit', 'base']);
        expect(payload.nextOffset).toBeNull();
      }
    } finally {
      node.close();
    }
  });

  it('ignores a request for a session this node does not own — no response sent at all', () => {
    const sessionManager = new SessionManager();
    const node = bareDaemon(sessionManager);
    const sent: unknown[] = [];
    internals(node).relay.send = vi.fn((message: unknown) => {
      sent.push(message);
    });
    try {
      internals(node).handleGitGraphRequest({
        type: 'git_graph_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'no-such-session',
        requestId: 'req-unknown',
        envelope: {
          resourceId: 'no-such-session',
          iv: 'AAAA',
          ciphertext: 'AAAA',
          alg: 'AES-256-GCM',
        },
      });
      expect(sent).toHaveLength(0);
    } finally {
      node.close();
    }
  });
});
