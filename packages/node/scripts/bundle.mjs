#!/usr/bin/env node
/**
 * `pnpm --filter @loombox/node run bundle` (issue #817): produces the
 * single self-contained ESM entry the `~/.loombox/versions/<version>/`
 * install layout ships — `dist/node.mjs` plus its own trimmed
 * `package.json` and `dist/node_modules/{node-pty,@napi-rs/keyring,...}` —
 * runnable with only the system Node, from a directory with no monorepo
 * and no other node_modules (verified: see the PR this landed in).
 *
 * `node-pty` and `@napi-rs/keyring` are the two native dependencies
 * (decision A1-2); both stay `external` to esbuild and get physically
 * copied beside the bundle instead — a bundler cannot inline a compiled
 * `.node` binary. `ssh2`'s own optional native accelerators
 * (`cpu-features`, `nan`) are also external: they're wrapped in the
 * package's own try/catch probe and never installed on most hosts anyway
 * (this workspace's own `pnpm install` didn't build them), so bundling
 * around their absence, not their presence, is the correct default.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundlePackage } from '../../../scripts/lib/bundle-package.mjs';

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await bundlePackage({
  pkgDir,
  entry: 'src/main.ts',
  outfile: 'dist/node.mjs',
  external: ['node-pty', '@napi-rs/keyring', 'cpu-features', 'nan'],
  // node-pty is @loombox/supervisor's own dependency (inlined into this
  // bundle transitively, not a direct dependency of @loombox/node) —
  // pnpm's strict node_modules never exposes it from this package
  // directory directly, so its native-module resolution must follow
  // ../supervisor's own dependency graph instead.
  nativeModules: [{ name: 'node-pty', fromDir: '../supervisor' }, '@napi-rs/keyring'],
  bakeBuildCommit: true,
});

console.log(
  `bundled @loombox/node ${result.version} -> ${path.relative(pkgDir, result.outfile)}` +
    (result.bakedCommit ? ` (commit ${result.bakedCommit})` : ' (no commit baked in)'),
);
