import { describe, expect, it } from 'vitest';

import {
  collisionFreeNodeId,
  defaultBaseDirName,
  defaultLaunchdLabel,
  defaultUnitName,
  defaultWindowsTaskName,
} from './node-environment';

describe('node-environment (issue #867)', () => {
  it('production defaults are exactly the pre-existing, unqualified names — no behavior change for an existing devbox', () => {
    expect(defaultUnitName('production')).toBe('loombox-node.service');
    expect(defaultLaunchdLabel('production')).toBe('dev.loombox.node');
    expect(defaultWindowsTaskName('production')).toBe('\\loombox\\node');
    expect(defaultBaseDirName('production')).toBe('.loombox');
    expect(collisionFreeNodeId('devbox-node-1', 'production')).toBe('devbox-node-1');
  });

  it('preview defaults are distinct from production on every axis', () => {
    expect(defaultUnitName('preview')).not.toBe(defaultUnitName('production'));
    expect(defaultLaunchdLabel('preview')).not.toBe(defaultLaunchdLabel('production'));
    expect(defaultWindowsTaskName('preview')).not.toBe(defaultWindowsTaskName('production'));
    expect(defaultBaseDirName('preview')).not.toBe(defaultBaseDirName('production'));
    expect(defaultUnitName('preview')).toBe('loombox-node-preview.service');
    expect(defaultLaunchdLabel('preview')).toBe('dev.loombox.node-preview');
    expect(defaultWindowsTaskName('preview')).toBe('\\loombox\\node-preview');
    expect(defaultBaseDirName('preview')).toBe('.loombox-preview');
  });

  it('collisionFreeNodeId suffixes a non-production environment onto a caller-supplied id, so two nodes named alike stay distinguishable', () => {
    expect(collisionFreeNodeId('devbox-node-1', 'preview')).toBe('devbox-node-1-preview');
  });

  it('collisionFreeNodeId never double-suffixes an id the caller already qualified', () => {
    expect(collisionFreeNodeId('devbox-node-1-preview', 'preview')).toBe('devbox-node-1-preview');
  });
});
