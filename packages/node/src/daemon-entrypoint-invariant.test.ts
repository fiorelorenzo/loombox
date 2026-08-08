import { describe, expect, it } from 'vitest';

import { assertDirectDaemonEntrypoint } from './daemon-entrypoint-invariant';

describe('assertDirectDaemonEntrypoint (issue #929)', () => {
  it('accepts a plain compiled-bundle entrypoint — the real shape every unit generator in this package actually uses', () => {
    expect(() =>
      assertDirectDaemonEntrypoint('/usr/bin/node', [
        '/home/loombox/.loombox/current/node.mjs',
        '--node',
      ]),
    ).not.toThrow();
  });

  it('accepts the staged supervisor binary directly, no interpreter in front', () => {
    expect(() =>
      assertDirectDaemonEntrypoint('/home/loombox/.loombox/supervisor/supervisor-bin', ['--node']),
    ).not.toThrow();
  });

  it("refuses tsx named in execArgs — issue #929's own incident: `node tsx/dist/cli.mjs main.ts`", () => {
    expect(() =>
      assertDirectDaemonEntrypoint('/usr/bin/node', [
        '/home/loombox/node_modules/tsx/dist/cli.mjs',
        'main.ts',
      ]),
    ).toThrow(/names "tsx", a known forking/);
  });

  it('refuses execStart naming the wrapper directly', () => {
    expect(() => assertDirectDaemonEntrypoint('/usr/local/bin/tsx')).toThrow(/known forking/);
  });

  it('refuses a `.bin` shim ending in the wrapper name', () => {
    expect(() => assertDirectDaemonEntrypoint('/home/loombox/node_modules/.bin/tsx')).toThrow(
      /known forking/,
    );
  });

  it.each(['ts-node', 'ts-node-dev', 'ts-node-esm', 'nodemon', 'pm2', 'forever'])(
    'refuses the other known forking wrappers too (%s)',
    (wrapper) => {
      expect(() =>
        assertDirectDaemonEntrypoint('/usr/bin/node', [`/x/node_modules/${wrapper}/bin.js`]),
      ).toThrow(/known forking/);
    },
  );

  it('is case-insensitive and extension-insensitive on the matched segment', () => {
    expect(() => assertDirectDaemonEntrypoint('/x/TSX.mjs')).toThrow(/known forking/);
  });

  it('never false-positives on an unrelated path merely containing the substring "tsx"', () => {
    // A real directory/file name that CONTAINS "tsx" but isn't the package
    // itself must never trip this — only an exact path-segment match does.
    expect(() =>
      assertDirectDaemonEntrypoint('/home/loombox/tsx-migration-notes/node.mjs'),
    ).not.toThrow();
  });
});
