import type { AcpConfigOption } from '@loombox/providers-core/browser';
import { describe, expect, it } from 'vitest';

import {
  resolveConfigOptionDefaults,
  resolveConfigOptionSources,
} from './config-option-resolution';

function option(overrides: Partial<AcpConfigOption> = {}): AcpConfigOption {
  return {
    category: 'model',
    current: 'sonnet',
    choices: [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
      { id: 'haiku', name: 'Haiku' },
    ],
    ...overrides,
  };
}

describe('resolveConfigOptionDefaults (issue #753, D4-3)', () => {
  it('resolves to the agent default (nothing to apply) when neither project nor account remembers anything', () => {
    const [resolution] = resolveConfigOptionDefaults([option()], {}, {});
    expect(resolution).toEqual({ category: 'model', source: 'default', optionId: undefined });
  });

  it('resolves to the account value when only the account remembers something valid', () => {
    const [resolution] = resolveConfigOptionDefaults([option()], {}, { model: 'opus' });
    expect(resolution).toEqual({ category: 'model', source: 'account', optionId: 'opus' });
  });

  it('resolves to the project override when only the project has one, valid', () => {
    const [resolution] = resolveConfigOptionDefaults([option()], { model: 'haiku' }, {});
    expect(resolution).toEqual({ category: 'model', source: 'project', optionId: 'haiku' });
  });

  it('the project override wins when both a project override and an account value exist (D4-3 core rule)', () => {
    const [resolution] = resolveConfigOptionDefaults(
      [option()],
      { model: 'haiku' },
      { model: 'opus' },
    );
    expect(resolution).toEqual({ category: 'model', source: 'project', optionId: 'haiku' });
  });

  it('a stale project override (not among the current choices) is dropped silently, falling through to a valid account value', () => {
    const [resolution] = resolveConfigOptionDefaults(
      [option()],
      { model: 'retired-model' },
      { model: 'opus' },
    );
    expect(resolution).toEqual({ category: 'model', source: 'account', optionId: 'opus' });
  });

  it('a stale account value (not among the current choices) is dropped silently, falling through to the agent default', () => {
    const [resolution] = resolveConfigOptionDefaults([option()], {}, { model: 'retired-model' });
    expect(resolution).toEqual({ category: 'model', source: 'default', optionId: undefined });
  });

  it('a stale project override AND a stale account value both drop, falling all the way through to the agent default — never resolving to the account value one layer down from a stale project pick', () => {
    const [resolution] = resolveConfigOptionDefaults(
      [option()],
      { model: 'retired-project-model' },
      { model: 'retired-account-model' },
    );
    expect(resolution).toEqual({ category: 'model', source: 'default', optionId: undefined });
  });

  it('resolves every category independently in one pass', () => {
    const options = [
      option({ category: 'model', current: 'sonnet' }),
      option({
        category: 'thought_level',
        current: 'medium',
        choices: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      }),
    ];
    const resolutions = resolveConfigOptionDefaults(
      options,
      { model: 'opus' },
      { thought_level: 'high' },
    );
    expect(resolutions).toEqual([
      { category: 'model', source: 'project', optionId: 'opus' },
      { category: 'thought_level', source: 'account', optionId: 'high' },
    ]);
  });
});

describe('resolveConfigOptionSources (issue #753, D4-3 ConfigBar acceptance)', () => {
  it('attributes the current value to the project override when it matches', () => {
    const sources = resolveConfigOptionSources(
      [option({ current: 'haiku' })],
      { model: 'haiku' },
      { model: 'opus' },
    );
    expect(sources).toEqual({ model: 'project' });
  });

  it('attributes the current value to the account default when it matches and no project override matches', () => {
    const sources = resolveConfigOptionSources(
      [option({ current: 'opus' })],
      { model: 'haiku' },
      { model: 'opus' },
    );
    expect(sources).toEqual({ model: 'account' });
  });

  it('attributes the current value to the agent default when it matches neither stored value', () => {
    const sources = resolveConfigOptionSources(
      [option({ current: 'sonnet' })],
      { model: 'haiku' },
      { model: 'opus' },
    );
    expect(sources).toEqual({ model: 'default' });
  });

  it('an unset current value never spuriously attributes to a layer whose own stored value happens to be undefined too', () => {
    const sources = resolveConfigOptionSources([option({ current: undefined })], {}, {});
    expect(sources).toEqual({ model: 'default' });
  });
});
