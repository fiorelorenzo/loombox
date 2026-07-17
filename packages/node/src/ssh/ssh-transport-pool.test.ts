import { describe, expect, it } from 'vitest';

import { FakeTransport } from './fake-transport';
import { SshTransportPool } from './ssh-transport-pool';
import type { RemoteTransport } from './remote-transport';

const noSleep = async (): Promise<void> => {};

describe('SshTransportPool', () => {
  it('reuses one connection per target key across multiple get() calls', async () => {
    const createCounts = new Map<string, number>();
    const createTransport = (key: string) => (): RemoteTransport => {
      createCounts.set(key, (createCounts.get(key) ?? 0) + 1);
      return new FakeTransport({ onExec: () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) });
    };

    const pool = new SshTransportPool({ reconnect: { sleep: noSleep } });
    const a1 = await pool.get('devbox', createTransport('devbox'));
    const a2 = await pool.get('devbox', createTransport('devbox'));
    const b1 = await pool.get('staging', createTransport('staging'));

    expect(a1).toBe(a2); // same pooled transport object for the same key
    expect(a1).not.toBe(b1);
    expect(createCounts.get('devbox')).toBe(1);
    expect(createCounts.get('staging')).toBe(1);
  });

  it('exposes queryable health per target', async () => {
    const pool = new SshTransportPool({ reconnect: { sleep: noSleep } });
    expect(pool.health('devbox')).toBeUndefined();

    await pool.get('devbox', () => new FakeTransport());
    expect(pool.health('devbox')).toMatchObject({ status: 'connected' });
  });

  it('close(key) forgets the pooled connection so a later get() opens a fresh one', async () => {
    let createCount = 0;
    const createTransport = (): RemoteTransport => {
      createCount += 1;
      return new FakeTransport();
    };

    const pool = new SshTransportPool({ reconnect: { sleep: noSleep } });
    const first = await pool.get('devbox', createTransport);
    await pool.close('devbox');
    expect(pool.health('devbox')).toBeUndefined();

    const second = await pool.get('devbox', createTransport);
    expect(second).not.toBe(first);
    expect(createCount).toBe(2);
  });

  it('closeAll() closes every pooled connection, tolerating an individual close failure', async () => {
    const closed: string[] = [];
    const makeTransport = (key: string): RemoteTransport => ({
      connect: async () => {},
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      close: async () => {
        if (key === 'flaky') throw new Error('boom');
        closed.push(key);
      },
    });

    const pool = new SshTransportPool({ reconnect: { sleep: noSleep } });
    await pool.get('devbox', () => makeTransport('devbox'));
    await pool.get('flaky', () => makeTransport('flaky'));

    await expect(pool.closeAll()).resolves.toBeUndefined();
    expect(closed).toEqual(['devbox']);
    expect(pool.health('devbox')).toBeUndefined();
    expect(pool.health('flaky')).toBeUndefined();
  });
});
