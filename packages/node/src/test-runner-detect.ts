import { z } from 'zod';

import type { ExecutionTarget } from './target';
import type { TestRunnerCommands } from './test-runner-config-store';

/**
 * Auto-detects a project's test/lint/build commands from its
 * `package.json` `scripts` block (SPEC §7.15; issue #245's "at least the
 * common cases in this monorepo's own stack — pnpm scripts"). Deliberately
 * dumb and honest: a suggestion is only ever produced for a script name
 * that genuinely exists in `package.json` — never a guessed default for a
 * project with no matching script, per the issue's own bar ("detecting
 * `pnpm test` from a `package.json` scripts block is real; guessing a
 * command that does not exist is worse than offering nothing"). Returns
 * `{}` (no suggestions) whenever `package.json` is missing, unreadable, or
 * malformed, or has no `scripts` object at all — never throws, since
 * "nothing detectable" is this function's own honest, expected outcome for
 * a non-Node project, not an error.
 *
 * Runs entirely through `target` (`ExecutionTarget`'s `readFile`/`readdir`)
 * so it works identically for a `local` or an `ssh:` project — the exact
 * same seam `probeProviderAvailability` already uses to look at a project
 * on either kind of target uniformly.
 */
export async function detectTestRunnerCommands(
  target: ExecutionTarget,
  projectPath: string,
): Promise<TestRunnerCommands> {
  const scripts = await readScripts(target, projectPath);
  if (!scripts) return {};

  const packageManager = await detectPackageManager(target, projectPath);
  const suggestions: TestRunnerCommands = {};
  if (typeof scripts.test === 'string') suggestions.test = commandFor(packageManager, 'test');
  if (typeof scripts.lint === 'string') suggestions.lint = commandFor(packageManager, 'lint');
  if (typeof scripts.build === 'string') suggestions.build = commandFor(packageManager, 'build');
  return suggestions;
}

type PackageManager = 'pnpm' | 'yarn' | 'npm';

/** `pnpm`/`yarn` both support running any named script directly (`pnpm test`, `yarn lint` — this repo's own `AGENTS.md` uses exactly this pnpm shorthand); `npm` only special-cases `test`/`start`/`stop`/`restart` that way, so every other script name needs the explicit `npm run <script>` form. */
function commandFor(packageManager: PackageManager, script: 'test' | 'lint' | 'build'): string {
  if (packageManager === 'npm' && script !== 'test') return `npm run ${script}`;
  return `${packageManager} ${script}`;
}

/** `package.json`'s one field this module reads, validated rather than cast (external file content — SPEC repo convention: validate at the boundary). Every other field is ignored, and a package.json that doesn't even match this much (or isn't valid JSON, or doesn't exist) is treated as "no scripts", not an error. */
const packageJsonScriptsShape = z.object({
  scripts: z.record(z.string(), z.unknown()).optional(),
});

async function readScripts(
  target: ExecutionTarget,
  projectPath: string,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await target.readFile(joinPath(projectPath, 'package.json'));
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = packageJsonScriptsShape.safeParse(parsed);
  if (!result.success) return undefined;
  return result.data.scripts;
}

/** Picks the package manager whose lockfile is present in `projectPath`'s root, preferring the most specific one a monorepo could have; falls back to `npm` (the one every `package.json`-having project can run, whether or not a lockfile happens to be committed) when none is found. */
async function detectPackageManager(
  target: ExecutionTarget,
  projectPath: string,
): Promise<PackageManager> {
  let entries: string[];
  try {
    entries = await target.readdir(projectPath);
  } catch {
    return 'npm';
  }
  if (entries.includes('pnpm-lock.yaml')) return 'pnpm';
  if (entries.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

function joinPath(projectPath: string, fileName: string): string {
  return projectPath.endsWith('/') ? `${projectPath}${fileName}` : `${projectPath}/${fileName}`;
}
