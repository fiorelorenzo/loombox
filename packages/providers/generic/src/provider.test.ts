import { describe, expect, it } from 'vitest';

import { createGenericProvider } from './provider';

describe('createGenericProvider', () => {
  it('registers under the given id and computes cwd at spawn time', () => {
    const module = createGenericProvider('my-custom-agent', {
      command: 'my-agent',
      args: ['--acp'],
    });

    expect(module.id).toBe('my-custom-agent');
    expect(module.spawnConfig({ cwd: '/tmp/work' })).toEqual({
      command: 'my-agent',
      args: ['--acp'],
      cwd: '/tmp/work',
    });
  });

  it('supplies no enrich hook, so the registry falls back to a pass-through', () => {
    const module = createGenericProvider('id', { command: 'agent', args: [] });
    expect(module.enrich).toBeUndefined();
  });
});
