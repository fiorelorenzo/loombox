import { describe, expect, it } from 'vitest';

import { createLaunchdSupervisorBackend } from './launchd/launchd-supervisor-backend';
import { createSystemdSshSupervisorBackend } from './ssh/systemd-supervisor-backend';
import { FakeTransport } from './ssh/fake-transport';
import type { LaunchdIo } from './launchd/launchd-provisioning';
import type { SupervisorBackend } from './supervisor-backend';

const SUPERVISOR_BACKEND_METHODS: readonly (keyof SupervisorBackend)[] = [
  'install',
  'start',
  'stop',
  'status',
  'uninstall',
  'survivesReboot',
];

function fakeLaunchdIo(): LaunchdIo {
  const files = new Map<string, string>();
  return {
    platform: 'darwin',
    homeDir: () => '/Users/lorenzo',
    uid: () => 501,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    mkdir: () => {},
    removeFile: (path) => files.delete(path),
    launchctl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

/**
 * Issue #654's own acceptance criterion, made executable: exactly two
 * `SupervisorBackend` implementations exist today (systemd for `ssh:`,
 * launchd for macOS-local), and both genuinely satisfy the full
 * install/start/stop/status/uninstall/survivesReboot vocabulary — a
 * regression guard against either implementation quietly drifting from
 * the seam `./supervisor-backend.ts` declares.
 */
describe('SupervisorBackend (issue #654) — both wired implementations conform', () => {
  it.each([
    ['systemd (ssh:)', () => createSystemdSshSupervisorBackend(new FakeTransport())],
    ['launchd (macOS-local)', () => createLaunchdSupervisorBackend(fakeLaunchdIo())],
  ] as const)('%s exposes every SupervisorBackend method', (_label, build) => {
    const backend = build();
    for (const method of SUPERVISOR_BACKEND_METHODS) {
      expect(typeof backend[method]).toBe('function');
    }
  });
});
