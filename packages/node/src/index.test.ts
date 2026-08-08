import { describe, expect, it } from 'vitest';
import {
  buildLocalNodeLaunchdAgent,
  createLaunchdSupervisorBackend,
  createLocalFsNodeReleaseSource,
  createNodeLaunchdIo,
  createNodeWindowsTaskIo,
  createSystemdSshSupervisorBackend,
  createWindowsInstallLayoutDriver,
  createWindowsSupervisorBackend,
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_WINDOWS_TASK_NAME,
  defaultWindowsTaskName,
  executeLaunchdProvisioning,
  executeWindowsTaskProvisioning,
  generateLaunchdPlist,
  generateWindowsLauncherScript,
  generateWindowsTaskXml,
  installGracefulShutdown,
  NODE_BUNDLE_ENTRY_FILE,
  PACKAGE_NAME,
  planLaunchdProvisioning,
  planWindowsTaskProvisioning,
  provisionLocalNode,
  relayHttpBaseUrl,
  resolveAccountIdViaRelay,
  run,
  runLocalGuidedSetup,
  start,
  winQuoteArg,
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

  it('exposes the supervisor-backend seam (issue #654): both wired implementations, the node-release source, and the local-provisioning orchestrator', () => {
    expect(typeof createSystemdSshSupervisorBackend).toBe('function');
    expect(typeof createLaunchdSupervisorBackend).toBe('function');
    expect(typeof createLocalFsNodeReleaseSource).toBe('function');
    expect(typeof provisionLocalNode).toBe('function');
    expect(NODE_BUNDLE_ENTRY_FILE).toBe('node.mjs');
  });

  it('exposes the Task Scheduler provisioning surface and SupervisorBackend for a Windows-local node (issue #659)', () => {
    expect(typeof generateWindowsTaskXml).toBe('function');
    expect(typeof generateWindowsLauncherScript).toBe('function');
    expect(typeof winQuoteArg).toBe('function');
    expect(typeof planWindowsTaskProvisioning).toBe('function');
    expect(typeof executeWindowsTaskProvisioning).toBe('function');
    expect(typeof createNodeWindowsTaskIo).toBe('function');
    expect(typeof createWindowsSupervisorBackend).toBe('function');
    expect(typeof createWindowsInstallLayoutDriver).toBe('function');
    expect(DEFAULT_WINDOWS_TASK_NAME).toBe('\\loombox\\node');
    expect(defaultWindowsTaskName('production')).toBe(DEFAULT_WINDOWS_TASK_NAME);
  });
});
