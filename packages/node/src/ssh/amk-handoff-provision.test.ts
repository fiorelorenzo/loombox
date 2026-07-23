import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportPublicKeyRaw,
  generateAmk,
  generateEcdhKeyPair,
  unpackAmkHandoffFromFile,
  unwrapAmkForNodeHandoff,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { adoptWrappedAmkFromFile } from '../amk-handoff-file';
import { FakeTransport } from './fake-transport';
import { LocalProcessTransport } from './local-process-transport';
import {
  DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME,
  resolveWrappedAmkHandoffPath,
  writeWrappedAmkHandoff,
  type AmkHandoffActingIdentity,
} from './amk-handoff-provision';

async function toActingIdentity(keyPair: EcdhKeyPair): Promise<AmkHandoffActingIdentity> {
  return { keyPair, publicKeyRaw: await exportPublicKeyRaw(keyPair.publicKey) };
}

describe('resolveWrappedAmkHandoffPath', () => {
  it('returns the override unchanged when given one, without touching the transport', async () => {
    const transport = new FakeTransport();
    const path = await resolveWrappedAmkHandoffPath(transport, '/custom/path.json');
    expect(path).toBe('/custom/path.json');
    expect(transport.calls).toEqual([]);
  });

  it('resolves $HOME/.loombox/node/<default filename> on the remote when no override is given', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        expect(command).toContain(DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME);
        return {
          stdout: `/home/remote-user/.loombox/node/${DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME}`,
          stderr: '',
          exitCode: 0,
        };
      },
    });
    await transport.connect();
    const path = await resolveWrappedAmkHandoffPath(transport);
    expect(path).toBe(`/home/remote-user/.loombox/node/${DEFAULT_WRAPPED_AMK_HANDOFF_FILENAME}`);
  });
});

describe('writeWrappedAmkHandoff (issue #399, FakeTransport)', () => {
  it('runs mkdir -p, writes the packed content, and chmods 600, in order', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const actingIdentity = await toActingIdentity(provisioner);

    let script = '';
    const transport = new FakeTransport({
      onExec: (command) => {
        script = command;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    await transport.connect();

    const result = await writeWrappedAmkHandoff(transport, {
      amk: generateAmk(),
      accountId: 'acct-1',
      actingIdentity,
      targetDeviceId: 'node-fresh',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath: '/home/remote-user/.loombox/node/wrapped-amk-handoff.json',
    });

    expect(result.ok).toBe(true);
    expect(result.remotePath).toBe('/home/remote-user/.loombox/node/wrapped-amk-handoff.json');
    expect(script).toContain("mkdir -p '/home/remote-user/.loombox/node'");
    expect(script).toContain("> '/home/remote-user/.loombox/node/wrapped-amk-handoff.json'");
    expect(script).toContain(
      "chmod 600 '/home/remote-user/.loombox/node/wrapped-amk-handoff.json'",
    );
    // mkdir runs before the write, which runs before chmod.
    expect(script.indexOf('mkdir')).toBeLessThan(script.indexOf('printf'));
    expect(script.indexOf('printf')).toBeLessThan(script.indexOf('chmod'));
  });

  it('reports failure with the remote stderr when the write script exits non-zero', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const actingIdentity = await toActingIdentity(provisioner);

    const transport = new FakeTransport({
      onExec: () => ({ stdout: '', stderr: 'Permission denied', exitCode: 1 }),
    });
    await transport.connect();

    const result = await writeWrappedAmkHandoff(transport, {
      amk: generateAmk(),
      accountId: 'acct-1',
      actingIdentity,
      targetDeviceId: 'node-fresh',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath: '/root/wrapped-amk-handoff.json',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Permission denied');
  });
});

describe('writeWrappedAmkHandoff (issue #399, LocalProcessTransport — real file I/O)', () => {
  let dir: string;
  let transport: LocalProcessTransport;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loombox-amk-handoff-provision-'));
    transport = new LocalProcessTransport();
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a real file at 0600 whose packed content round-trips via @loombox/crypto', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const actingIdentity = await toActingIdentity(provisioner);
    const amk = generateAmk();
    const remotePath = join(dir, 'wrapped-amk-handoff.json');

    // Start from a looser permission to prove the function actually
    // tightens it, not just that a fresh file happens to land at 0600.
    const result = await writeWrappedAmkHandoff(transport, {
      amk,
      epoch: 2,
      accountId: 'acct-1',
      actingIdentity,
      targetDeviceId: 'node-fresh',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(remotePath)).toBe(true);
    expect(statSync(remotePath).mode & 0o777).toBe(0o600);

    const raw = readFileSync(remotePath, 'utf8');
    const blob = unpackAmkHandoffFromFile(raw);
    expect(blob.epoch).toBe(2);
    expect(Array.from(blob.actingDevicePublicKeyRaw)).toEqual(
      Array.from(actingIdentity.publicKeyRaw),
    );

    const unwrapped = await unwrapAmkForNodeHandoff({
      envelope: blob.envelope,
      epoch: blob.epoch,
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      targetPrivateKey: target.privateKey,
      actingDevicePublicKeyRaw: blob.actingDevicePublicKeyRaw,
    });
    expect(Array.from(unwrapped)).toEqual(Array.from(amk));
  });

  it('creates parent directories that do not exist yet', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const actingIdentity = await toActingIdentity(provisioner);
    const remotePath = join(dir, 'nested', 'state', 'wrapped-amk-handoff.json');

    const result = await writeWrappedAmkHandoff(transport, {
      amk: generateAmk(),
      accountId: 'acct-1',
      actingIdentity,
      targetDeviceId: 'node-fresh',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(remotePath)).toBe(true);
  });

  it('overwrites an existing file at the target path and still ends up 0600', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const actingIdentity = await toActingIdentity(provisioner);
    const remotePath = join(dir, 'wrapped-amk-handoff.json');

    await writeWrappedAmkHandoff(transport, {
      amk: generateAmk(),
      accountId: 'acct-1',
      actingIdentity,
      targetDeviceId: 'node-fresh',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath,
    });
    chmodSync(remotePath, 0o644);

    const result = await writeWrappedAmkHandoff(transport, {
      amk: generateAmk(),
      accountId: 'acct-1',
      actingIdentity,
      targetDeviceId: 'node-fresh',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath,
    });

    expect(result.ok).toBe(true);
    expect(statSync(remotePath).mode & 0o777).toBe(0o600);
  });
});

describe('provisioner -> receiver integration (issue #399)', () => {
  let dir: string;
  let transport: LocalProcessTransport;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loombox-amk-handoff-integration-'));
    transport = new LocalProcessTransport();
    await transport.connect();
  });

  afterEach(async () => {
    await transport.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a node provisioned with a wrapped-AMK file recovers the exact same AMK the provisioner held', async () => {
    // The provisioner: an already-unlocked acting device holding the
    // account's real AMK.
    const provisioner = await generateEcdhKeyPair();
    const actingIdentity = await toActingIdentity(provisioner);
    const amk = generateAmk();

    // The freshly-provisioned target node: already generated its own
    // identity (`identity.ts`'s `NodeIdentityStore`) and reported its
    // pubkey out of band, before this handoff runs.
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);

    const remotePath = join(dir, 'wrapped-amk-handoff.json');

    const writeResult = await writeWrappedAmkHandoff(transport, {
      amk,
      accountId: 'acct-integration',
      actingIdentity,
      targetDeviceId: 'node-integration',
      targetDevicePublicKeyRaw: targetPublicKeyRaw,
      remotePath,
    });
    expect(writeResult.ok).toBe(true);

    // The resident node's own first start (LOOMBOX_WRAPPED_AMK_FILE points
    // at exactly the path the provisioner wrote to — see
    // `provision-target.ts`'s `ResidentNodeConfig.wrappedAmkFilePath`).
    const adopted = await adoptWrappedAmkFromFile({
      filePath: remotePath,
      accountId: 'acct-integration',
      targetDeviceId: 'node-integration',
      identity: { keyPair: target },
    });

    expect(Array.from(adopted)).toEqual(Array.from(amk));
    // Consumed exactly once.
    expect(existsSync(remotePath)).toBe(false);
    await expect(
      adoptWrappedAmkFromFile({
        filePath: remotePath,
        accountId: 'acct-integration',
        targetDeviceId: 'node-integration',
        identity: { keyPair: target },
      }),
    ).rejects.toThrow(/not found/);
  });
});
