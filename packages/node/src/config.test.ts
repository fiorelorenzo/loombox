import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadNodeConfig } from './config';

function amkBase64(byte = 7): string {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString('base64');
}

const BASE_ENV = {
  LOOMBOX_RELAY_URL: 'wss://relay.loombox.dev',
  LOOMBOX_NODE_ID: 'devbox-node',
  LOOMBOX_AUTH_TOKEN: 'test-auth-token',
  LOOMBOX_AMK: amkBase64(),
};

describe('loadNodeConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loombox-node-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('from environment variables', () => {
    it('loads a complete valid config', () => {
      const config = loadNodeConfig({ env: BASE_ENV, argv: [] });
      expect(config.relayUrl).toBe('wss://relay.loombox.dev');
      expect(config.nodeId).toBe('devbox-node');
      expect(config.authToken).toBe('test-auth-token');
      expect(config.amk).toBeInstanceOf(Uint8Array);
      expect(config.amk).toHaveLength(32);
    });

    it('defaults deviceId to nodeId, and leaves accountId unset (issue #380: no more defaulting it to authToken)', () => {
      const config = loadNodeConfig({ env: BASE_ENV, argv: [] });
      expect(config.deviceId).toBe('devbox-node');
      expect(config.accountId).toBeUndefined();
    });

    it('honors an explicit deviceId/accountId over the defaults', () => {
      const config = loadNodeConfig({
        env: { ...BASE_ENV, LOOMBOX_DEVICE_ID: 'device-1', LOOMBOX_ACCOUNT_ID: 'acct-1' },
        argv: [],
      });
      expect(config.deviceId).toBe('device-1');
      expect(config.accountId).toBe('acct-1');
    });

    it('parses LOOMBOX_TARGETS as a JSON array of target descriptors', () => {
      const targets = [{ id: 'local', kind: 'local', label: 'Local' }];
      const config = loadNodeConfig({
        env: { ...BASE_ENV, LOOMBOX_TARGETS: JSON.stringify(targets) },
        argv: [],
      });
      expect(config.targets).toEqual(targets);
    });

    it('leaves targets undefined when LOOMBOX_TARGETS is unset', () => {
      const config = loadNodeConfig({ env: BASE_ENV, argv: [] });
      expect(config.targets).toBeUndefined();
    });

    it('rejects a config missing every required field, naming each one', () => {
      expect(() => loadNodeConfig({ env: {}, argv: [] })).toThrow(ConfigError);
      try {
        loadNodeConfig({ env: {}, argv: [] });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const message = (error as ConfigError).message;
        expect(message).toContain('LOOMBOX_RELAY_URL');
        expect(message).toContain('LOOMBOX_NODE_ID');
        expect(message).toContain('LOOMBOX_AMK');
      }
    });

    // #387: authToken is no longer required at this layer — a node with
    // neither LOOMBOX_AUTH_TOKEN nor LOOMBOX_DEVICE_TOKEN set is valid
    // config (main.ts's start() then reuses a persisted device token or
    // runs the device-login flow to obtain one).
    it('does not require LOOMBOX_AUTH_TOKEN or LOOMBOX_DEVICE_TOKEN', () => {
      const env = { ...BASE_ENV };
      delete (env as Record<string, string | undefined>).LOOMBOX_AUTH_TOKEN;
      const config = loadNodeConfig({ env, argv: [] });
      expect(config.authToken).toBeUndefined();
      expect(config.deviceToken).toBeUndefined();
    });

    it('loads deviceToken from LOOMBOX_DEVICE_TOKEN when no LOOMBOX_AUTH_TOKEN is set', () => {
      const env = { ...BASE_ENV };
      delete (env as Record<string, string | undefined>).LOOMBOX_AUTH_TOKEN;
      const config = loadNodeConfig({
        env: { ...env, LOOMBOX_DEVICE_TOKEN: 'a-device-token' },
        argv: [],
      });
      expect(config.deviceToken).toBe('a-device-token');
      expect(config.authToken).toBeUndefined();
    });

    it('authToken wins over deviceToken when both are set', () => {
      const config = loadNodeConfig({
        env: { ...BASE_ENV, LOOMBOX_DEVICE_TOKEN: 'a-device-token' },
        argv: [],
      });
      expect(config.authToken).toBe('test-auth-token');
      expect(config.deviceToken).toBeUndefined();
    });

    it('rejects a config missing only relayUrl', () => {
      const env = { ...BASE_ENV };
      delete (env as Record<string, string | undefined>).LOOMBOX_RELAY_URL;
      expect(() => loadNodeConfig({ env, argv: [] })).toThrow(/relayUrl/);
    });

    it('rejects an amk that is not 32 bytes once base64-decoded', () => {
      const env = { ...BASE_ENV, LOOMBOX_AMK: Buffer.from('too short').toString('base64') };
      expect(() => loadNodeConfig({ env, argv: [] })).toThrow(/32 bytes/);
    });

    it('loads recoveryCode from LOOMBOX_RECOVERY_CODE and leaves amk undefined when no LOOMBOX_AMK is set (issue #386)', () => {
      const env: Record<string, string> = {
        LOOMBOX_RELAY_URL: BASE_ENV.LOOMBOX_RELAY_URL,
        LOOMBOX_NODE_ID: BASE_ENV.LOOMBOX_NODE_ID,
        LOOMBOX_AUTH_TOKEN: BASE_ENV.LOOMBOX_AUTH_TOKEN,
        LOOMBOX_RECOVERY_CODE: 'ABCD-EFGH-JKMN-PQRS',
      };
      const config = loadNodeConfig({ env, argv: [] });
      expect(config.recoveryCode).toBe('ABCD-EFGH-JKMN-PQRS');
      expect(config.amk).toBeUndefined();
    });

    it('rejects a config with neither amk nor recoveryCode set', () => {
      const env: Record<string, string> = {
        LOOMBOX_RELAY_URL: BASE_ENV.LOOMBOX_RELAY_URL,
        LOOMBOX_NODE_ID: BASE_ENV.LOOMBOX_NODE_ID,
        LOOMBOX_AUTH_TOKEN: BASE_ENV.LOOMBOX_AUTH_TOKEN,
      };
      expect(() => loadNodeConfig({ env, argv: [] })).toThrow(/LOOMBOX_AMK.*LOOMBOX_RECOVERY_CODE/);
    });

    it('amk wins when both LOOMBOX_AMK and LOOMBOX_RECOVERY_CODE are set (the raw override takes precedence)', () => {
      const env = { ...BASE_ENV, LOOMBOX_RECOVERY_CODE: 'ABCD-EFGH-JKMN-PQRS' };
      const config = loadNodeConfig({ env, argv: [] });
      expect(config.amk).toBeInstanceOf(Uint8Array);
      expect(config.recoveryCode).toBeUndefined();
    });

    it('loads wrappedAmkFilePath from LOOMBOX_WRAPPED_AMK_FILE and leaves amk/recoveryCode undefined (issue #399)', () => {
      const env: Record<string, string> = {
        LOOMBOX_RELAY_URL: BASE_ENV.LOOMBOX_RELAY_URL,
        LOOMBOX_NODE_ID: BASE_ENV.LOOMBOX_NODE_ID,
        LOOMBOX_AUTH_TOKEN: BASE_ENV.LOOMBOX_AUTH_TOKEN,
        LOOMBOX_WRAPPED_AMK_FILE: '/home/node/.loombox/node/wrapped-amk-handoff.json',
      };
      const config = loadNodeConfig({ env, argv: [] });
      expect(config.wrappedAmkFilePath).toBe('/home/node/.loombox/node/wrapped-amk-handoff.json');
      expect(config.amk).toBeUndefined();
      expect(config.recoveryCode).toBeUndefined();
    });

    it('rejects a config with none of amk, wrappedAmkFilePath, or recoveryCode set', () => {
      const env: Record<string, string> = {
        LOOMBOX_RELAY_URL: BASE_ENV.LOOMBOX_RELAY_URL,
        LOOMBOX_NODE_ID: BASE_ENV.LOOMBOX_NODE_ID,
        LOOMBOX_AUTH_TOKEN: BASE_ENV.LOOMBOX_AUTH_TOKEN,
      };
      expect(() => loadNodeConfig({ env, argv: [] })).toThrow(
        /LOOMBOX_AMK.*LOOMBOX_WRAPPED_AMK_FILE.*LOOMBOX_RECOVERY_CODE/,
      );
    });

    it('amk wins over wrappedAmkFilePath when both LOOMBOX_AMK and LOOMBOX_WRAPPED_AMK_FILE are set', () => {
      const env = { ...BASE_ENV, LOOMBOX_WRAPPED_AMK_FILE: '/tmp/wrapped-amk-handoff.json' };
      const config = loadNodeConfig({ env, argv: [] });
      expect(config.amk).toBeInstanceOf(Uint8Array);
      expect(config.wrappedAmkFilePath).toBeUndefined();
    });

    it('wrappedAmkFilePath wins over recoveryCode when both are set and no LOOMBOX_AMK is present', () => {
      const env: Record<string, string> = {
        LOOMBOX_RELAY_URL: BASE_ENV.LOOMBOX_RELAY_URL,
        LOOMBOX_NODE_ID: BASE_ENV.LOOMBOX_NODE_ID,
        LOOMBOX_AUTH_TOKEN: BASE_ENV.LOOMBOX_AUTH_TOKEN,
        LOOMBOX_WRAPPED_AMK_FILE: '/tmp/wrapped-amk-handoff.json',
        LOOMBOX_RECOVERY_CODE: 'ABCD-EFGH-JKMN-PQRS',
      };
      const config = loadNodeConfig({ env, argv: [] });
      expect(config.wrappedAmkFilePath).toBe('/tmp/wrapped-amk-handoff.json');
      expect(config.recoveryCode).toBeUndefined();
    });

    it('rejects malformed JSON in LOOMBOX_TARGETS', () => {
      const env = { ...BASE_ENV, LOOMBOX_TARGETS: '{not valid json' };
      expect(() => loadNodeConfig({ env, argv: [] })).toThrow(ConfigError);
    });

    it('rejects LOOMBOX_TARGETS that is valid JSON but not an array', () => {
      const env = { ...BASE_ENV, LOOMBOX_TARGETS: '{"id":"local"}' };
      expect(() => loadNodeConfig({ env, argv: [] })).toThrow(/array/);
    });
  });

  describe('from a config file', () => {
    async function writeConfigFile(contents: unknown): Promise<string> {
      const filePath = join(dir, 'node-config.json');
      await writeFile(filePath, JSON.stringify(contents), 'utf8');
      return filePath;
    }

    it('loads a complete config from a --config file with no env vars set', async () => {
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        amk: amkBase64(3),
      });

      const config = loadNodeConfig({ env: {}, argv: ['--config', filePath] });
      expect(config.relayUrl).toBe('ws://127.0.0.1:8787');
      expect(config.nodeId).toBe('file-node');
      expect(config.authToken).toBe('file-token');
      expect(config.amk).toHaveLength(32);
    });

    it('accepts --config=<path> as well as --config <path>', async () => {
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        amk: amkBase64(3),
      });

      const config = loadNodeConfig({ env: {}, argv: [`--config=${filePath}`] });
      expect(config.nodeId).toBe('file-node');
    });

    it('reads the config file path from LOOMBOX_NODE_CONFIG when no --config flag is given', async () => {
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        amk: amkBase64(3),
      });

      const config = loadNodeConfig({ env: { LOOMBOX_NODE_CONFIG: filePath }, argv: [] });
      expect(config.nodeId).toBe('file-node');
    });

    it('loads sshTargets and targets arrays from the file', async () => {
      const targets = [
        { id: 'local', kind: 'local', label: 'Local' },
        { id: 'devbox', kind: 'ssh', label: 'Dev box' },
      ];
      const sshTargets = [{ id: 'devbox', label: 'Dev box', host: 'devbox.example', user: 'dev' }];
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        amk: amkBase64(3),
        targets,
        sshTargets,
      });

      const config = loadNodeConfig({ env: {}, argv: ['--config', filePath] });
      expect(config.targets).toEqual(targets);
      expect(config.sshTargets).toEqual(sshTargets);
    });

    it('lets an env var override the same field set in the config file', async () => {
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        amk: amkBase64(3),
      });

      const config = loadNodeConfig({
        env: { LOOMBOX_NODE_CONFIG: filePath, LOOMBOX_NODE_ID: 'env-override-node' },
        argv: [],
      });
      expect(config.nodeId).toBe('env-override-node');
      // Untouched fields still come from the file.
      expect(config.relayUrl).toBe('ws://127.0.0.1:8787');
    });

    it('loads recoveryCode from the config file when no amk is present (issue #386)', async () => {
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        recoveryCode: 'ABCD-EFGH-JKMN-PQRS',
      });

      const config = loadNodeConfig({ env: {}, argv: ['--config', filePath] });
      expect(config.recoveryCode).toBe('ABCD-EFGH-JKMN-PQRS');
      expect(config.amk).toBeUndefined();
    });

    it('loads wrappedAmkFilePath from the config file when no amk is present (issue #399)', async () => {
      const filePath = await writeConfigFile({
        relayUrl: 'ws://127.0.0.1:8787',
        nodeId: 'file-node',
        authToken: 'file-token',
        wrappedAmkFilePath: '/home/node/.loombox/node/wrapped-amk-handoff.json',
      });

      const config = loadNodeConfig({ env: {}, argv: ['--config', filePath] });
      expect(config.wrappedAmkFilePath).toBe('/home/node/.loombox/node/wrapped-amk-handoff.json');
      expect(config.amk).toBeUndefined();
    });

    it('rejects a config file that does not exist', () => {
      expect(() =>
        loadNodeConfig({ env: {}, argv: ['--config', join(dir, 'missing.json')] }),
      ).toThrow(ConfigError);
    });

    it('rejects a config file containing malformed JSON', async () => {
      const filePath = join(dir, 'broken.json');
      await writeFile(filePath, '{ this is not json', 'utf8');
      expect(() => loadNodeConfig({ env: {}, argv: ['--config', filePath] })).toThrow(
        /not valid JSON/,
      );
    });

    it('rejects a config file whose top level is not a JSON object', async () => {
      const filePath = join(dir, 'array.json');
      await writeFile(filePath, '[1, 2, 3]', 'utf8');
      expect(() => loadNodeConfig({ env: {}, argv: ['--config', filePath] })).toThrow(
        /JSON object/,
      );
    });

    it('rejects a config file that is missing required fields, same as env', async () => {
      const filePath = await writeConfigFile({ relayUrl: 'ws://127.0.0.1:8787' });
      expect(() => loadNodeConfig({ env: {}, argv: ['--config', filePath] })).toThrow(ConfigError);
    });
  });
});
