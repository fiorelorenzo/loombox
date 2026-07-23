import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportPublicKeyRaw,
  generateAmk,
  generateEcdhKeyPair,
  packAmkHandoffForFile,
  wrapAmkForNodeHandoff,
  type EcdhKeyPair,
} from '@loombox/crypto';

import { adoptWrappedAmkFromFile, type WrappedAmkFileIdentity } from './amk-handoff-file';
import { ConfigError } from './config';

async function writeHandoffFile(
  filePath: string,
  options: {
    amk: Uint8Array;
    accountId: string;
    targetDeviceId: string;
    provisioner: EcdhKeyPair;
    targetPublicKeyRaw: Uint8Array;
    epoch?: number;
  },
): Promise<void> {
  const envelope = await wrapAmkForNodeHandoff({
    amk: options.amk,
    epoch: options.epoch,
    accountId: options.accountId,
    targetDeviceId: options.targetDeviceId,
    actingPrivateKey: options.provisioner.privateKey,
    targetDevicePublicKeyRaw: options.targetPublicKeyRaw,
  });
  const raw = packAmkHandoffForFile({
    epoch: options.epoch ?? 0,
    actingDevicePublicKeyRaw: await exportPublicKeyRaw(options.provisioner.publicKey),
    envelope,
  });
  writeFileSync(filePath, raw, { mode: 0o600 });
}

describe('adoptWrappedAmkFromFile (issue #399)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loombox-amk-handoff-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads, unwraps, adopts, and deletes the one-shot file on success', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const amk = generateAmk();
    const filePath = join(dir, 'wrapped-amk-handoff.json');

    await writeHandoffFile(filePath, {
      amk,
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      provisioner,
      targetPublicKeyRaw,
    });
    expect(existsSync(filePath)).toBe(true);

    const identity: WrappedAmkFileIdentity = { keyPair: target };
    const adopted = await adoptWrappedAmkFromFile({
      filePath,
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      identity,
    });

    expect(Array.from(adopted)).toEqual(Array.from(amk));
    expect(existsSync(filePath)).toBe(false);
  });

  it('adopts a handoff bound to a non-zero epoch', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const amk = generateAmk();
    const filePath = join(dir, 'wrapped-amk-handoff.json');

    await writeHandoffFile(filePath, {
      amk,
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      provisioner,
      targetPublicKeyRaw,
      epoch: 3,
    });

    const adopted = await adoptWrappedAmkFromFile({
      filePath,
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      identity: { keyPair: target },
    });

    expect(Array.from(adopted)).toEqual(Array.from(amk));
  });

  it('throws ConfigError when the file does not exist', async () => {
    const target = await generateEcdhKeyPair();
    await expect(
      adoptWrappedAmkFromFile({
        filePath: join(dir, 'missing.json'),
        accountId: 'acct-1',
        targetDeviceId: 'node-fresh',
        identity: { keyPair: target },
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('leaves a corrupt file in place and throws ConfigError, rather than deleting it', async () => {
    const target = await generateEcdhKeyPair();
    const filePath = join(dir, 'wrapped-amk-handoff.json');
    writeFileSync(filePath, '{not valid json', { mode: 0o600 });

    await expect(
      adoptWrappedAmkFromFile({
        filePath,
        accountId: 'acct-1',
        targetDeviceId: 'node-fresh',
        identity: { keyPair: target },
      }),
    ).rejects.toThrow(ConfigError);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('{not valid json');
  });

  it('leaves the file in place and throws a clear ConfigError when unwrapped with the wrong device key', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const wrongDevice = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const filePath = join(dir, 'wrapped-amk-handoff.json');

    await writeHandoffFile(filePath, {
      amk: generateAmk(),
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      provisioner,
      targetPublicKeyRaw,
    });

    await expect(
      adoptWrappedAmkFromFile({
        filePath,
        accountId: 'acct-1',
        targetDeviceId: 'node-fresh',
        identity: { keyPair: wrongDevice },
      }),
    ).rejects.toThrow(/could not unwrap/);

    expect(existsSync(filePath)).toBe(true);
  });

  it('rejects when accountId does not match what the file was wrapped for', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const filePath = join(dir, 'wrapped-amk-handoff.json');

    await writeHandoffFile(filePath, {
      amk: generateAmk(),
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      provisioner,
      targetPublicKeyRaw,
    });

    await expect(
      adoptWrappedAmkFromFile({
        filePath,
        accountId: 'acct-WRONG',
        targetDeviceId: 'node-fresh',
        identity: { keyPair: target },
      }),
    ).rejects.toThrow(ConfigError);
    expect(existsSync(filePath)).toBe(true);
  });

  it('rejects when targetDeviceId does not match what the file was wrapped for', async () => {
    const provisioner = await generateEcdhKeyPair();
    const target = await generateEcdhKeyPair();
    const targetPublicKeyRaw = await exportPublicKeyRaw(target.publicKey);
    const filePath = join(dir, 'wrapped-amk-handoff.json');

    await writeHandoffFile(filePath, {
      amk: generateAmk(),
      accountId: 'acct-1',
      targetDeviceId: 'node-fresh',
      provisioner,
      targetPublicKeyRaw,
    });

    await expect(
      adoptWrappedAmkFromFile({
        filePath,
        accountId: 'acct-1',
        targetDeviceId: 'node-OTHER',
        identity: { keyPair: target },
      }),
    ).rejects.toThrow(ConfigError);
    expect(existsSync(filePath)).toBe(true);
  });
});
