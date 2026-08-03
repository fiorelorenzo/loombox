import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  evaluateCommand,
  logPolicyViolation,
  PolicyViolationError,
  type PermissionPolicy,
  type PolicyViolation,
} from './permission-policy';
import type { DetailedDirEntry, ExecOptions, ExecResult, ExecutionTarget } from './target';

/**
 * Enforces a project's {@link PermissionPolicy} at `ExecutionTarget.exec()`
 * — `target.ts`'s own doc comment already names this "the unified exec
 * seam... a future editor/terminal drives through", so this is exactly the
 * chokepoint SPEC §7.17 asks for: no command reaches
 * `child_process.spawn` (`LocalExecutionTarget`) or the remote shell
 * (`SshExecutionTarget`/`RemoteTransport.exec`) without first being
 * checked, and a denied command never starts the underlying process at
 * all (`PolicyViolationError` is thrown before `inner.exec` is ever
 * called).
 *
 * **Honesty about what this covers today**: as of this change, nothing in
 * `packages/node` yet drives a *project-scoped* command through
 * `NodeDaemon.getExecutionTarget()` — its only two current callers
 * (`resolveTargetFsPath`'s `pwd` probe and `listDirectoryForTarget`'s
 * `git rev-parse` probe) are both deliberately target-level, pre-session
 * directory browsing, not tied to any one project (see their own doc
 * comments). This decorator is real, tested infrastructure for the
 * project-scoped commands `target.ts`'s doc comment already earmarks for
 * a future editor/terminal — it does not yet gate anything in production
 * beyond the interactive terminal (`policy-enforced-pty.ts`), which is
 * this PR's live enforcement surface. See the PR description for the full
 * surface inventory.
 *
 * The `local`-only symlink-defeat resolution ({@link resolveRealBasename})
 * is wired in automatically when wrapping a `local`-kind target; `ssh:`
 * gets none (a remote `readlink -f` round trip per command was judged not
 * worth the added latency on every exec call — a named, not closed, gap).
 */
export interface PolicyEnforcedExecutionTargetOptions {
  inner: ExecutionTarget;
  /** The project this exec call is being made on behalf of — both the policy lookup key and what a logged/reported violation names. */
  projectPath: string;
  policy: PermissionPolicy;
  /** Called (in addition to the built-in {@link logPolicyViolation} log line) whenever a command is blocked — e.g. so a caller can also surface it on a live channel. */
  onViolation?: (violation: PolicyViolation) => void;
}

/** Resolves `command` through `$PATH` (if it's a bare name) then through every symlink to its real path, returning just the final basename — or `undefined` if it can't be resolved (not found, or a permission error), in which case the caller simply gets no extra candidate rather than a thrown error. */
export function resolveRealBasename(command: string): string | undefined {
  try {
    let located = command;
    if (!command.includes('/')) {
      const dirs = (process.env.PATH ?? '').split(path.delimiter);
      const found = dirs
        .map((dir) => path.join(dir, command))
        .find((candidate) => existsSync(candidate));
      if (!found) return undefined;
      located = found;
    }
    return path.basename(realpathSync(located));
  } catch {
    return undefined;
  }
}

export class PolicyEnforcedExecutionTarget implements ExecutionTarget {
  readonly kind: ExecutionTarget['kind'];

  constructor(private readonly options: PolicyEnforcedExecutionTargetOptions) {
    this.kind = options.inner.kind;
  }

  async exec(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
    const decision = evaluateCommand(this.options.policy, command, args, {
      resolveRealBasename: this.kind === 'local' ? resolveRealBasename : undefined,
    });
    if (!decision.allowed) {
      const violation: PolicyViolation = {
        projectPath: this.options.projectPath,
        surface: 'exec',
        dimension: decision.dimension,
        rule: decision.rule,
        matched: decision.matched,
        command: [command, ...args].join(' '),
        timestamp: new Date().toISOString(),
      };
      logPolicyViolation(violation);
      this.options.onViolation?.(violation);
      throw new PolicyViolationError(violation);
    }
    return this.options.inner.exec(command, args, options);
  }

  readFile(filePath: string): Promise<string> {
    return this.options.inner.readFile(filePath);
  }

  writeFile(filePath: string, content: string): Promise<void> {
    return this.options.inner.writeFile(filePath, content);
  }

  mkdir(dirPath: string): Promise<void> {
    return this.options.inner.mkdir(dirPath);
  }

  readdir(dirPath: string): Promise<string[]> {
    return this.options.inner.readdir(dirPath);
  }

  readdirDetailed(dirPath: string): Promise<DetailedDirEntry[]> {
    return this.options.inner.readdirDetailed(dirPath);
  }
}
