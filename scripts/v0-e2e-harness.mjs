/**
 * loombox v0 end-to-end validation harness (issue #54).
 *
 * The v0 acceptance (SPEC §12) is: "from a phone on the tailnet, observe a
 * running session and inject one prompt that the agent acts on." The dev box is
 * headless (no browser, no phone), so this harness stands in for the phone: it
 * drives the WHOLE loop end to end over a real relay and asserts on it, using a
 * hermetic fixture ACP agent instead of the real `claude` binary.
 *
 *   relay (real @loombox/relay)  <-- WS -->  node (createNode: SessionManager +
 *   AgentSupervisor + RelayConnection, running a fixture agent in a real git
 *   worktree)                    <-- WS -->  a headless "phone" client
 *
 * Checks:
 *   A. a client that connects AFTER the session exists observes it, without
 *      having started anything itself (session_list snapshot / session_announce);
 *   B. output the client did NOT initiate (an operator-side prompt) streams to
 *      it live as an appended transcript;
 *   C. a prompt the client injects over the relay produces a NEW agent turn.
 *
 * Run:  RELAY_HOST=100.87.202.117 pnpm exec tsx scripts/v0-e2e-harness.mjs
 * (defaults to 127.0.0.1; point RELAY_HOST at `tailscale ip -4` to exercise the
 * same tailnet path a phone uses).
 *
 * What this does NOT cover (the human confirmation step): a real Claude Code
 * agent and a real phone browser on the tailnet. Those are Lorenzo's manual
 * pass; everything structural is proven here.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createNode } from '@loombox/node';
import { startRelay } from '@loombox/relay';
import { AgentSupervisor } from '@loombox/supervisor';

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 0;
const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1';
const RELAY_PORT = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : 0;

const ECHO_FIXTURE = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'packages',
  'providers',
  'core',
  'test',
  'fixtures',
  'echo-acp-agent.mjs',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fixture ACP provider registered as 'claude' so no real claude binary is needed. */
function echoProvider() {
  return {
    id: 'claude',
    spawnConfig: ({ cwd }) => ({ command: process.execPath, args: [ECHO_FIXTURE], cwd }),
    enrich: (update) => update,
  };
}

/** A minimal PWA-like "phone" client over Node's global WebSocket. */
class Phone {
  constructor(url, clientId) {
    this.messages = [];
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        this.socket.send(
          JSON.stringify({ type: 'client_hello', protocolVersion: PROTOCOL_VERSION, clientId }),
        );
        resolve();
      });
      this.socket.addEventListener('error', () => reject(new Error(`phone cannot reach ${url}`)));
    });
    this.socket.addEventListener('message', (event) => {
      this.messages.push(JSON.parse(String(event.data)));
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  count(predicate) {
    return this.messages.filter(predicate).length;
  }

  async waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) return undefined;
      await sleep(20);
    }
  }

  close() {
    this.socket.close();
  }
}

async function makeGitRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'loombox-v0-e2e-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'loombox',
    GIT_AUTHOR_EMAIL: 'loombox@example.com',
    GIT_COMMITTER_NAME: 'loombox',
    GIT_COMMITTER_EMAIL: 'loombox@example.com',
  };
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir, env });
  return dir;
}

async function main() {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
  };

  const relay = await startRelay({ host: RELAY_HOST, port: RELAY_PORT });
  console.log(`relay listening on ${relay.url}`);
  const projectPath = await makeGitRepo();

  const supervisor = new AgentSupervisor({ providers: [echoProvider()] });
  const node = createNode({ relayUrl: relay.url, nodeId: 'devbox-node-1', supervisor });
  await sleep(300); // let the node's outbound WS connect + node_hello land

  const session = await node.createSession({ projectPath, provider: 'claude' });
  console.log(`session ${session.id} in worktree ${session.worktreePath}`);

  // The phone connects only now, AFTER the session already exists, and starts nothing.
  const phone = new Phone(relay.url, 'phone-1');
  await phone.ready;

  const observed = await phone.waitFor(
    (m) =>
      (m.type === 'session_list' && m.sessions.some((s) => s.id === session.id)) ||
      (m.type === 'session_announce' && m.session.id === session.id),
  );
  record('A. phone observes the running session without starting it', Boolean(observed));

  // B. operator-side activity the phone did not initiate streams to it live.
  const before = phone.count(
    (m) => m.type === 'session_update' && m.update.kind === 'agent_message_chunk',
  );
  await node.promptSession(session.id, 'operator: summarize the repo');
  const liveOutput = await phone.waitFor(
    (m) =>
      m.type === 'session_update' &&
      m.sessionId === session.id &&
      m.update.kind === 'agent_message_chunk',
  );
  record('B. phone sees live output it did not initiate', Boolean(liveOutput));

  // C. a prompt the phone injects over the relay produces a NEW agent turn.
  const afterOperator = phone.count(
    (m) => m.type === 'session_update' && m.update.kind === 'agent_message_chunk',
  );
  phone.send({
    type: 'prompt_inject',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: session.id,
    promptId: 'phone-prompt-1',
    text: 'phone: and now add a test',
  });
  const grew = await phone.waitFor(
    () =>
      phone.count((m) => m.type === 'session_update' && m.update.kind === 'agent_message_chunk') >
      afterOperator,
  );
  record(
    'C. phone-injected prompt produces a new agent turn',
    Boolean(grew),
    `chunks before=${before} afterOperator=${afterOperator} final=${phone.count((m) => m.type === 'session_update' && m.update.kind === 'agent_message_chunk')}`,
  );

  phone.close();
  node.close();
  await relay.close();
  await rm(projectPath, { recursive: true, force: true });

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\nv0 end-to-end: ${passed}/${checks.length} checks passed over ${relay.url}`);
  return passed === checks.length;
}

main()
  .then((ok) => {
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error('harness error:', error);
    process.exit(1);
  });
