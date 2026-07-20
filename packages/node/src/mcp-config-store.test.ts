import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { McpServerConfig } from '@loombox/providers-core';

import { McpConfigError, McpConfigStore } from './mcp-config-store';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'loombox-node-mcp-config-test-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const fs: McpServerConfig = {
  name: 'fs',
  transport: 'stdio',
  command: 'mcp-server-fs',
  args: [],
  env: [],
};

const search: McpServerConfig = {
  name: 'search',
  transport: 'http',
  url: 'https://example.com/mcp',
  headers: [],
};

describe('McpConfigStore', () => {
  it('starts empty against a fresh state dir', () => {
    const store = new McpConfigStore({ stateDir });
    expect(store.listGlobal()).toEqual([]);
    expect(store.listProject('/repo/a')).toEqual([]);
  });

  it('saveGlobal() creates a record, enabled by default', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveGlobal(fs);

    expect(store.listGlobal()).toEqual([{ config: fs, enabled: true }]);
  });

  it('saveGlobal() with enabled: false creates a disabled record', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveGlobal(fs, false);

    expect(store.listGlobal()).toEqual([{ config: fs, enabled: false }]);
  });

  it('saveGlobal() replaces an existing record with the same name', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveGlobal(fs);
    const updated: McpServerConfig = { ...fs, args: ['--root', '/tmp'] };
    store.saveGlobal(updated);

    expect(store.listGlobal()).toEqual([{ config: updated, enabled: true }]);
  });

  it('saveProject() scopes a record to one project, independent of others', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveProject('/repo/a', fs);

    expect(store.listProject('/repo/a')).toEqual([{ config: fs, enabled: true }]);
    expect(store.listProject('/repo/b')).toEqual([]);
    expect(store.listGlobal()).toEqual([]);
  });

  it('setGlobalEnabled() toggles enabled without touching the config', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveGlobal(fs);
    store.setGlobalEnabled('fs', false);

    expect(store.listGlobal()).toEqual([{ config: fs, enabled: false }]);
  });

  it('setGlobalEnabled() throws for an unknown server name', () => {
    const store = new McpConfigStore({ stateDir });
    expect(() => store.setGlobalEnabled('nope', false)).toThrow(McpConfigError);
  });

  it('setProjectEnabled() toggles enabled scoped to one project', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveProject('/repo/a', fs);
    store.setProjectEnabled('/repo/a', 'fs', false);

    expect(store.listProject('/repo/a')).toEqual([{ config: fs, enabled: false }]);
  });

  it('removeGlobal() / removeProject() delete a record', () => {
    const store = new McpConfigStore({ stateDir });
    store.saveGlobal(fs);
    store.saveProject('/repo/a', search);

    store.removeGlobal('fs');
    store.removeProject('/repo/a', 'search');

    expect(store.listGlobal()).toEqual([]);
    expect(store.listProject('/repo/a')).toEqual([]);
  });

  it('persists across a simulated restart (a fresh store instance over the same stateDir)', () => {
    const first = new McpConfigStore({ stateDir });
    first.saveGlobal(fs);
    first.saveProject('/repo/a', search);
    first.setGlobalEnabled('fs', false);

    const second = new McpConfigStore({ stateDir });
    expect(second.listGlobal()).toEqual([{ config: fs, enabled: false }]);
    expect(second.listProject('/repo/a')).toEqual([{ config: search, enabled: true }]);
  });

  describe('effectiveServers() (global-plus-project-overrides)', () => {
    it('includes every enabled global server for a project with no records of its own', () => {
      const store = new McpConfigStore({ stateDir });
      store.saveGlobal(fs);

      expect(store.effectiveServers('/repo/a')).toEqual([fs]);
    });

    it('excludes a disabled global server', () => {
      const store = new McpConfigStore({ stateDir });
      store.saveGlobal(fs, false);

      expect(store.effectiveServers('/repo/a')).toEqual([]);
    });

    it('a project record for the same name overrides the global one outright', () => {
      const store = new McpConfigStore({ stateDir });
      store.saveGlobal(fs);
      const projectFs: McpServerConfig = { ...fs, args: ['--project-scoped'] };
      store.saveProject('/repo/a', projectFs);

      expect(store.effectiveServers('/repo/a')).toEqual([projectFs]);
      // A sibling project never sees another project's override.
      expect(store.effectiveServers('/repo/b')).toEqual([fs]);
    });

    it('a project can disable an inherited global server', () => {
      const store = new McpConfigStore({ stateDir });
      store.saveGlobal(fs);
      store.saveProject('/repo/a', fs, false);

      expect(store.effectiveServers('/repo/a')).toEqual([]);
    });

    it('a project can add its own server the global list never had', () => {
      const store = new McpConfigStore({ stateDir });
      store.saveGlobal(fs);
      store.saveProject('/repo/a', search);

      expect(store.effectiveServers('/repo/a')).toEqual(expect.arrayContaining([fs, search]));
      expect(store.effectiveServers('/repo/a')).toHaveLength(2);
    });
  });

  describe('on-disk validation', () => {
    it('throws McpConfigError for a file that is not valid JSON', async () => {
      await writeFile(path.join(stateDir, 'mcp-servers.json'), 'not json');
      const store = new McpConfigStore({ stateDir });
      expect(() => store.listGlobal()).toThrow(McpConfigError);
    });

    it('throws McpConfigError for a malformed record (bad transport)', async () => {
      await writeFile(
        path.join(stateDir, 'mcp-servers.json'),
        JSON.stringify({
          v: 1,
          global: [{ config: { name: 'x', transport: 'carrier-pigeon' }, enabled: true }],
          projects: {},
        }),
      );
      const store = new McpConfigStore({ stateDir });
      expect(() => store.listGlobal()).toThrow(McpConfigError);
    });

    it('throws McpConfigError when "enabled" is missing or not a boolean', async () => {
      await writeFile(
        path.join(stateDir, 'mcp-servers.json'),
        JSON.stringify({ v: 1, global: [{ config: fs }], projects: {} }),
      );
      const store = new McpConfigStore({ stateDir });
      expect(() => store.listGlobal()).toThrow(McpConfigError);
    });
  });
});
