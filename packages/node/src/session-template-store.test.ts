import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionTemplateV1 } from '@loombox/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionTemplateError, SessionTemplateStore } from './session-template-store';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'loombox-session-template-store-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const dailyCheckin: SessionTemplateV1 = {
  id: 'tpl_daily',
  name: 'Daily check-in',
  targetId: 'local',
  provider: 'claude',
  worktree: true,
  title: 'Daily check-in',
};

describe('SessionTemplateStore', () => {
  it('list() is [] for a node with nothing saved yet', () => {
    const store = new SessionTemplateStore({ stateDir });
    expect(store.list()).toEqual([]);
  });

  it('get() is undefined for an unknown id — never throws', () => {
    const store = new SessionTemplateStore({ stateDir });
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('saveAll() persists the full catalog, readable by a fresh store instance (survives a node restart)', () => {
    new SessionTemplateStore({ stateDir }).saveAll([dailyCheckin]);
    const reloaded = new SessionTemplateStore({ stateDir });
    expect(reloaded.list()).toEqual([dailyCheckin]);
    expect(reloaded.get('tpl_daily')).toEqual(dailyCheckin);
  });

  it('saveAll() fully replaces the catalog, never merges — a second call without the first template drops it', () => {
    const store = new SessionTemplateStore({ stateDir });
    store.saveAll([dailyCheckin]);
    const codexReview: SessionTemplateV1 = {
      id: 'tpl_codex',
      name: 'Codex review',
      targetId: 'local',
      provider: 'codex',
    };
    store.saveAll([codexReview]);
    expect(store.list()).toEqual([codexReview]);
    expect(store.get('tpl_daily')).toBeUndefined();
  });

  it('persists a template referencing a custom agent', () => {
    const custom: SessionTemplateV1 = {
      id: 'tpl_custom',
      name: 'My internal agent',
      targetId: 'local',
      provider: 'custom',
      customAgent: { name: 'internal', command: 'omp', args: ['acp'] },
    };
    const store = new SessionTemplateStore({ stateDir });
    store.saveAll([custom]);
    expect(new SessionTemplateStore({ stateDir }).get('tpl_custom')).toEqual(custom);
  });

  it('throws SessionTemplateError on a corrupt file rather than returning a partial catalog', () => {
    const store = new SessionTemplateStore({ stateDir });
    store.saveAll([dailyCheckin]);
    writeFileSync(path.join(stateDir, 'session-templates.json'), '{not json');
    expect(() => store.list()).toThrow(SessionTemplateError);
  });

  it('throws SessionTemplateError on a template that fails schema validation (e.g. a blank id)', () => {
    writeFileSync(
      path.join(stateDir, 'session-templates.json'),
      JSON.stringify({
        v: 1,
        templates: [{ id: '', name: 'x', targetId: 'local', provider: 'claude' }],
      }),
    );
    const store = new SessionTemplateStore({ stateDir });
    expect(() => store.list()).toThrow(SessionTemplateError);
  });
});
