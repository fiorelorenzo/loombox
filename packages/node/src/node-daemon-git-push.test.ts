import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type GitPushResponsePayloadV1,
} from '@loombox/protocol';
import { deriveSessionKey, openJson, sealJson } from '@loombox/crypto';

import { NodeDaemon } from './node-daemon';
import { SessionManager } from './session-manager';
import type { Session } from './session-manager';

const execFileAsync = promisify(execFile);

/**
 * Daemon-level proof for issue #235's `git_push_request`/`_response` wire
 * pair: routing through `NodeDaemon`'s own `resolveSessionRouting`, the
 * real `resolveSessionBranch`/`pushBranch` (`./git-diff.ts`) bridge, and
 * the real encrypted envelope round trip — against a REAL local git repo
 * with a REAL local bare remote (`git init --bare`, no network), never a
 * mocked `Session`/git return. Harness modeled directly on
 * `node-daemon-git-branch.test.ts`'s own "bare, never-connected
 * NodeDaemon" convention: `new NodeDaemon(...)` never dials the relay
 * itself, so this suite stubs `relay.send` to capture what the daemon
 * would have sent, with no real network involved anywhere in the suite.
 */

const AMK = new Uint8Array(32).fill(9);
const ACCOUNT_ID = 'acct-git-push';

let stateDir: string;
let repoDir: string;
let bareDir: string;

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-push-daemon-state-'));
  repoDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-push-daemon-repo-'));
  bareDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-push-daemon-remote-'));
  await execFileAsync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);
  await execGit(repoDir, ['init', '-q', '-b', 'main']);
  await execGit(repoDir, ['config', 'user.email', 'test@loombox.dev']);
  await execGit(repoDir, ['config', 'user.name', 'loombox test']);
  await execGit(repoDir, ['remote', 'add', 'origin', bareDir]);
  await writeFile(path.join(repoDir, 'f.txt'), 'base\n');
  await execGit(repoDir, ['add', 'f.txt']);
  await execGit(repoDir, ['commit', '-q', '-m', 'base']);
  await execGit(repoDir, ['push', '-q', 'origin', 'main']);
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
  await rm(bareDir, { recursive: true, force: true });
});

function bareDaemon(sessionManager: SessionManager): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-git-push',
    deviceId: 'device-git-push',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    sessionManager,
  });
}

/** This suite's only seam into the daemon's private git-push wire handler and bridge method — TS `private` is compile-time only, and neither is otherwise public. `relay` is narrowed to just `send` so a test can stub it and capture what the daemon would have sent over a real connection. */
interface DaemonInternals {
  relay: { send: (message: unknown) => void };
  pushBranchForBridge(
    routing: { session: Session; targetId: string },
    payload: { force: boolean },
  ): Promise<GitPushResponsePayloadV1>;
  handleGitPushRequest(message: {
    type: 'git_push_request';
    protocolVersion: typeof PROTOCOL_V1;
    sessionId: string;
    requestId: string;
    envelope: EncryptedEnvelope;
  }): void;
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

describe('NodeDaemon git-push bridge: outcome mapping against a real repo + real bare remote (issue #235)', () => {
  it('pushBranchForBridge pushes a fresh isolated session branch and sets upstream on the real bare remote', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    expect(session.branch).not.toBe(''); // isolated session — sanity-check the fixture
    await writeFile(path.join(session.worktreePath, 'g.txt'), 'g\n');
    await execGit(session.worktreePath, ['add', 'g.txt']);
    await execGit(session.worktreePath, ['commit', '-q', '-m', 'session work']);
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).pushBranchForBridge(
        { session, targetId: 'local' },
        { force: false },
      );
      expect(result).toEqual({
        outcome: 'ok',
        branch: session.branch,
        setUpstream: true,
        forced: false,
      });
      const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
      expect(remoteRefs.stdout).toContain(`refs/heads/${session.branch}`);
    } finally {
      node.close();
    }
  });

  it('pushBranchForBridge reports rejected_non_fast_forward honestly when the remote has diverged, then rejected_stale_lease for an un-fetched force, then ok once fetched', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    await execGit(session.worktreePath, ['commit', '-q', '--allow-empty', '-m', 'session work']);
    const node = bareDaemon(sessionManager);
    try {
      const first = await internals(node).pushBranchForBridge(
        { session, targetId: 'local' },
        { force: false },
      );
      expect(first.outcome).toBe('ok');

      // A peer clones the bare remote and pushes a diverging commit of
      // its own to the same branch — real git, entirely independent of
      // the daemon under test.
      const peerDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-push-daemon-peer-'));
      try {
        await execFileAsync('git', ['clone', '-q', bareDir, peerDir]);
        await execGit(peerDir, ['config', 'user.email', 'peer@loombox.dev']);
        await execGit(peerDir, ['config', 'user.name', 'loombox peer']);
        await execGit(peerDir, ['checkout', '-q', session.branch]);
        await execGit(peerDir, ['commit', '-q', '--allow-empty', '-m', 'peer work']);
        await execGit(peerDir, ['push', '-q', 'origin', session.branch]);

        // The session's own worktree never fetched — its next commit
        // diverges from what the remote now has.
        await execGit(session.worktreePath, ['commit', '-q', '--allow-empty', '-m', 'more work']);

        const rejected = await internals(node).pushBranchForBridge(
          { session, targetId: 'local' },
          { force: false },
        );
        expect(rejected).toEqual({
          outcome: 'rejected_non_fast_forward',
          message: expect.any(String),
        });

        const staleForce = await internals(node).pushBranchForBridge(
          { session, targetId: 'local' },
          { force: true },
        );
        expect(staleForce).toEqual({
          outcome: 'rejected_stale_lease',
          message: expect.any(String),
        });

        await execGit(session.worktreePath, ['fetch', '-q', 'origin']);
        const forced = await internals(node).pushBranchForBridge(
          { session, targetId: 'local' },
          { force: true },
        );
        expect(forced).toEqual({
          outcome: 'ok',
          branch: session.branch,
          setUpstream: false,
          forced: true,
        });
      } finally {
        await rm(peerDir, { recursive: true, force: true });
      }
    } finally {
      node.close();
    }
  });

  it('pushBranchForBridge reports no_branch for a detached HEAD on a work-in-place session, without running git push at all', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    await execGit(repoDir, ['checkout', '-q', '--detach', 'main']);
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).pushBranchForBridge(
        { session, targetId: 'local' },
        { force: false },
      );
      expect(result).toEqual({ outcome: 'no_branch', message: expect.any(String) });
      // Never even attempted a push — the bare remote still has only
      // what beforeEach already put there.
      const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
      expect(remoteRefs.stdout.trim().split('\n')).toHaveLength(1);
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon git-push wire handler: real encrypted envelope round trip (issue #235)', () => {
  async function sessionKey(sessionId: string) {
    return deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
  }

  it('handleGitPushRequest round-trips a real ok outcome through encryption for an isolated session', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    await execGit(session.worktreePath, ['commit', '-q', '--allow-empty', '-m', 'session work']);
    const node = bareDaemon(sessionManager);
    const sent: unknown[] = [];
    internals(node).relay.send = vi.fn((message: unknown) => {
      sent.push(message);
    });
    const key = await sessionKey(session.id);
    try {
      const envelope = await sealJson(session.id, { force: false }, key);
      internals(node).handleGitPushRequest({
        type: 'git_push_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-push',
        envelope,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as { type: string; requestId: string; envelope: EncryptedEnvelope };
      expect(response.type).toBe('git_push_response');
      expect(response.requestId).toBe('req-push');
      const payload = await openJson<GitPushResponsePayloadV1>(session.id, response.envelope, key);
      expect(payload).toEqual({
        outcome: 'ok',
        branch: session.branch,
        setUpstream: true,
        forced: false,
      });
      const remoteRefs = await execFileAsync('git', ['ls-remote', '--heads', bareDir]);
      expect(remoteRefs.stdout).toContain(`refs/heads/${session.branch}`);
    } finally {
      node.close();
    }
  });

  it('ignores a request for a session this node does not own — no response sent at all', async () => {
    const sessionManager = new SessionManager();
    const node = bareDaemon(sessionManager);
    const sent: unknown[] = [];
    internals(node).relay.send = vi.fn((message: unknown) => {
      sent.push(message);
    });
    try {
      const key = await sessionKey('no-such-session');
      const envelope = await sealJson('no-such-session', { force: false }, key);
      internals(node).handleGitPushRequest({
        type: 'git_push_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'no-such-session',
        requestId: 'req-unknown',
        envelope,
      });
      expect(sent).toHaveLength(0);
    } finally {
      node.close();
    }
  });
});
