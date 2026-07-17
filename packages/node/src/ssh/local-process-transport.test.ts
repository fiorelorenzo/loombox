import { describe, expect, it } from 'vitest';

import { LocalProcessTransport } from './local-process-transport';

describe('LocalProcessTransport', () => {
  it('runs a command and captures stdout/stderr/exitCode', async () => {
    const transport = new LocalProcessTransport();
    await transport.connect();

    const ok = await transport.exec('printf out; printf err 1>&2; exit 0');
    expect(ok).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });

    const failed = await transport.exec('exit 7');
    expect(failed.exitCode).toBe(7);

    await transport.close();
  });

  it('feeds `input` to the command as stdin', async () => {
    const transport = new LocalProcessTransport();
    await transport.connect();

    const result = await transport.exec('cat', { input: 'hello from stdin' });
    expect(result.stdout).toBe('hello from stdin');

    await transport.close();
  });

  it('refuses exec() before connect()', async () => {
    const transport = new LocalProcessTransport();
    await expect(transport.exec('true')).rejects.toThrow(/not connected/);
  });
});
