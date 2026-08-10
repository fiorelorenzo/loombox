// The shared flat config lives in tooling/eslint-config (@loombox/eslint-config);
// this root file just re-exports it so `eslint .` and editors find it.
//
// Also the one choke point every eslint invocation in the repo goes through:
// ESLint's flat-config search walks up from cwd to find this file regardless
// of which package's `eslint src` or `pnpm exec eslint <file>` triggered it
// (it's the only eslint.config.js in the tree), so it's where the #948
// worktree-leak guard runs for every lint invocation, scoped or not.
import { assertNoWorktreeLeak } from './scripts/check-worktree-leak.mjs';

assertNoWorktreeLeak();

export { default } from '@loombox/eslint-config';
