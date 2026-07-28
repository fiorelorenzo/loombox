import { describe, expect, it } from 'vitest';

import { FakeTransport } from './ssh/fake-transport';
import { LocalProcessTransport } from './ssh/local-process-transport';
import {
  failedSample,
  parseRemoteSample,
  sampleLocalResources,
  sampleRemoteResources,
  type LocalOsSource,
} from './resource-sampler';

/** Synthetic `/proc/meminfo` content — `memAvailableKb` is the one line `readMemAvailableBytes` actually reads; the rest exists only so the fixture looks like the real file. */
function meminfoText(memAvailableKb: number): string {
  return [
    'MemTotal:       16000000 kB',
    'MemFree:          500000 kB',
    `MemAvailable:   ${memAvailableKb} kB`,
    'Buffers:          200000 kB',
    'Cached:          8000000 kB',
    '',
  ].join('\n');
}

describe('failedSample', () => {
  it('is unhealthy with every figure zeroed out', () => {
    expect(failedSample(123)).toEqual({
      cpuPercent: 0,
      loadPercent: 0,
      memPercent: 0,
      memUsedBytes: 0,
      memTotalBytes: 0,
      diskPercent: 0,
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      healthy: false,
      sampledAt: 123,
    });
  });
});

describe('sampleLocalResources', () => {
  const fakeOs: LocalOsSource = {
    totalmem: () => 16_000_000_000,
    freemem: () => 4_000_000_000,
    cpus: () => new Array(8).fill(0),
    loadavg: () => [4, 3, 2],
    hostname: () => 'devbox-node-1',
    platform: () => 'linux',
    arch: () => 'x64',
  };
  const diskSpaceFn = async () => ({ diskPath: '/', free: 100, size: 400 });
  // 5859375 kB * 1024 = 6,000,000,000 bytes exactly — a round number chosen
  // purely so the assertions below stay readable.
  const readMemInfo = async () => meminfoText(5_859_375);

  it('computes RAM used from /proc/meminfo MemAvailable, not os.freemem() (a healthy Linux box\'s page cache is not "used")', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs, // freemem() = 4e9, deliberately different from MemAvailable's 6e9 so a
      // regression back to freemem() would change this test's numbers.
      readMemInfo,
      checkDiskSpaceFn: diskSpaceFn,
      now: () => 999,
    });
    expect(sample.healthy).toBe(true);
    expect(sample.memTotalBytes).toBe(16_000_000_000);
    expect(sample.memUsedBytes).toBe(10_000_000_000); // 16e9 - 6e9 (MemAvailable), not 16e9 - 4e9 (freemem)
    expect(sample.memPercent).toBe(62.5);
    expect(sample.sampledAt).toBe(999);
  });

  it('falls back to os.freemem() when readMemInfo rejects (macOS: no /proc/meminfo at all)', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs, // freemem() = 4e9
      readMemInfo: async () => {
        throw new Error("ENOENT: no such file or directory, open '/proc/meminfo'");
      },
      checkDiskSpaceFn: diskSpaceFn,
    });
    expect(sample.healthy).toBe(true);
    expect(sample.memUsedBytes).toBe(12_000_000_000); // 16e9 - freemem's 4e9
    expect(sample.memPercent).toBe(75);
  });

  it('falls back to os.freemem() when /proc/meminfo has no MemAvailable line (pre-3.14 kernel)', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
      readMemInfo: async () => 'MemTotal:       16000000 kB\nMemFree:          500000 kB\n',
      checkDiskSpaceFn: diskSpaceFn,
    });
    expect(sample.memUsedBytes).toBe(12_000_000_000);
    expect(sample.memPercent).toBe(75);
  });

  it('computes loadPercent (and mirrors it into the deprecated cpuPercent) from loadavg[0] normalized by core count', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs, // load1=4, 8 cores -> 50%
      readMemInfo,
      checkDiskSpaceFn: diskSpaceFn,
    });
    expect(sample.loadPercent).toBe(50);
    expect(sample.cpuPercent).toBe(50);
  });

  it('clamps loadPercent/cpuPercent to 100 when load average exceeds core count (it is a queue length, not a bounded utilization ratio)', async () => {
    const overloaded: LocalOsSource = { ...fakeOs, loadavg: () => [40, 30, 20] };
    const sample = await sampleLocalResources({
      osSource: overloaded,
      readMemInfo,
      checkDiskSpaceFn: diskSpaceFn,
    });
    expect(sample.loadPercent).toBe(100);
    expect(sample.cpuPercent).toBe(100);
  });

  it('populates hostname/platform/arch from the injected os source, so a target labeled "Local" is identifiable', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
      readMemInfo,
      checkDiskSpaceFn: diskSpaceFn,
    });
    expect(sample.hostname).toBe('devbox-node-1');
    expect(sample.platform).toBe('linux');
    expect(sample.arch).toBe('x64');
  });

  it('computes disk percent/used/total from check-disk-space', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
      readMemInfo,
      checkDiskSpaceFn: async () => ({ diskPath: '/home', free: 100, size: 500 }),
    });
    expect(sample.diskTotalBytes).toBe(500);
    expect(sample.diskUsedBytes).toBe(400);
    expect(sample.diskPercent).toBe(80);
  });

  it('returns a failed sample when check-disk-space rejects', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
      readMemInfo,
      checkDiskSpaceFn: async () => {
        throw new Error('boom');
      },
      now: () => 555,
    });
    expect(sample).toEqual(failedSample(555));
  });

  it('samples the real host without throwing (integration smoke test)', async () => {
    const sample = await sampleLocalResources();
    expect(sample.healthy).toBe(true);
    expect(sample.memTotalBytes).toBeGreaterThan(0);
    expect(sample.loadPercent).toBeGreaterThanOrEqual(0);
    expect(sample.loadPercent).toBeLessThanOrEqual(100);
    expect(sample.cpuPercent).toBe(sample.loadPercent);
    expect(sample.diskTotalBytes).toBeGreaterThan(0);
    expect(sample.hostname).toBeTruthy();
    expect(sample.platform).toBe(process.platform);
    expect(sample.arch).toBe(process.arch);
  });
});

describe('parseRemoteSample', () => {
  it('parses a well-formed KEY=VALUE block into a healthy sample, including identification fields', () => {
    const stdout = [
      'NPROC=8',
      'LOAD=4',
      'MEMTOTAL=16000000000',
      'MEMFREE=4000000000',
      'DISK=400 320 80',
      'UNAME=Linux',
      'HOSTNAME=devbox.example',
      'ARCH=x86_64',
      '',
    ].join('\n');
    const sample = parseRemoteSample(stdout, 42);
    expect(sample.healthy).toBe(true);
    expect(sample.cpuPercent).toBe(50);
    expect(sample.loadPercent).toBe(50);
    expect(sample.memTotalBytes).toBe(16_000_000_000);
    expect(sample.memUsedBytes).toBe(12_000_000_000);
    expect(sample.memPercent).toBe(75);
    expect(sample.diskTotalBytes).toBe(400 * 1024);
    expect(sample.diskUsedBytes).toBe(320 * 1024);
    expect(sample.diskPercent).toBe(80);
    expect(sample.sampledAt).toBe(42);
    expect(sample.hostname).toBe('devbox.example');
    expect(sample.platform).toBe('linux');
    expect(sample.arch).toBe('x64'); // normalized from uname's x86_64
  });

  it("normalizes Darwin/aarch64 uname naming to os.platform()/os.arch()'s darwin/arm64 vocabulary", () => {
    const stdout = [
      'NPROC=8',
      'LOAD=4',
      'MEMTOTAL=16000000000',
      'MEMFREE=4000000000',
      'DISK=400 320 80',
      'UNAME=Darwin',
      'HOSTNAME=lorenzos-mac.local',
      'ARCH=aarch64',
    ].join('\n');
    const sample = parseRemoteSample(stdout, 1);
    expect(sample.platform).toBe('darwin');
    expect(sample.arch).toBe('arm64');
  });

  it('leaves hostname/platform/arch undefined when the script output predates them', () => {
    const stdout = [
      'NPROC=8',
      'LOAD=4',
      'MEMTOTAL=16000000000',
      'MEMFREE=4000000000',
      'DISK=400 320 80',
    ].join('\n');
    const sample = parseRemoteSample(stdout, 1);
    expect(sample.hostname).toBeUndefined();
    expect(sample.platform).toBeUndefined();
    expect(sample.arch).toBeUndefined();
  });

  it('clamps cpu percent past 100 when load exceeds core count', () => {
    const stdout = ['NPROC=2', 'LOAD=8', 'MEMTOTAL=100', 'MEMFREE=50', 'DISK=100 50 50'].join('\n');
    const sample = parseRemoteSample(stdout, 1);
    expect(sample.cpuPercent).toBe(100);
    expect(sample.loadPercent).toBe(100);
  });

  it('returns a failed sample for empty/garbled output', () => {
    expect(parseRemoteSample('', 7)).toEqual(failedSample(7));
    expect(parseRemoteSample('not key value lines at all', 8)).toEqual(failedSample(8));
  });

  it('returns a failed sample when NPROC is missing or zero', () => {
    const stdout = ['NPROC=0', 'LOAD=1', 'MEMTOTAL=100', 'MEMFREE=50', 'DISK=100 50 50'].join('\n');
    expect(parseRemoteSample(stdout, 3).healthy).toBe(false);
  });

  it('returns a failed sample when disk fields are missing', () => {
    const stdout = ['NPROC=4', 'LOAD=1', 'MEMTOTAL=100', 'MEMFREE=50', 'DISK='].join('\n');
    expect(parseRemoteSample(stdout, 3).healthy).toBe(false);
  });
});

describe('sampleRemoteResources', () => {
  it('parses a scripted transport reply into a healthy sample', async () => {
    const transport = new FakeTransport({
      onExec: () => ({
        stdout: [
          'NPROC=4',
          'LOAD=2',
          'MEMTOTAL=8000000000',
          'MEMFREE=2000000000',
          'DISK=100 40 60',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }),
    });
    await transport.connect();
    const sample = await sampleRemoteResources(transport, { now: () => 111 });
    expect(sample.healthy).toBe(true);
    expect(sample.cpuPercent).toBe(50);
    expect(sample.loadPercent).toBe(50);
    expect(sample.sampledAt).toBe(111);
  });

  it('returns a failed sample when the remote exec exits non-zero', async () => {
    const transport = new FakeTransport({
      onExec: () => ({ stdout: '', stderr: 'permission denied', exitCode: 1 }),
    });
    await transport.connect();
    const sample = await sampleRemoteResources(transport, { now: () => 222 });
    expect(sample).toEqual(failedSample(222));
  });

  it('returns a failed sample when the transport throws (unreachable host)', async () => {
    const transport = new FakeTransport({
      onExec: () => {
        throw new Error('ECONNRESET');
      },
    });
    await transport.connect();
    const sample = await sampleRemoteResources(transport, { now: () => 333 });
    expect(sample).toEqual(failedSample(333));
  });

  it('quotes the disk path so a space or shell metacharacter cannot break out of the script', async () => {
    const transport = new FakeTransport({
      onExec: (command) => {
        expect(command).toContain("'/tmp/a path; rm -rf /'");
        return {
          stdout: ['NPROC=1', 'LOAD=0', 'MEMTOTAL=1', 'MEMFREE=1', 'DISK=1 0 1'].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      },
    });
    await transport.connect();
    await sampleRemoteResources(transport, { diskPath: '/tmp/a path; rm -rf /' });
  });

  it('samples the real local shell end-to-end via LocalProcessTransport (proves the script actually runs under dash/sh, including its hostname/uname reads)', async () => {
    const transport = new LocalProcessTransport();
    await transport.connect();
    try {
      const sample = await sampleRemoteResources(transport, { diskPath: '/' });
      expect(sample.healthy).toBe(true);
      expect(sample.memTotalBytes).toBeGreaterThan(0);
      expect(sample.diskTotalBytes).toBeGreaterThan(0);
      expect(sample.loadPercent).toBeGreaterThanOrEqual(0);
      expect(sample.loadPercent).toBeLessThanOrEqual(100);
      expect(sample.cpuPercent).toBe(sample.loadPercent);
      expect(sample.hostname).toBeTruthy();
      expect(sample.platform).toBe(process.platform);
    } finally {
      await transport.close();
    }
  });
});
