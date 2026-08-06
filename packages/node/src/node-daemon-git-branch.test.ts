import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_V1,
  type EncryptedEnvelope,
  type GitBranchCreateResponsePayloadV1,
  type GitBranchListResponsePayloadV1,
  type GitBranchMergeAbortResponsePayloadV1,
  type GitBranchMergeResponsePayloadV1,
  type GitBranchSwitchResponsePayloadV1,
  type GitStashDropResponsePayloadV1,
  type GitStashPopResponsePayloadV1,
  type GitStashSaveResponsePayloadV1,
} from '@loombox/protocol';
import { deriveSessionKey, openJson, sealJson } from '@loombox/crypto';

import { NodeDaemon } from './node-daemon';
import { SessionManager } from './session-manager';
import type { Session } from './session-manager';

const execFileAsync = promisify(execFile);

/**
 * Daemon-level proof for issue #234's branch/stash wire pairs: routing
 * through `NodeDaemon`'s own `resolveSessionRouting`, the
 * worktree-isolated-session guard (`switchBranchForBridge`/
 * `createBranchForBridge`'s own doc comments), and — for the outcomes
 * this issue's acceptance bar cares most about (a fixed session branch, a
 * dirty-worktree switch, a merge conflict, a stash that cannot pop) — the
 * real encrypted envelope round trip, against a REAL local git repo via
 * `SessionManager.createSession` (never a mocked `Session`/git return).
 * Harness modeled on `node-daemon-ci-check.test.ts`'s own "bare,
 * never-connected NodeDaemon" convention: `new NodeDaemon(...)` never
 * dials the relay itself, so this suite stubs `relay.send` to capture
 * what the daemon would have sent, with no real network involved.
 */

const AMK = new Uint8Array(32).fill(7);
const ACCOUNT_ID = 'acct-git-branch';

let stateDir: string;
let repoDir: string;

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-branch-daemon-state-'));
  repoDir = await mkdtemp(path.join(tmpdir(), 'loombox-git-branch-daemon-repo-'));
  await execGit(repoDir, ['init', '-q', '-b', 'main']);
  await execGit(repoDir, ['config', 'user.email', 'test@loombox.dev']);
  await execGit(repoDir, ['config', 'user.name', 'loombox test']);
  await writeFile(path.join(repoDir, 'f.txt'), 'base\n');
  await execGit(repoDir, ['add', 'f.txt']);
  await execGit(repoDir, ['commit', '-q', '-m', 'base']);
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

function bareDaemon(sessionManager: SessionManager): NodeDaemon {
  return new NodeDaemon({
    relayUrl: 'ws://127.0.0.1:0',
    nodeId: 'node-git-branch',
    deviceId: 'device-git-branch',
    devicePublicKey: 'YWJjZA==',
    authToken: ACCOUNT_ID,
    accountId: ACCOUNT_ID,
    amk: AMK,
    stateDir,
    sessionManager,
  });
}

/** This suite's only seam into the daemon's private git-branch/stash wire handlers and bridge methods — TS `private` is compile-time only, and none of these are otherwise public. `relay` is narrowed to just `send` so a test can stub it and capture what the daemon would have sent over a real connection. */
interface DaemonInternals {
  relay: { send: (message: unknown) => void };
  switchBranchForBridge(
    routing: { session: Session; targetId: string },
    payload: { name: string },
  ): Promise<GitBranchSwitchResponsePayloadV1>;
  createBranchForBridge(
    routing: { session: Session; targetId: string },
    payload: { name: string; startPoint: string | null; checkout: boolean },
  ): Promise<GitBranchCreateResponsePayloadV1>;
  mergeBranchForBridge(
    routing: { session: Session; targetId: string },
    payload: { name: string },
  ): Promise<GitBranchMergeResponsePayloadV1>;
  abortMergeForBridge(routing: {
    session: Session;
    targetId: string;
  }): Promise<GitBranchMergeAbortResponsePayloadV1>;
  listBranchesForBridge(routing: {
    session: Session;
    targetId: string;
  }): Promise<GitBranchListResponsePayloadV1>;
  stashSaveForBridge(
    routing: { session: Session; targetId: string },
    payload: { message: string | null },
  ): Promise<GitStashSaveResponsePayloadV1>;
  stashPopForBridge(
    routing: { session: Session; targetId: string },
    payload: { index: number | null },
  ): Promise<GitStashPopResponsePayloadV1>;
  stashDropForBridge(
    routing: { session: Session; targetId: string },
    payload: { index: number },
  ): Promise<GitStashDropResponsePayloadV1>;
  handleGitBranchSwitchRequest(message: {
    type: 'git_branch_switch_request';
    protocolVersion: typeof PROTOCOL_V1;
    sessionId: string;
    requestId: string;
    envelope: EncryptedEnvelope;
  }): void;
  handleGitBranchMergeRequest(message: {
    type: 'git_branch_merge_request';
    protocolVersion: typeof PROTOCOL_V1;
    sessionId: string;
    requestId: string;
    envelope: EncryptedEnvelope;
  }): void;
  handleGitStashPopRequest(message: {
    type: 'git_stash_pop_request';
    protocolVersion: typeof PROTOCOL_V1;
    sessionId: string;
    requestId: string;
    envelope: EncryptedEnvelope;
  }): void;
  handleGitBranchListRequest(message: {
    type: 'git_branch_list_request';
    protocolVersion: typeof PROTOCOL_V1;
    sessionId: string;
    requestId: string;
  }): void;
}
function internals(node: NodeDaemon): DaemonInternals {
  return node as unknown as DaemonInternals;
}

describe('NodeDaemon git-branch/stash bridge: worktree-isolated-session guard (SPEC §7.6; issue #234)', () => {
  it('switchBranchForBridge refuses BEFORE touching git for a worktree-isolated session, and HEAD genuinely never moves', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    expect(session.branch).not.toBe(''); // isolated session — sanity-check the fixture itself
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).switchBranchForBridge(
        { session, targetId: 'local' },
        { name: 'main' },
      );
      expect(result).toEqual({
        outcome: 'session_branch_fixed',
        message: expect.stringContaining(session.branch),
      });
      // Never even ran `git checkout` — the isolated worktree is still on
      // its own dedicated session branch, not `main`.
      await expect(
        execGit(session.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).resolves.toBe(session.branch);
    } finally {
      node.close();
    }
  });

  it('createBranchForBridge with checkout: true refuses the switch half for a worktree-isolated session, but the branch is still created', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).createBranchForBridge(
        { session, targetId: 'local' },
        { name: 'feature', startPoint: null, checkout: true },
      );
      expect(result.outcome).toBe('session_branch_fixed');
      // The create half still ran (harmless — it never moves HEAD) —
      // only the switch half was refused.
      const branches = await execGit(session.worktreePath, ['branch', '--list']);
      expect(branches).toContain('feature');
      await expect(
        execGit(session.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).resolves.toBe(session.branch);
    } finally {
      node.close();
    }
  });

  it('switchBranchForBridge switches freely for a work-in-place session (branch === "")', async () => {
    const sessionManager = new SessionManager();
    await execGit(repoDir, ['branch', 'feature']);
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    expect(session.branch).toBe('');
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).switchBranchForBridge(
        { session, targetId: 'local' },
        { name: 'feature' },
      );
      expect(result).toEqual({ outcome: 'ok', branch: 'feature' });
      await expect(execGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe(
        'feature',
      );
    } finally {
      node.close();
    }
  });

  it('mergeBranchForBridge merges INTO an isolated session branch freely — no guard, since HEAD never moves off the session branch', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    await writeFile(path.join(repoDir, 'g.txt'), 'g\n');
    await execGit(repoDir, ['add', 'g.txt']);
    await execGit(repoDir, ['commit', '-q', '-m', 'upstream change on main']);
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).mergeBranchForBridge(
        { session, targetId: 'local' },
        { name: 'main' },
      );
      expect(result.outcome).toBe('ok');
      // Still on its own session branch — merge never switches it.
      await expect(
        execGit(session.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ).resolves.toBe(session.branch);
      await expect(execGit(session.worktreePath, ['cat-file', '-e', 'HEAD:g.txt'])).resolves.toBe(
        '',
      );
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon git-branch/stash bridge: outcome mapping against a real repo (issue #234)', () => {
  it('createBranchForBridge reports already_exists without throwing', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    await execGit(repoDir, ['branch', 'dupe']);
    const node = bareDaemon(sessionManager);
    try {
      const result = await internals(node).createBranchForBridge(
        { session, targetId: 'local' },
        { name: 'dupe', startPoint: null, checkout: false },
      );
      expect(result.outcome).toBe('already_exists');
    } finally {
      node.close();
    }
  });

  it('abortMergeForBridge cleanly resolves a real conflicted merge — the "abort" half of resolve-or-abort', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    await execGit(repoDir, ['checkout', '-q', '-b', 'feature']);
    await writeFile(path.join(repoDir, 'f.txt'), 'feature-change\n');
    await execGit(repoDir, ['commit', '-q', '-am', 'feature change']);
    await execGit(repoDir, ['checkout', '-q', 'main']);
    await writeFile(path.join(repoDir, 'f.txt'), 'main-change\n');
    await execGit(repoDir, ['commit', '-q', '-am', 'main change']);
    const node = bareDaemon(sessionManager);
    try {
      const mergeResult = await internals(node).mergeBranchForBridge(
        { session, targetId: 'local' },
        { name: 'feature' },
      );
      expect(mergeResult.outcome).toBe('conflict');

      const abortResult = await internals(node).abortMergeForBridge({ session, targetId: 'local' });
      expect(abortResult).toEqual({ outcome: 'ok' });
      const status = await execGit(repoDir, ['status', '--porcelain']);
      expect(status).toBe('');
    } finally {
      node.close();
    }
  });

  it('stashPopForBridge reports conflict with stashKept: true, and the stash genuinely survives', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    const node = bareDaemon(sessionManager);
    try {
      await internals(node).stashSaveForBridge(
        { session, targetId: 'local' },
        { message: 'conflicting' },
      );
      await writeFile(path.join(repoDir, 'f.txt'), 'stashed-version\n');
      await execGit(repoDir, ['stash', 'push']); // move the same conflicting content back into a real stash
      await writeFile(path.join(repoDir, 'f.txt'), 'diverged\n');
      await execGit(repoDir, ['commit', '-q', '-am', 'diverging commit']);

      const result = await internals(node).stashPopForBridge(
        { session, targetId: 'local' },
        { index: null },
      );
      expect(result.outcome).toBe('conflict');
      if (result.outcome === 'conflict') {
        expect(result.stashKept).toBe(true);
        expect(result.conflictedPaths).toEqual(['f.txt']);
      }

      const dropResult = await internals(node).stashDropForBridge(
        { session, targetId: 'local' },
        { index: 0 },
      );
      expect(dropResult).toEqual({ outcome: 'ok' });
    } finally {
      node.close();
    }
  });
});

describe('NodeDaemon git-branch/stash wire handlers: real encrypted envelope round trip (issue #234)', () => {
  async function sessionKey(sessionId: string) {
    return deriveSessionKey(AMK, ACCOUNT_ID, sessionId);
  }

  it('handleGitBranchListRequest replies over a sealed git_branch_list_response even though the request itself carries no envelope', async () => {
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
    try {
      internals(node).handleGitBranchListRequest({
        type: 'git_branch_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-branch-list',
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as {
        type: string;
        sessionId: string;
        requestId: string;
        envelope: EncryptedEnvelope;
      };
      expect(response.type).toBe('git_branch_list_response');
      const key = await sessionKey(session.id);
      const payload = await openJson<GitBranchListResponsePayloadV1>(
        session.id,
        response.envelope,
        key,
      );
      expect(payload).toEqual({ outcome: 'ok', branches: [{ name: 'main', current: true }] });
    } finally {
      node.close();
    }
  });

  it('handleGitBranchSwitchRequest round-trips a real session_branch_fixed refusal through encryption for an isolated session', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({ projectPath: repoDir, provider: 'test' });
    const node = bareDaemon(sessionManager);
    const sent: unknown[] = [];
    internals(node).relay.send = vi.fn((message: unknown) => {
      sent.push(message);
    });
    const key = await sessionKey(session.id);
    try {
      const envelope = await sealJson(session.id, { name: 'main' }, key);
      internals(node).handleGitBranchSwitchRequest({
        type: 'git_branch_switch_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-switch',
        envelope,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as {
        type: string;
        envelope: EncryptedEnvelope;
      };
      expect(response.type).toBe('git_branch_switch_response');
      const payload = await openJson<GitBranchSwitchResponsePayloadV1>(
        session.id,
        response.envelope,
        key,
      );
      expect(payload.outcome).toBe('session_branch_fixed');
    } finally {
      node.close();
    }
  });

  it('handleGitBranchMergeRequest round-trips a real conflict outcome through encryption, with the real conflicted path', async () => {
    const sessionManager = new SessionManager();
    const session = await sessionManager.createSession({
      projectPath: repoDir,
      provider: 'test',
      workInPlace: true,
    });
    await execGit(repoDir, ['checkout', '-q', '-b', 'feature']);
    await writeFile(path.join(repoDir, 'f.txt'), 'feature-change\n');
    await execGit(repoDir, ['commit', '-q', '-am', 'feature change']);
    await execGit(repoDir, ['checkout', '-q', 'main']);
    await writeFile(path.join(repoDir, 'f.txt'), 'main-change\n');
    await execGit(repoDir, ['commit', '-q', '-am', 'main change']);

    const node = bareDaemon(sessionManager);
    const sent: unknown[] = [];
    internals(node).relay.send = vi.fn((message: unknown) => {
      sent.push(message);
    });
    const key = await sessionKey(session.id);
    try {
      const envelope = await sealJson(session.id, { name: 'feature' }, key);
      internals(node).handleGitBranchMergeRequest({
        type: 'git_branch_merge_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-merge',
        envelope,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as { type: string; envelope: EncryptedEnvelope };
      expect(response.type).toBe('git_branch_merge_response');
      const payload = await openJson<GitBranchMergeResponsePayloadV1>(
        session.id,
        response.envelope,
        key,
      );
      expect(payload.outcome).toBe('conflict');
      if (payload.outcome === 'conflict') {
        expect(payload.conflictedPaths).toEqual(['f.txt']);
      }
    } finally {
      node.close();
    }
  });

  it('handleGitStashPopRequest round-trips a real not_found outcome through encryption for an empty stash stack', async () => {
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
      const envelope = await sealJson(session.id, { index: null }, key);
      internals(node).handleGitStashPopRequest({
        type: 'git_stash_pop_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: session.id,
        requestId: 'req-stash-pop',
        envelope,
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));

      const response = sent[0] as { type: string; envelope: EncryptedEnvelope };
      expect(response.type).toBe('git_stash_pop_response');
      const payload = await openJson<GitStashPopResponsePayloadV1>(
        session.id,
        response.envelope,
        key,
      );
      expect(payload.outcome).toBe('not_found');
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
      internals(node).handleGitBranchListRequest({
        type: 'git_branch_list_request',
        protocolVersion: PROTOCOL_V1,
        sessionId: 'no-such-session',
        requestId: 'req-unknown',
      });
      expect(sent).toHaveLength(0);
    } finally {
      node.close();
    }
  });
});
