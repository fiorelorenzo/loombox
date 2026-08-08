#!/usr/bin/env node
/**
 * Points git at `.githooks/` so a staged changeset is Prettier-formatted before it
 * can reach CI (issue #723). Run from the root `prepare` script, which means it also
 * runs in places that are not a git checkout at all.
 *
 * The Docker build stages copy the source tree in without `.git` and without a `git`
 * binary, so the original one-liner (`git config core.hooksPath .githooks`) failed the
 * whole `pnpm install` with `sh: git: not found` and took the preview deploy down with
 * it (issue #926). A dev-convenience hook must never be able to fail a build, so every
 * reason this cannot run is a silent, successful no-op.
 */
import { execFileSync } from 'node:child_process';

function skip(reason) {
	// Deliberately quiet on stdout: this runs on every `pnpm install`.
	if (process.env.LOOMBOX_HOOKS_DEBUG) console.log(`install-git-hooks: skipped, ${reason}`);
	process.exit(0);
}

try {
	const inWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
		stdio: ['ignore', 'pipe', 'ignore'],
		encoding: 'utf8',
	}).trim();
	if (inWorkTree !== 'true') skip('not inside a git work tree');
} catch {
	skip('no usable git (missing binary, or not a repository)');
}

try {
	execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
	skip('git config refused (read-only or restricted checkout)');
}
