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

describe('failedSample', () => {
  it('is unhealthy with every figure zeroed out', () => {
    expect(failedSample(123)).toEqual({
      cpuPercent: 0,
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
  };

  it('computes mem percent/used/total from injected os figures', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
      checkDiskSpaceFn: async () => ({ diskPath: '/', free: 100, size: 400 }),
      now: () => 999,
    });
    expect(sample.healthy).toBe(true);
    expect(sample.memTotalBytes).toBe(16_000_000_000);
    expect(sample.memUsedBytes).toBe(12_000_000_000);
    expect(sample.memPercent).toBe(75);
    expect(sample.sampledAt).toBe(999);
  });

  it('computes cpu percent from loadavg[0] normalized by core count', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs, // load1=4, 8 cores -> 50%
      checkDiskSpaceFn: async () => ({ diskPath: '/', free: 100, size: 400 }),
    });
    expect(sample.cpuPercent).toBe(50);
  });

  it('clamps cpu percent to 100 when load average exceeds core count', async () => {
    const overloaded: LocalOsSource = { ...fakeOs, loadavg: () => [40, 30, 20] };
    const sample = await sampleLocalResources({
      osSource: overloaded,
      checkDiskSpaceFn: async () => ({ diskPath: '/', free: 100, size: 400 }),
    });
    expect(sample.cpuPercent).toBe(100);
  });

  it('computes disk percent/used/total from check-disk-space', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
      checkDiskSpaceFn: async () => ({ diskPath: '/home', free: 100, size: 500 }),
    });
    expect(sample.diskTotalBytes).toBe(500);
    expect(sample.diskUsedBytes).toBe(400);
    expect(sample.diskPercent).toBe(80);
  });

  it('returns a failed sample when check-disk-space rejects', async () => {
    const sample = await sampleLocalResources({
      osSource: fakeOs,
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
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(sample.cpuPercent).toBeLessThanOrEqual(100);
    expect(sample.diskTotalBytes).toBeGreaterThan(0);
  });
});

describe('parseRemoteSample', () => {
  it('parses a well-formed KEY=VALUE block into a healthy sample', () => {
    const stdout = [
      'NPROC=8',
      'LOAD=4',
      'MEMTOTAL=16000000000',
      'MEMFREE=4000000000',
      'DISK=400 320 80',
      '',
    ].join('\n');
    const sample = parseRemoteSample(stdout, 42);
    expect(sample.healthy).toBe(true);
    expect(sample.cpuPercent).toBe(50);
    expect(sample.memTotalBytes).toBe(16_000_000_000);
    expect(sample.memUsedBytes).toBe(12_000_000_000);
    expect(sample.memPercent).toBe(75);
    expect(sample.diskTotalBytes).toBe(400 * 1024);
    expect(sample.diskUsedBytes).toBe(320 * 1024);
    expect(sample.diskPercent).toBe(80);
    expect(sample.sampledAt).toBe(42);
  });

  it('clamps cpu percent past 100 when load exceeds core count', () => {
    const stdout = ['NPROC=2', 'LOAD=8', 'MEMTOTAL=100', 'MEMFREE=50', 'DISK=100 50 50'].join('\n');
    expect(parseRemoteSample(stdout, 1).cpuPercent).toBe(100);
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

  it('samples the real local shell end-to-end via LocalProcessTransport (proves the script actually runs under dash/sh)', async () => {
    const transport = new LocalProcessTransport();
    await transport.connect();
    try {
      const sample = await sampleRemoteResources(transport, { diskPath: '/' });
      expect(sample.healthy).toBe(true);
      expect(sample.memTotalBytes).toBeGreaterThan(0);
      expect(sample.diskTotalBytes).toBeGreaterThan(0);
      expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(sample.cpuPercent).toBeLessThanOrEqual(100);
    } finally {
      await transport.close();
    }
  });
});
