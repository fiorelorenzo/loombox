import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SshTargetConfig } from '../target';
import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { FakeTransport, type FakeExecHandler } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import {
  buildResidentNodeEnvironment,
  decommission,
  provision,
  type ResidentNodeConfig,
} from './provision-target';
import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';
import { Ssh2Transport } from './ssh2-transport';
import type { SupervisorArtifactSource } from './supervisor-artifact';
import { SshTargetStore } from './verify-and-persist';

const TARGET: SshTargetConfig = {
  id: 'devbox-1',
  label: 'Dev box',
  host: '127.0.0.1',
  user: 'loombox',
};

const RESIDENT_NODE_CONFIG: ResidentNodeConfig = {
  relayUrl: 'wss://relay.loombox.dev',
  nodeId: 'devbox-1',
  authToken: 'token-abc',
  recoveryCode: 'recovery-xyz',
};

function generateEd25519Pair(): { privateKey: KeyObject; publicKeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

function signedArtifactSource(
  privateKey: KeyObject,
  payload = '#!/bin/sh\necho fake-supervisor\n',
): { source: SupervisorArtifactSource; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(payload);
  const signature = new Uint8Array(cryptoSign(null, Buffer.from(bytes), privateKey));
  const source: SupervisorArtifactSource = {
    fetch: async (_osArch, version) => ({ version, bytes, signature }),
  };
  return { source, bytes };
}

/** A `SupervisorArtifactSource` that fails the test if it's ever consulted — for asserting a stopped-early chain never reaches step 3. */
const NEVER_FETCHED_SOURCE: SupervisorArtifactSource = {
  fetch: async () => {
    throw new Error('supervisor artifact source should never be fetched');
  },
};

let stateDir: string;
let store: SshTargetStore;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'loombox-provision-store-'));
  store = new SshTargetStore({ stateDir });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('buildResidentNodeEnvironment', () => {
  it('maps ResidentNodeConfig onto the exact LOOMBOX_*/CLAUDE_CODE_OAUTH_TOKEN env-var names config.ts reads', () => {
    const environment = buildResidentNodeEnvironment({
      relayUrl: 'wss://relay.loombox.dev',
      nodeId: 'devbox',
      deviceId: 'devbox-device',
      authToken: 'auth-token',
      accountId: 'account-1',
      recoveryCode: 'recovery-code',
      claudeCodeOAuthToken: 'claude-token',
      stateDir: '/home/loombox/.loombox/node',
    });
    expect(environment).toEqual({
      LOOMBOX_RELAY_URL: 'wss://relay.loombox.dev',
      LOOMBOX_NODE_ID: 'devbox',
      LOOMBOX_DEVICE_ID: 'devbox-device',
      LOOMBOX_AUTH_TOKEN: 'auth-token',
      LOOMBOX_ACCOUNT_ID: 'account-1',
      LOOMBOX_RECOVERY_CODE: 'recovery-code',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
      LOOMBOX_NODE_STATE_DIR: '/home/loombox/.loombox/node',
    });
  });

  it('authToken wins over deviceToken and amk wins over recoveryCode, mirroring config.ts precedence', () => {
    const environment = buildResidentNodeEnvironment({
      relayUrl: 'wss://relay.loombox.dev',
      nodeId: 'devbox',
      authToken: 'auth-token',
      deviceToken: 'device-token',
      amk: 'YW1r',
      recoveryCode: 'recovery-code',
    });
    expect(environment.LOOMBOX_AUTH_TOKEN).toBe('auth-token');
    expect(environment.LOOMBOX_DEVICE_TOKEN).toBeUndefined();
    expect(environment.LOOMBOX_AMK).toBe('YW1r');
    expect(environment.LOOMBOX_RECOVERY_CODE).toBeUndefined();
  });

  it('lets extraEnvironment override/add keys without dropping them', () => {
    const environment = buildResidentNodeEnvironment({
      relayUrl: 'wss://relay.loombox.dev',
      nodeId: 'devbox',
      extraEnvironment: { LOOMBOX_RELAY_URL: 'ws://overridden', CUSTOM_VAR: '1' },
    });
    expect(environment.LOOMBOX_RELAY_URL).toBe('ws://overridden');
    expect(environment.CUSTOM_VAR).toBe('1');
  });
});

describe('provision (issue #400) — step-sequencing and error-stops-at-step, using fakes', () => {
  it('stops at verify_and_persist on a connect failure, touching neither the runtime nor the artifact source', async () => {
    const connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { publicKeyRaw } = generateEd25519Pair();

    const result = await provision(TARGET, {
      transportFactory: () => new FakeTransport({ connectError }),
      store,
      supervisor: {
        artifactSource: NEVER_FETCHED_SOURCE,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      },
      residentNode: { config: RESIDENT_NODE_CONFIG },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('verify_and_persist');
    expect(result.steps.map((s) => s.step)).toEqual(['verify_and_persist']);
    expect(store.list()).toEqual([]);
  });

  it('stops at runtime_bootstrap when the install commands fail, never reaching supervisor/systemd', async () => {
    const { publicKeyRaw } = generateEd25519Pair();
    const calls: string[] = [];

    const handler: FakeExecHandler = (command) => {
      calls.push(command);
      if (command.includes('command -v "$c"')) {
        return { stdout: 'setsid=1\nmkfifo=1\ntmux=0\nscreen=0\n', stderr: '', exitCode: 0 };
      }
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('command -v node'))
        return { stdout: 'missing', stderr: '', exitCode: 0 };
      if (command.includes('command -v mise'))
        return { stdout: 'missing', stderr: '', exitCode: 0 };
      if (command.includes('mise.run')) {
        return { stdout: '', stderr: 'sh: curl: not found', exitCode: 127 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const result = await provision(TARGET, {
      transportFactory: () => new FakeTransport({ onExec: handler }),
      store,
      supervisor: {
        artifactSource: NEVER_FETCHED_SOURCE,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      },
      residentNode: { config: RESIDENT_NODE_CONFIG },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('runtime_bootstrap');
    expect(result.steps.map((s) => s.step)).toEqual(['verify_and_persist', 'runtime_bootstrap']);
    const runtimeStep = result.steps[1];
    if (runtimeStep?.step === 'runtime_bootstrap') {
      expect(runtimeStep.result?.failedAt).toBe('curl -fsSL https://mise.run | sh');
    } else {
      throw new Error('expected step 2 to be runtime_bootstrap');
    }
    // The target was still persisted by the (successful) verify step, but
    // provisioning as a whole failed.
    expect(store.get(TARGET.id)).toEqual(TARGET);
  });

  it('stops at supervisor_install when the fetched artifact fails signature verification, never reaching systemd', async () => {
    const attacker = generateEd25519Pair();
    const { publicKeyRaw } = generateEd25519Pair();
    const { source } = signedArtifactSource(attacker.privateKey);

    const handler: FakeExecHandler = (command) => {
      if (command.includes('command -v "$c"')) {
        return { stdout: 'setsid=1\nmkfifo=1\ntmux=0\nscreen=0\n', stderr: '', exitCode: 0 };
      }
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('$HOME/.loombox/supervisor')) {
        return { stdout: '/home/u/.loombox/supervisor', stderr: '', exitCode: 0 };
      }
      if (command.includes('VERSION')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const result = await provision(TARGET, {
      transportFactory: () => new FakeTransport({ onExec: handler }),
      store,
      runtime: { skip: true },
      supervisor: { artifactSource: source, targetVersion: '1.0.0', publicKey: publicKeyRaw },
      residentNode: { config: RESIDENT_NODE_CONFIG },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('supervisor_install');
    expect(result.steps.map((s) => s.step)).toEqual([
      'verify_and_persist',
      'runtime_bootstrap',
      'supervisor_install',
    ]);
    const runtimeStep = result.steps[1];
    if (runtimeStep?.step === 'runtime_bootstrap') expect(runtimeStep.skipped).toBe(true);
  });

  it('reports onProgress once per step, in order, with the same objects that land in the result', async () => {
    const attacker = generateEd25519Pair();
    const { publicKeyRaw } = generateEd25519Pair();
    const { source } = signedArtifactSource(attacker.privateKey);
    const progressSteps: string[] = [];

    const handler: FakeExecHandler = (command) => {
      if (command.includes('command -v "$c"')) {
        return { stdout: 'setsid=1\nmkfifo=1\ntmux=0\nscreen=0\n', stderr: '', exitCode: 0 };
      }
      if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
      if (command.includes('VERSION')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const result = await provision(TARGET, {
      transportFactory: () => new FakeTransport({ onExec: handler }),
      store,
      runtime: { skip: true },
      supervisor: { artifactSource: source, targetVersion: '1.0.0', publicKey: publicKeyRaw },
      residentNode: { config: RESIDENT_NODE_CONFIG },
      onProgress: (step) => progressSteps.push(step.step),
    });

    expect(progressSteps).toEqual(result.steps.map((s) => s.step));
    expect(progressSteps).toEqual([
      'verify_and_persist',
      'runtime_bootstrap',
      'supervisor_install',
    ]);
  });
});

/**
 * Wraps a real `LocalProcessTransport` so `mkdir`/`printf`/`cat`/`base64`
 * genuinely touch disk (proving the staged artifact and generated unit land
 * for real) while intercepting anything that would mutate this devbox's own
 * real systemd user session — the same convention `systemd-provisioning
 * .test.ts`'s `RealFileFakeSystemctlTransport` and `decommission.test.ts`
 * use, generalized to let a test inject either a success stub or a synthetic
 * failure per command.
 */
class InterceptingLocalTransport implements RemoteTransport {
  readonly interceptedCommands: string[] = [];
  private readonly inner = new LocalProcessTransport();

  constructor(private readonly intercept: (command: string) => RemoteExecResult | undefined) {}

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  async exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
    const override = this.intercept(command);
    if (override) {
      this.interceptedCommands.push(command);
      return override;
    }
    return this.inner.exec(command, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

function systemctlStub(command: string): RemoteExecResult | undefined {
  if (command.startsWith('systemctl --user') || command.startsWith('loginctl enable-linger')) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  return undefined;
}

describe('provision (issue #400) — real file I/O + idempotent re-run', () => {
  it('runs all four steps in order end to end, installs for real, and a second run is idempotent (noop)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-provision-home-'));
    try {
      const supervisorBaseDir = join(homeDir, '.loombox', 'supervisor');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      const { privateKey, publicKeyRaw } = generateEd25519Pair();
      const { source } = signedArtifactSource(privateKey);

      const firstResult = await provision(TARGET, {
        transportFactory: () => new InterceptingLocalTransport(systemctlStub),
        store,
        runtime: { skip: true },
        supervisor: {
          artifactSource: source,
          targetVersion: '1.0.0',
          publicKey: publicKeyRaw,
          baseDir: supervisorBaseDir,
        },
        residentNode: { config: { ...RESIDENT_NODE_CONFIG, unitDir } },
      });

      expect(firstResult.ok).toBe(true);
      expect(firstResult.steps.map((s) => s.step)).toEqual([
        'verify_and_persist',
        'runtime_bootstrap',
        'supervisor_install',
        'resident_node_install',
      ]);

      const supervisorStep = firstResult.steps.find((s) => s.step === 'supervisor_install');
      const residentNodeStep = firstResult.steps.find((s) => s.step === 'resident_node_install');
      if (
        supervisorStep?.step !== 'supervisor_install' ||
        residentNodeStep?.step !== 'resident_node_install'
      ) {
        throw new Error('expected both steps to be present');
      }
      expect(supervisorStep.plan.action).toBe('install');
      expect(residentNodeStep.installed).toBe(true);
      expect(residentNodeStep.plan?.action).toBe('install');

      // The generated unit's ExecStart is the just-staged supervisor
      // binary, invoked as the resident node, with the real relay URL and
      // auth carried through as Environment= lines.
      const desiredContent = residentNodeStep.plan?.desiredContent ?? '';
      expect(desiredContent).toContain(`ExecStart=${supervisorBaseDir}/supervisor-bin --node`);
      expect(desiredContent).toContain('Environment=LOOMBOX_RELAY_URL=wss://relay.loombox.dev');
      expect(desiredContent).toContain('Environment=LOOMBOX_NODE_ID=devbox-1');
      expect(desiredContent).toContain('Environment=LOOMBOX_AUTH_TOKEN=token-abc');

      // Re-running against the same target is a no-op on both remaining
      // steps (issue #400's "idempotent/re-runnable").
      const secondResult = await provision(TARGET, {
        transportFactory: () => new InterceptingLocalTransport(systemctlStub),
        store,
        runtime: { skip: true },
        supervisor: {
          artifactSource: source,
          targetVersion: '1.0.0',
          publicKey: publicKeyRaw,
          baseDir: supervisorBaseDir,
        },
        residentNode: { config: { ...RESIDENT_NODE_CONFIG, unitDir } },
      });

      expect(secondResult.ok).toBe(true);
      const secondSupervisorStep = secondResult.steps.find((s) => s.step === 'supervisor_install');
      const secondResidentNodeStep = secondResult.steps.find(
        (s) => s.step === 'resident_node_install',
      );
      if (
        secondSupervisorStep?.step !== 'supervisor_install' ||
        secondResidentNodeStep?.step !== 'resident_node_install'
      ) {
        throw new Error('expected both steps to be present');
      }
      expect(secondSupervisorStep.plan.action).toBe('noop');
      expect(secondResidentNodeStep.plan?.action).toBe('noop');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('stops at resident_node_install on a genuine systemctl failure, after supervisor already installed for real', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-provision-fail-home-'));
    try {
      const supervisorBaseDir = join(homeDir, '.loombox', 'supervisor');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      const { privateKey, publicKeyRaw } = generateEd25519Pair();
      const { source } = signedArtifactSource(privateKey);

      const result = await provision(TARGET, {
        transportFactory: () =>
          new InterceptingLocalTransport((command) => {
            if (command.startsWith('systemctl --user enable --now')) {
              return { stdout: '', stderr: 'synthetic systemctl failure', exitCode: 1 };
            }
            return systemctlStub(command);
          }),
        store,
        runtime: { skip: true },
        supervisor: {
          artifactSource: source,
          targetVersion: '1.0.0',
          publicKey: publicKeyRaw,
          baseDir: supervisorBaseDir,
        },
        residentNode: { config: { ...RESIDENT_NODE_CONFIG, unitDir } },
      });

      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe('resident_node_install');
      expect(result.steps.map((s) => s.step)).toEqual([
        'verify_and_persist',
        'runtime_bootstrap',
        'supervisor_install',
        'resident_node_install',
      ]);
      const supervisorStep = result.steps.find((s) => s.step === 'supervisor_install');
      if (supervisorStep?.step === 'supervisor_install') expect(supervisorStep.ok).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('treats a host with no systemd --user as a soft, non-failing outcome (SPEC §7.23 "declining leaves the target fully usable")', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-provision-unsupported-home-'));
    try {
      const supervisorBaseDir = join(homeDir, '.loombox', 'supervisor');
      const { privateKey, publicKeyRaw } = generateEd25519Pair();
      const { source } = signedArtifactSource(privateKey);

      const result = await provision(TARGET, {
        transportFactory: () =>
          new InterceptingLocalTransport((command) => {
            if (command.includes('command -v systemctl')) {
              return { stdout: 'missing\n', stderr: '', exitCode: 0 };
            }
            return systemctlStub(command);
          }),
        store,
        runtime: { skip: true },
        supervisor: {
          artifactSource: source,
          targetVersion: '1.0.0',
          publicKey: publicKeyRaw,
          baseDir: supervisorBaseDir,
        },
        residentNode: { config: RESIDENT_NODE_CONFIG },
      });

      expect(result.ok).toBe(true);
      const residentNodeStep = result.steps.find((s) => s.step === 'resident_node_install');
      if (residentNodeStep?.step !== 'resident_node_install') throw new Error('missing step');
      expect(residentNodeStep.ok).toBe(true);
      expect(residentNodeStep.installed).toBe(false);
      expect(residentNodeStep.plan?.action).toBe('unsupported');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('skips runtime bootstrap and resident-node install outright when the caller declines both', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'loombox-provision-skip-home-'));
    try {
      const supervisorBaseDir = join(homeDir, '.loombox', 'supervisor');
      const { privateKey, publicKeyRaw } = generateEd25519Pair();
      const { source } = signedArtifactSource(privateKey);

      const result = await provision(TARGET, {
        transportFactory: () => new InterceptingLocalTransport(systemctlStub),
        store,
        runtime: { skip: true },
        supervisor: {
          artifactSource: source,
          targetVersion: '1.0.0',
          publicKey: publicKeyRaw,
          baseDir: supervisorBaseDir,
        },
        residentNode: { skip: true, config: RESIDENT_NODE_CONFIG },
      });

      expect(result.ok).toBe(true);
      const runtimeStep = result.steps.find((s) => s.step === 'runtime_bootstrap');
      const residentNodeStep = result.steps.find((s) => s.step === 'resident_node_install');
      if (
        runtimeStep?.step !== 'runtime_bootstrap' ||
        residentNodeStep?.step !== 'resident_node_install'
      ) {
        throw new Error('missing steps');
      }
      expect(runtimeStep.skipped).toBe(true);
      expect(residentNodeStep.skipped).toBe(true);
      expect(residentNodeStep.installed).toBe(false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('decommission (issue #400)', () => {
  it('opens a transport, decommissions the target, and always closes the transport', async () => {
    store.save(TARGET);
    let connected = false;
    let closed = false;
    const calls: string[] = [];
    const transport = new FakeTransport({
      onExec: (command) => {
        calls.push(command);
        if (command.includes('uname')) return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
        if (command.includes('command -v systemctl')) {
          return { stdout: 'present\n', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('cat ')) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const originalConnect = transport.connect.bind(transport);
    const originalClose = transport.close.bind(transport);
    transport.connect = async () => {
      connected = true;
      await originalConnect();
    };
    transport.close = async () => {
      closed = true;
      await originalClose();
    };

    const result = await decommission(TARGET, { transportFactory: () => transport, store });

    expect(connected).toBe(true);
    expect(closed).toBe(true);
    expect(result.deviceKeyRevoked).toBe(true);
    expect(store.get(TARGET.id)).toBeUndefined();
  });

  it('closes the transport even when decommissionSshTarget throws', async () => {
    store.save(TARGET);
    let closed = false;
    const transport = new FakeTransport({
      onExec: () => {
        throw new Error('boom');
      },
    });
    const originalClose = transport.close.bind(transport);
    transport.close = async () => {
      closed = true;
      await originalClose();
    };

    await expect(
      decommission(TARGET, { transportFactory: () => transport, store }),
    ).rejects.toThrow('boom');
    expect(closed).toBe(true);
  });
});

// Real-sshd integration (issue #400's acceptance: an orchestration test
// drives the full chain against the Dockerized sshd fixture). The fixture
// (Alpine, see docker-sshd-fixture.ts's doc comment) bakes in a fake `mise`
// whose `activate` output is the only thing that puts a `node` shim on
// `PATH` — `wrapForLoginShell` (`./login-shell.ts`) applies that activation
// unconditionally to every command `Ssh2Transport` sends, so `node` is
// genuinely resolvable here and step 2 (runtime bootstrap) is a real `noop`,
// proving that PATH fix rather than needing to be skipped. `curl` is
// deliberately absent (no mise/Node install actually needed if `node`
// already resolves) and there is no real systemd/pid1 (sshd itself execs as
// PID 1, so step 4 honestly reports `unsupported`) — the same limitations
// `systemd-provisioning.test.ts`/`decommission.test.ts`'s own Docker tests
// already work with, not something introduced here.
const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('provision (Dockerized sshd fixture, issue #400)', () => {
  let fixture: DockerSshdFixture;

  beforeAll(async () => {
    fixture = await startDockerSshdFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.stop();
  }, 30_000);

  function fixtureTarget(id: string): SshTargetConfig {
    return {
      id,
      label: 'Fixture',
      host: fixture.host,
      port: fixture.port,
      user: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
    };
  }

  function fixtureTransportFactory(): RemoteTransport {
    return new Ssh2Transport({
      host: fixture.host,
      port: fixture.port,
      username: fixture.username,
      privateKeyPath: fixture.privateKeyPath,
    });
  }

  it('stops at supervisor_install over a real SSH connection when the fetched artifact fails signature verification, never reaching resident-node install', async () => {
    const target = fixtureTarget('fixture-supervisor-fail');
    const attacker = generateEd25519Pair();
    const { publicKeyRaw } = generateEd25519Pair();
    const { source } = signedArtifactSource(attacker.privateKey);

    const result = await provision(target, {
      transportFactory: fixtureTransportFactory,
      store,
      supervisor: { artifactSource: source, targetVersion: '1.0.0', publicKey: publicKeyRaw },
      residentNode: { config: RESIDENT_NODE_CONFIG },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('supervisor_install');
    expect(result.steps.map((s) => s.step)).toEqual([
      'verify_and_persist',
      'runtime_bootstrap',
      'supervisor_install',
    ]);
    const verifyStep = result.steps[0];
    if (verifyStep?.step === 'verify_and_persist') expect(verifyStep.ok).toBe(true);
    const runtimeStep = result.steps[1];
    // Genuinely a noop over the real fixture: `node` already resolves via
    // its baked-in fake mise shim (wrapForLoginShell's PATH fix), so nothing
    // needed installing.
    if (runtimeStep?.step === 'runtime_bootstrap') {
      expect(runtimeStep.skipped).toBe(false);
      expect(runtimeStep.plan?.action).toBe('noop');
    }
  }, 60_000);

  it('runs all four steps in order over a real SSH connection: verifies, bootstraps the runtime for real (a genuine noop), stages the signed supervisor artifact, and reports the resident-node unit content with the real ExecStart/relay URL, honestly declining systemd install (no systemd on this fixture)', async () => {
    const target = fixtureTarget('fixture-full-chain');
    const { privateKey, publicKeyRaw } = generateEd25519Pair();
    const { source } = signedArtifactSource(privateKey);
    const progressSteps: string[] = [];

    const result = await provision(target, {
      transportFactory: fixtureTransportFactory,
      store,
      supervisor: { artifactSource: source, targetVersion: '1.0.0', publicKey: publicKeyRaw },
      residentNode: { config: RESIDENT_NODE_CONFIG },
      onProgress: (step) => progressSteps.push(step.step),
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      'verify_and_persist',
      'runtime_bootstrap',
      'supervisor_install',
      'resident_node_install',
    ]);
    expect(progressSteps).toEqual(result.steps.map((s) => s.step));

    const runtimeStep = result.steps.find((s) => s.step === 'runtime_bootstrap');
    if (runtimeStep?.step !== 'runtime_bootstrap') throw new Error('missing step');
    expect(runtimeStep.skipped).toBe(false);
    expect(runtimeStep.plan?.action).toBe('noop');
    expect(runtimeStep.plan?.nodePresent).toBe(true);

    const supervisorStep = result.steps.find((s) => s.step === 'supervisor_install');
    if (supervisorStep?.step !== 'supervisor_install') throw new Error('missing step');
    expect(supervisorStep.ok).toBe(true);
    expect(supervisorStep.plan.action).toBe('install');
    expect(supervisorStep.result.installedVersion).toBe('1.0.0');

    const residentNodeStep = result.steps.find((s) => s.step === 'resident_node_install');
    if (residentNodeStep?.step !== 'resident_node_install') throw new Error('missing step');
    expect(residentNodeStep.ok).toBe(true);
    // Honest: this Alpine fixture has no real systemd (sshd itself execs as
    // PID 1) — installed stays false, but the plan still carries the exact
    // unit content that *would* have been written.
    expect(residentNodeStep.installed).toBe(false);
    expect(residentNodeStep.plan?.action).toBe('unsupported');

    const desiredContent = residentNodeStep.plan?.desiredContent ?? '';
    expect(desiredContent).toContain(
      `ExecStart=${supervisorStep.plan.baseDir}/supervisor-bin --node`,
    );
    expect(desiredContent).toContain(
      `Environment=LOOMBOX_RELAY_URL=${RESIDENT_NODE_CONFIG.relayUrl}`,
    );
    expect(desiredContent).toContain(`Environment=LOOMBOX_NODE_ID=${RESIDENT_NODE_CONFIG.nodeId}`);
    expect(desiredContent).toContain(
      `Environment=LOOMBOX_AUTH_TOKEN=${RESIDENT_NODE_CONFIG.authToken}`,
    );

    // Cleanup: decommission with removeFiles so the fixture's staged files
    // don't leak (the fixture container itself is torn down in afterAll
    // regardless, but this exercises the decommission() wrapper for real).
    const decommissionResult = await decommission(target, {
      transportFactory: fixtureTransportFactory,
      store,
      supervisorBaseDir: supervisorStep.plan.baseDir,
      removeFiles: true,
    });
    expect(decommissionResult.filesRemoved).toBe(true);
    expect(store.get(target.id)).toBeUndefined();
  }, 60_000);
});
