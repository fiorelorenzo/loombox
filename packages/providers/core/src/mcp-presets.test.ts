import { describe, expect, it } from 'vitest';

import { MCP_SERVER_PRESET_CATALOG, instantiateMcpPreset } from './mcp-presets';
import { parseMcpServerConfig, requiredSecrets } from './mcp-config';

describe('MCP_SERVER_PRESET_CATALOG (issue #188)', () => {
  it('is non-empty and every entry has a unique server name', () => {
    expect(MCP_SERVER_PRESET_CATALOG.length).toBeGreaterThan(0);
    const names = MCP_SERVER_PRESET_CATALOG.map((preset) => preset.config.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every catalog entry parses cleanly through the same validator a hand-entered raw config would go through', () => {
    for (const preset of MCP_SERVER_PRESET_CATALOG) {
      expect(() => parseMcpServerConfig(preset.config)).not.toThrow();
    }
  });

  it('every catalog entry has a non-empty description for the quick-add UI', () => {
    for (const preset of MCP_SERVER_PRESET_CATALOG) {
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('includes at least one no-secret preset and at least one secret-requiring preset', () => {
    const secretFree = MCP_SERVER_PRESET_CATALOG.filter(
      (preset) => requiredSecrets(preset.config).length === 0,
    );
    const secretRequiring = MCP_SERVER_PRESET_CATALOG.filter(
      (preset) => requiredSecrets(preset.config).length > 0,
    );
    expect(secretFree.length).toBeGreaterThan(0);
    expect(secretRequiring.length).toBeGreaterThan(0);
  });

  it('never carries a literal value for a secret-declared variable (no preset can pre-fill a secret)', () => {
    for (const preset of MCP_SERVER_PRESET_CATALOG) {
      const vars = preset.config.transport === 'stdio' ? preset.config.env : preset.config.headers;
      for (const v of vars) {
        if ('secret' in v) {
          expect((v as { value?: unknown }).value).toBeUndefined();
        }
      }
    }
  });
});

describe('instantiateMcpPreset (issue #188)', () => {
  it('produces the exact same config record shape a hand-entered server would (goes through parseMcpServerConfig)', () => {
    const preset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'filesystem')!;
    const instantiated = instantiateMcpPreset(preset);
    const manual = parseMcpServerConfig(JSON.parse(JSON.stringify(preset.config)));
    expect(instantiated).toEqual(manual);
  });

  it('returns a fresh deep copy, not a reference into the catalog (mutating the result never mutates the catalog)', () => {
    const preset = MCP_SERVER_PRESET_CATALOG.find((p) => p.config.name === 'fetch')!;
    const instantiated = instantiateMcpPreset(preset);
    if (instantiated.transport === 'stdio') {
      instantiated.args.push('--mutated');
    }
    const reInstantiated = instantiateMcpPreset(preset);
    if (reInstantiated.transport === 'stdio') {
      expect(reInstantiated.args).not.toContain('--mutated');
    }
  });

  it('a secret-requiring preset instantiates with the secret declaration intact (never resolved/dropped)', () => {
    const preset = MCP_SERVER_PRESET_CATALOG.find((p) => requiredSecrets(p.config).length > 0)!;
    const instantiated = instantiateMcpPreset(preset);
    expect(requiredSecrets(instantiated)).toEqual(requiredSecrets(preset.config));
    expect(requiredSecrets(instantiated).length).toBeGreaterThan(0);
  });
});
