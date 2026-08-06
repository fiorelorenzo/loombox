#!/usr/bin/env node
/**
 * `pnpm --filter @loombox/supervisor run bundle` (issue #817): the
 * supervisor's own ESM bundle target (decision A1-2's "one esbuild bundle
 * ... per component"). Not wired into the ssh-provisioned artifact today —
 * `@loombox/node`'s own bundle already inlines `@loombox/supervisor` as an
 * ordinary workspace dependency, and that combined bundle is what
 * `~/.loombox/versions/<version>/node.mjs` actually ships (see
 * `packages/node/scripts/bundle.mjs`'s doc comment). This bundle exists so
 * the supervisor is independently buildable/importable the moment a future
 * local platform backend (#654, #658 — explicitly out of this issue's
 * scope) needs to run it as its own process rather than in-process inside
 * the node.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundlePackage } from '../../../scripts/lib/bundle-package.mjs';

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await bundlePackage({
  pkgDir,
  entry: 'src/index.ts',
  outfile: 'dist/index.mjs',
  external: ['node-pty'],
});

console.log(
  `bundled @loombox/supervisor ${result.version} -> ${path.relative(pkgDir, result.outfile)}`,
);
