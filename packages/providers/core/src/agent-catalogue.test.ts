import { describe, expect, it } from 'vitest';
import { customAgentRecordV1 } from '@loombox/protocol';

import {
  AGENT_CATALOGUE,
  agentCatalogueEntryStaleAt,
  instantiateAgentCatalogueEntry,
  isAgentCatalogueEntryStale,
  StaleAgentCatalogueEntryError,
  type AgentCatalogueEntry,
} from './agent-catalogue';

describe('AGENT_CATALOGUE (issue #749)', () => {
  it('is non-empty and every entry has a unique id and a unique agent name', () => {
    expect(AGENT_CATALOGUE.length).toBeGreaterThan(0);
    const ids = AGENT_CATALOGUE.map((entry) => entry.id);
    const names = AGENT_CATALOGUE.map((entry) => entry.config.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never catalogues Claude Code or Codex: both are already registered providers, not custom-agent picks', () => {
    const commands = AGENT_CATALOGUE.map((entry) => entry.config.command.toLowerCase());
    expect(commands).not.toContain('claude');
    expect(commands).not.toContain('codex');
  });

  it('every entry parses cleanly through the same customAgentRecordV1 validator a hand-typed custom agent goes through', () => {
    for (const entry of AGENT_CATALOGUE) {
      expect(() => customAgentRecordV1.parse(entry.config)).not.toThrow();
    }
  });

  it('every entry has a non-empty description for the quick-add UI', () => {
    for (const entry of AGENT_CATALOGUE) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("every entry's verification names a real version, a checkable source URL, and a well-formed verifiedOn date", () => {
    for (const entry of AGENT_CATALOGUE) {
      const { against, verifiedOn, sourceUrl, staleAfterDays } = entry.verification;
      expect(against.length).toBeGreaterThan(0);
      expect(verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(verifiedOn))).toBe(false);
      expect(sourceUrl).toMatch(/^https:\/\//);
      expect(staleAfterDays).toBeGreaterThan(0);
    }
  });

  it("no entry is already stale as of the real current date — this is the loud, build-breaking half of issue #749's upkeep requirement: let this fail rather than silently ship a lapsed entry", () => {
    for (const entry of AGENT_CATALOGUE) {
      expect(isAgentCatalogueEntryStale(entry)).toBe(false);
    }
  });
});

describe('instantiateAgentCatalogueEntry (issue #749)', () => {
  it('produces the exact same record shape a hand-typed custom agent form would (goes through customAgentRecordV1)', () => {
    const entry = AGENT_CATALOGUE.find((e) => e.id === 'gemini-cli')!;
    const instantiated = instantiateAgentCatalogueEntry(entry);
    const manual = customAgentRecordV1.parse(JSON.parse(JSON.stringify(entry.config)));
    expect(instantiated).toEqual(manual);
    expect(instantiated).toEqual({ name: 'Gemini CLI', command: 'gemini', args: ['--acp'] });
  });

  it('returns a fresh deep copy, not a reference into the catalogue (mutating the result never mutates the catalogue)', () => {
    const entry = AGENT_CATALOGUE.find((e) => e.id === 'qwen-code')!;
    const instantiated = instantiateAgentCatalogueEntry(entry);
    instantiated.args.push('--mutated');
    const reInstantiated = instantiateAgentCatalogueEntry(entry);
    expect(reInstantiated.args).not.toContain('--mutated');
  });

  it('refuses a stale entry with StaleAgentCatalogueEntryError instead of silently handing back its possibly-wrong invocation', () => {
    const entry: AgentCatalogueEntry = {
      id: 'ancient-agent',
      description: 'An agent whose verification lapsed.',
      config: customAgentRecordV1.parse({ name: 'Ancient Agent', command: 'ancient' }),
      verification: {
        against: 'ancient-agent@1.0.0',
        verifiedOn: '2020-01-01',
        sourceUrl: 'https://example.com/ancient-agent/docs',
        staleAfterDays: 180,
      },
    };
    expect(() => instantiateAgentCatalogueEntry(entry)).toThrow(StaleAgentCatalogueEntryError);
    expect(() => instantiateAgentCatalogueEntry(entry)).toThrow(
      /past its 180-day staleness window/,
    );
  });

  it('accepts an explicit "now" so freshness can be asserted deterministically without mocking the clock', () => {
    const entry: AgentCatalogueEntry = {
      id: 'fixed-clock-agent',
      description: 'An agent verified on a fixed date.',
      config: customAgentRecordV1.parse({ name: 'Fixed Clock Agent', command: 'fca' }),
      verification: {
        against: 'fca@1.0.0',
        verifiedOn: '2026-01-01',
        sourceUrl: 'https://example.com/fca/docs',
        staleAfterDays: 30,
      },
    };
    // One day before the window closes: still fresh.
    expect(() =>
      instantiateAgentCatalogueEntry(entry, new Date('2026-01-30T00:00:00Z')),
    ).not.toThrow();
    // Exactly on the boundary and past it: stale.
    expect(() => instantiateAgentCatalogueEntry(entry, new Date('2026-01-31T00:00:00Z'))).toThrow(
      StaleAgentCatalogueEntryError,
    );
    expect(() => instantiateAgentCatalogueEntry(entry, new Date('2026-06-01T00:00:00Z'))).toThrow(
      StaleAgentCatalogueEntryError,
    );
  });
});

describe('agentCatalogueEntryStaleAt / isAgentCatalogueEntryStale (issue #749)', () => {
  it('computes the staleness cutoff as verifiedOn (UTC midnight) plus staleAfterDays', () => {
    const entry: AgentCatalogueEntry = {
      id: 'x',
      description: 'x',
      config: customAgentRecordV1.parse({ name: 'X', command: 'x' }),
      verification: {
        against: 'x@1.0.0',
        verifiedOn: '2026-01-01',
        sourceUrl: 'https://example.com/x',
        staleAfterDays: 10,
      },
    };
    expect(agentCatalogueEntryStaleAt(entry).toISOString()).toBe('2026-01-11T00:00:00.000Z');
    expect(isAgentCatalogueEntryStale(entry, new Date('2026-01-10T23:59:59Z'))).toBe(false);
    expect(isAgentCatalogueEntryStale(entry, new Date('2026-01-11T00:00:00Z'))).toBe(true);
  });
});
