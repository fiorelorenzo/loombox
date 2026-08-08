import { describe, expect, it } from 'vitest';

import { createLaunchdSupervisorBackend } from './launchd/launchd-supervisor-backend';
import { createSystemdLocalSupervisorBackend } from './local/systemd-local-supervisor-backend';
import { createSystemdSshSupervisorBackend } from './ssh/systemd-supervisor-backend';
import { FakeTransport } from './ssh/fake-transport';
import { LocalProcessTransport } from './ssh/local-process-transport';
import type { LaunchdIo } from './launchd/launchd-provisioning';
import type { WindowsTaskIo } from './windows/windows-provisioning';
import { createWindowsSupervisorBackend } from './windows/windows-supervisor-backend';
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

function fakeWindowsTaskIo(): WindowsTaskIo {
  const files = new Map<string, string>();
  return {
    platform: 'win32',
    localAppData: () => 'C:\\Users\\lorenzo\\AppData\\Local',
    systemRoot: () => 'C:\\Windows',
    userId: () => 'DEVBOX\\lorenzo',
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    mkdir: () => {},
    removeFile: (path) => files.delete(path),
    schtasks: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

/**
 * Issue #654's own acceptance criterion, made executable: every
 * `SupervisorBackend` implementation this repo actually wires — systemd
 * for `ssh:` (#654), launchd for macOS-local (#654), systemd-user for
 * Linux-local (#658), Task Scheduler for Windows-local (#659) — genuinely
 * satisfies the full install/start/stop/status/uninstall/survivesReboot
 * vocabulary. A regression guard against any of them quietly drifting
 * from the seam `./supervisor-backend.ts` declares.
 */
describe('SupervisorBackend (issues #654, #658, #659) — every wired implementation conforms', () => {
  it.each([
    ['systemd (ssh:)', () => createSystemdSshSupervisorBackend(new FakeTransport())],
    ['launchd (macOS-local)', () => createLaunchdSupervisorBackend(fakeLaunchdIo())],
    [
      'systemd-user (Linux-local)',
      () =>
        createSystemdLocalSupervisorBackend({ enableLinger: false }, new LocalProcessTransport()),
    ],
    ['Task Scheduler (Windows-local)', () => createWindowsSupervisorBackend(fakeWindowsTaskIo())],
  ] as const)('%s exposes every SupervisorBackend method', (_label, build) => {
    const backend = build();
    for (const method of SUPERVISOR_BACKEND_METHODS) {
      expect(typeof backend[method]).toBe('function');
    }
  });
});
