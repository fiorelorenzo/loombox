import { describe, expect, it } from 'vitest';
import {
  buildLocalNodeLaunchdAgent,
  createNodeLaunchdIo,
  DEFAULT_LAUNCHD_LABEL,
  executeLaunchdProvisioning,
  generateLaunchdPlist,
  installGracefulShutdown,
  PACKAGE_NAME,
  planLaunchdProvisioning,
  relayHttpBaseUrl,
  resolveAccountIdViaRelay,
  run,
  runLocalGuidedSetup,
  start,
} from './index';

describe('@loombox/node', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@loombox/node');
  });

  it('exposes runLocalGuidedSetup and the local-node runtime entry point (issue #406), so a caller (the Electron bridge/app) can drive a local node programmatically without reaching into internal package paths', () => {
    expect(typeof runLocalGuidedSetup).toBe('function');
    expect(typeof start).toBe('function');
    expect(typeof run).toBe('function');
    expect(typeof installGracefulShutdown).toBe('function');
    expect(typeof resolveAccountIdViaRelay).toBe('function');
    expect(typeof relayHttpBaseUrl).toBe('function');
  });

  it('exposes the launchd LaunchAgent provisioning surface for a Mac-resident local node (issue #406)', () => {
    expect(typeof generateLaunchdPlist).toBe('function');
    expect(typeof planLaunchdProvisioning).toBe('function');
    expect(typeof executeLaunchdProvisioning).toBe('function');
    expect(typeof buildLocalNodeLaunchdAgent).toBe('function');
    expect(typeof createNodeLaunchdIo).toBe('function');
    expect(DEFAULT_LAUNCHD_LABEL).toBe('dev.loombox.node');
  });
});
