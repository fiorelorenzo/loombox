import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseSshConfig, loadSshConfig } from './ssh-config';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'ssh-config',
);

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

describe('parseSshConfig', () => {
  it('parses a single Host block (HostName, User, Port, IdentityFile)', async () => {
    const entries = parseSshConfig(await readFixture('single-host'), { homeDir: '/home/tester' });
    expect(entries).toEqual([
      {
        alias: 'devbox',
        hostName: '100.87.202.117',
        user: 'dev',
        port: 22,
        identityFiles: ['/home/tester/.ssh/id_ed25519'],
      },
    ]);
  });

  it('parses multiple Host blocks, applies global defaults, expands multiple aliases and multiple IdentityFile lines, and skips wildcard-only patterns', async () => {
    const entries = parseSshConfig(await readFixture('multiple-hosts'), {
      homeDir: '/home/tester',
    });

    expect(entries.map((entry) => entry.alias)).toEqual(['prodbox', 'staging', 'mac', 'macbook']);

    const prodbox = entries.find((entry) => entry.alias === 'prodbox');
    expect(prodbox).toMatchObject({
      hostName: '100.78.245.39',
      user: 'prod',
      port: 22,
      identityFiles: ['/home/tester/.ssh/id_ed25519'],
    });

    // Inherits the global default User since its own block never sets one.
    const staging = entries.find((entry) => entry.alias === 'staging');
    expect(staging).toMatchObject({
      hostName: 'staging.example.com',
      user: 'defaultuser',
      port: 2222,
    });

    // Both aliases on one `Host` line get the same recipe, including two
    // IdentityFile lines collected in order (not overwritten).
    const mac = entries.find((entry) => entry.alias === 'mac');
    const macbook = entries.find((entry) => entry.alias === 'macbook');
    expect(mac).toMatchObject({
      hostName: '100.82.41.78',
      user: 'lorenzofiore',
      identityFiles: ['/home/tester/.ssh/id_ed25519', '/home/tester/.ssh/macbook_key'],
    });
    expect(macbook).toEqual(mac ? { ...mac, alias: 'macbook' } : undefined);

    // `Host *.internal` is wildcard-only — not offered as a selectable host.
    expect(entries.some((entry) => entry.alias.includes('*'))).toBe(false);
    expect(entries.some((entry) => entry.alias === '*.internal')).toBe(false);
  });

  it('tolerates malformed/unknown directives, invalid ports, and value-less lines without throwing', async () => {
    const entries = parseSshConfig(await readFixture('malformed'), { homeDir: '/home/tester' });

    expect(entries).toHaveLength(1);
    const [goodHost] = entries;
    expect(goodHost.alias).toBe('good-host');
    expect(goodHost.hostName).toBe('good.example.com');
    // "Port not-a-number" is not a valid port — left unset rather than NaN.
    expect(goodHost.port).toBeUndefined();
    // A value-less "User" line contributes nothing.
    expect(goodHost.user).toBeUndefined();
    // A quoted IdentityFile value has its quotes stripped and `~` expanded.
    expect(goodHost.identityFiles).toEqual(['/home/tester/.ssh/quoted key']);
  });

  it('returns an empty list for empty/whitespace-only content', () => {
    expect(parseSshConfig('')).toEqual([]);
    expect(parseSshConfig('\n\n  \n')).toEqual([]);
  });

  it('expands a bare "~" IdentityFile prefix using the supplied homeDir', () => {
    const entries = parseSshConfig('Host x\n  HostName x.example.com\n  IdentityFile ~/id_rsa\n', {
      homeDir: '/home/other',
    });
    expect(entries[0]?.identityFiles).toEqual(['/home/other/id_rsa']);
  });

  it('leaves an absolute IdentityFile path untouched', () => {
    const entries = parseSshConfig(
      'Host x\n  HostName x.example.com\n  IdentityFile /etc/ssh/keys/id_rsa\n',
    );
    expect(entries[0]?.identityFiles).toEqual(['/etc/ssh/keys/id_rsa']);
  });
});

describe('loadSshConfig', () => {
  it('reads and parses a real file from disk', async () => {
    const entries = await loadSshConfig(path.join(fixturesDir, 'single-host'), {
      homeDir: '/home/tester',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.alias).toBe('devbox');
  });

  it('returns an empty list (never throws) when the file does not exist — the "falls back to manual entry" case', async () => {
    const entries = await loadSshConfig(path.join(fixturesDir, 'does-not-exist'), {
      homeDir: '/home/tester',
    });
    expect(entries).toEqual([]);
  });
});
