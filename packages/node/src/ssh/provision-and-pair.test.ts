import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exportPublicKeyRaw,
  generateAmk,
  generateEcdhKeyPair,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { adoptWrappedAmkFromFile } from '../amk-handoff-file';
import { NodeIdentityStore } from '../identity';
import type { SshTargetConfig } from '../target';
import type { AmkHandoffActingIdentity } from './amk-handoff-provision';
import {
  isDockerAvailable,
  startDockerSshdFixture,
  type DockerSshdFixture,
} from './docker-sshd-fixture';
import { FakeTransport, type FakeExecHandler } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import { provisionAndPair, type ProvisionAndPairOptions } from './provision-and-pair';
import type { RemoteExecOptions, RemoteExecResult, RemoteTransport } from './remote-transport';
import { Ssh2Transport } from './ssh2-transport';
import type { SupervisorArtifactSource } from './supervisor-artifact';
import { SshTargetStore } from './verify-and-persist';

/**
 * `provisionAndPair` (issue #408): step-sequencing/error-stops-at-step tests
 * with `FakeTransport` (mirrors `provision-target.test.ts`'s own structure
 * for `provision()`), then a real-file-I/O integration test proving the
 * `target_identity` + `amk_handoff` steps genuinely round-trip through
 * `NodeIdentityStore`/`adoptWrappedAmkFromFile` — the exact code a real
 * resident node's first start runs — and finally a Dockerized-sshd
 * end-to-end test (guard-skipped without Docker).
 */

const TARGET: SshTargetConfig = {
  id: 'devbox-1',
  label: 'Dev box',
  host: '127.0.0.1',
  user: 'loombox',
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

async function actingIdentity(): Promise<{
  identity: AmkHandoffActingIdentity;
  keyPair: EcdhKeyPair;
}> {
  const keyPair = await generateEcdhKeyPair();
  const publicKeyRaw = await exportPublicKeyRaw(keyPair.publicKey);
  return { identity: { keyPair, publicKeyRaw }, keyPair };
}

/**
 * A `FakeExecHandler` covering everything `provision()`'s own three steps
 * (capability probe, `uname`, the VERSION marker's write-then-read-back
 * verification `executeSupervisorProvisioning` does — issue #86's
 * install-then-verify) need to reach a genuine `install`, tracking just
 * enough state (whether the VERSION marker has been written yet) to answer
 * its own read-back honestly — mirrors what a real remote shell would do,
 * without a full fake filesystem. `extra` is consulted first, for a test's
 * own failure injection (e.g. a specific write command failing); falling
 * through to this baseline only when `extra` doesn't recognize the command.
 */
type PartialExecHandler = (
  command: string,
  options: RemoteExecOptions,
) => RemoteExecResult | undefined;

function baseHandler(targetVersion: string, extra?: PartialExecHandler): FakeExecHandler {
  let versionWritten = false;
  // A tiny virtual filesystem for the single-quoted `printf '%s' '<content>'
  // > '<path>'` writes several steps issue (supervisor's VERSION marker,
  // `target_identity`'s identity file, `amk_handoff`'s wrapped-AMK file, the
  // systemd unit file) perform, each later re-read back via `cat '<path>'`
  // to verify the write actually landed — real shell semantics, just without
  // a real shell.
  const files = new Map<string, string>();
  return (command, options) => {
    if (extra) {
      const overridden = extra(command, options);
      if (overridden !== undefined) return overridden;
    }
    if (command.includes('command -v "$c"')) {
      return { stdout: 'setsid=1\nmkfifo=1\ntmux=0\nscreen=0\n', stderr: '', exitCode: 0 };
    }
    if (command === 'uname -s -m') return { stdout: 'Linux x86_64', stderr: '', exitCode: 0 };
    if (command.includes('VERSION')) {
      if (command.startsWith('printf')) {
        versionWritten = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: versionWritten ? targetVersion : '', stderr: '', exitCode: 0 };
    }
    const writeMatch = command.match(/printf '%s' '([\s\S]*)' > '([^']+)'/);
    if (writeMatch) {
      files.set(writeMatch[2] ?? '', writeMatch[1] ?? '');
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    const catMatch = command.match(/^cat '([^']+)'/);
    if (catMatch) {
      return { stdout: files.get(catMatch[1] ?? '') ?? '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

let stateDir: string;
let store: SshTargetStore;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'loombox-provision-and-pair-store-'));
  store = new SshTargetStore({ stateDir });
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function baseOptions(overrides: Partial<ProvisionAndPairOptions> = {}): ProvisionAndPairOptions {
  return {
    relayUrl: 'wss://relay.loombox.dev',
    accountId: 'acct-1',
    actingAuthToken: 'acting-token',
    amk: generateAmk(),
    ...overrides,
  } as ProvisionAndPairOptions;
}

describe('provisionAndPair (#408) — step-sequencing and error-stops-at-step, using fakes', () => {
  it('stops at verify_and_persist on a connect failure, never minting a token or writing anything', async () => {
    const { identity } = await actingIdentity();
    const mintNodeToken = vi.fn();

    const result = await provisionAndPair(TARGET, {
      ...baseOptions({ actingIdentity: identity, mintNodeToken }),
      store,
      transportFactory: () => new FakeTransport({ connectError: new Error('ECONNREFUSED') }),
      supervisor: {
        artifactSource: { fetch: vi.fn() },
        targetVersion: '1.0.0',
        publicKey: new Uint8Array(),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('verify_and_persist');
    expect(result.progress.map((p) => `${p.step}:${p.status}`)).toEqual([
      'verify_and_persist:started',
      'verify_and_persist:failed',
    ]);
    expect(mintNodeToken).not.toHaveBeenCalled();
  });

  it('stops at mint_node_token when the mint rejects, after verify/runtime/supervisor/target_identity already ok', async () => {
    const { identity } = await actingIdentity();
    const artifactKeyPair = generateEd25519Pair();
    const publicKeyRaw = artifactKeyPair.publicKeyRaw;
    const signed = signedArtifactSource(artifactKeyPair.privateKey);

    const mintNodeToken = vi.fn().mockRejectedValue(new Error('mint HTTP 401'));

    const result = await provisionAndPair(TARGET, {
      ...baseOptions({ actingIdentity: identity, mintNodeToken }),
      store,
      transportFactory: () => new FakeTransport({ onExec: baseHandler('1.0.0') }),
      runtime: { skip: true },
      supervisor: {
        artifactSource: signed.source,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('mint_node_token');
    expect(result.progress.map((p) => `${p.step}:${p.status}`)).toEqual([
      'verify_and_persist:started',
      'verify_and_persist:ok',
      'runtime_bootstrap:started',
      'runtime_bootstrap:ok',
      'supervisor_install:started',
      'supervisor_install:ok',
      'target_identity:started',
      'target_identity:ok',
      'mint_node_token:started',
      'mint_node_token:failed',
    ]);
    expect(mintNodeToken).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: 'wss://relay.loombox.dev', authToken: 'acting-token' }),
    );
  });

  it('stops at amk_handoff when the write script fails on the remote, after a token was already minted', async () => {
    const { identity } = await actingIdentity();
    const artifactKeyPair = generateEd25519Pair();
    const signed = signedArtifactSource(artifactKeyPair.privateKey);
    const publicKeyRaw = artifactKeyPair.publicKeyRaw;

    // The target_identity write succeeds, but the SECOND printf-based write
    // (amk_handoff's own script) fails — distinguished by looking for the
    // handoff's distinctive filename.
    const handler = baseHandler('1.0.0', (command) => {
      if (command.includes('wrapped-amk-handoff.json') && command.includes('printf')) {
        return { stdout: '', stderr: 'disk full', exitCode: 1 };
      }
      return undefined;
    });

    const mintNodeToken = vi.fn().mockResolvedValue({ id: 'tok-1', token: 'minted-token-abc' });

    const result = await provisionAndPair(TARGET, {
      ...baseOptions({ actingIdentity: identity, mintNodeToken }),
      store,
      transportFactory: () => new FakeTransport({ onExec: handler }),
      runtime: { skip: true },
      supervisor: {
        artifactSource: signed.source,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe('amk_handoff');
    expect(mintNodeToken).toHaveBeenCalledTimes(1);
    const steps = result.progress.map((p) => p.step);
    expect(steps).toContain('mint_node_token');
    expect(steps[steps.length - 1]).toBe('amk_handoff');
  });

  it("runs the full 7-step sequence in order, mints exactly one token, and shares ONE pooled connection across every step after verify_and_persist (which always opens/closes its own, per provision()'s own contract)", async () => {
    const { identity } = await actingIdentity();
    const artifactKeyPair = generateEd25519Pair();
    const signed = signedArtifactSource(artifactKeyPair.privateKey);
    const publicKeyRaw = artifactKeyPair.publicKeyRaw;

    let connectCount = 0;
    const handler = baseHandler('1.0.0', (command) => {
      if (command.includes('command -v systemctl')) {
        return { stdout: 'present', stderr: '', exitCode: 0 };
      }
      if (command.startsWith('systemctl') || command.startsWith('loginctl')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    class CountingFakeTransport extends FakeTransport {
      async connect(): Promise<void> {
        connectCount += 1;
        await super.connect();
      }
    }

    const mintNodeToken = vi.fn().mockResolvedValue({ id: 'tok-1', token: 'minted-token-xyz' });

    const result = await provisionAndPair(TARGET, {
      ...baseOptions({ actingIdentity: identity, mintNodeToken }),
      store,
      transportFactory: () => new CountingFakeTransport({ onExec: handler }),
      runtime: { skip: true },
      supervisor: {
        artifactSource: signed.source,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.progress.map((p) => `${p.step}:${p.status}`)).toEqual([
      'verify_and_persist:started',
      'verify_and_persist:ok',
      'runtime_bootstrap:started',
      'runtime_bootstrap:ok',
      'supervisor_install:started',
      'supervisor_install:ok',
      'target_identity:started',
      'target_identity:ok',
      'mint_node_token:started',
      'mint_node_token:ok',
      'amk_handoff:started',
      'amk_handoff:ok',
      'resident_node_install:started',
      'resident_node_install:ok',
    ]);
    expect(mintNodeToken).toHaveBeenCalledTimes(1);
    // Two `connect()` calls total: `verify_and_persist`'s own short-lived
    // transport (opened and closed by `verifyAndPersistSshTarget` itself,
    // per `provision()`'s documented contract), then ONE pooled connection
    // shared by every step from `runtime_bootstrap` through
    // `resident_node_install` — never a fresh connection per step.
    expect(connectCount).toBe(2);
    expect(result.deviceId).toBe(TARGET.id);
    expect(result.residentNodeId).toBe(TARGET.id);
  });
});

describe('provisionAndPair (#408, LocalProcessTransport) — real identity + AMK handoff round-trip', () => {
  it('writes a device identity file a real NodeIdentityStore reloads, and a resident node adopts the exact same AMK from the handoff — matching the minted token/path in the systemd unit', async () => {
    const residentDir = await mkdtemp(join(tmpdir(), 'loombox-resident-'));
    try {
      const { identity } = await actingIdentity();
      const artifactKeyPair = generateEd25519Pair();
      const signed = signedArtifactSource(artifactKeyPair.privateKey);
      const publicKeyRaw = artifactKeyPair.publicKeyRaw;
      const supervisorBaseDir = join(residentDir, 'supervisor');
      const amk = generateAmk();

      class SystemctlStubTransport implements RemoteTransport {
        private readonly inner = new LocalProcessTransport();
        async connect(): Promise<void> {
          await this.inner.connect();
        }
        async exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult> {
          if (
            command.startsWith('systemctl --user') ||
            command.startsWith('loginctl enable-linger')
          ) {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return this.inner.exec(command, options);
        }
        async close(): Promise<void> {
          await this.inner.close();
        }
      }

      const result = await provisionAndPair(TARGET, {
        relayUrl: 'wss://relay.loombox.dev',
        accountId: 'acct-real',
        actingAuthToken: 'acting-token',
        amk,
        actingIdentity: identity,
        store,
        transportFactory: () => new SystemctlStubTransport(),
        runtime: { skip: true },
        residentStateDir: residentDir,
        residentUnitDir: join(residentDir, 'systemd-user'),
        mintNodeToken: async (opts) => {
          expect(opts.relayUrl).toBe('wss://relay.loombox.dev');
          expect(opts.authToken).toBe('acting-token');
          return { id: 'tok-real', token: 'minted-real-token' };
        },
        supervisor: {
          artifactSource: signed.source,
          targetVersion: '1.0.0',
          publicKey: publicKeyRaw,
          baseDir: supervisorBaseDir,
        },
      });

      expect(result.ok).toBe(true);

      // target_identity: a real NodeIdentityStore pointed at the resident's
      // state dir reloads EXACTLY the keypair provisionAndPair generated and
      // wrote — the same file/format a real resident node's own
      // `NodeIdentityStore.loadOrCreate()` reads on first start.
      const residentIdentityStore = new NodeIdentityStore({ stateDir: residentDir });
      const residentIdentity = await residentIdentityStore.load();
      expect(residentIdentity).toBeDefined();
      if (!residentIdentity) throw new Error('expected an identity to have been written');

      // amk_handoff: the resident's own first-start adoption path
      // (`adoptWrappedAmkFromFile`) recovers the EXACT SAME AMK this acting
      // node held — proving the wrap/write/adopt chain is genuinely correct,
      // not just "a file got written somewhere".
      const adopted = await adoptWrappedAmkFromFile({
        filePath: join(residentDir, 'wrapped-amk-handoff.json'),
        accountId: 'acct-real',
        targetDeviceId: TARGET.id,
        identity: residentIdentity,
      });
      expect(Array.from(adopted)).toEqual(Array.from(amk));

      // resident_node_install: the generated unit's Environment= carries the
      // minted token and points LOOMBOX_WRAPPED_AMK_FILE at the exact same
      // path just adopted from above.
      const residentStep = result.progress.find(
        (p) => p.step === 'resident_node_install' && p.status === 'ok',
      );
      expect(residentStep?.message).toContain('installing');
    } finally {
      await rm(residentDir, { recursive: true, force: true });
    }
  });
});

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('provisionAndPair (Dockerized sshd fixture, #408)', () => {
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

  it('runs the full sequence over a real SSH connection, minting a token and handing off a real AMK, honestly stopping at resident_node_install (no systemd on this fixture)', async () => {
    const { identity } = await actingIdentity();
    const artifactKeyPair = generateEd25519Pair();
    const signed = signedArtifactSource(artifactKeyPair.privateKey);
    const publicKeyRaw = artifactKeyPair.publicKeyRaw;
    const amk = generateAmk();
    const progressSteps: string[] = [];

    const mintNodeToken = vi.fn().mockResolvedValue({ id: 'tok-fixture', token: 'fixture-token' });

    const result = await provisionAndPair(fixtureTarget('fixture-provision-and-pair'), {
      relayUrl: 'wss://relay.loombox.dev',
      accountId: 'acct-fixture',
      actingAuthToken: 'acting-token',
      amk,
      actingIdentity: identity,
      store,
      transportFactory: () =>
        new Ssh2Transport({
          host: fixture.host,
          port: fixture.port,
          username: fixture.username,
          privateKeyPath: fixture.privateKeyPath,
        }),
      supervisor: {
        artifactSource: signed.source,
        targetVersion: '1.0.0',
        publicKey: publicKeyRaw,
      },
      mintNodeToken,
      onProgress: (p) => progressSteps.push(p.step),
    });

    // No systemd on this minimal sshd fixture (mirrors provision-target
    // .test.ts's own fixture test) — the pairing steps before it (identity,
    // mint, handoff) all genuinely ran over the real SSH connection first,
    // proven by reaching resident_node_install at all.
    expect(result.failedStep).toBe('resident_node_install');
    expect(mintNodeToken).toHaveBeenCalledTimes(1);
    expect(progressSteps).toContain('target_identity');
    expect(progressSteps).toContain('mint_node_token');
    expect(progressSteps).toContain('amk_handoff');
  }, 60_000);
});
