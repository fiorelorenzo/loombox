/* ---------------------------------------------------------------------
 * Node-side persistence for the per-project test/lint/build command
 * configuration (SPEC §7.15; issue #245): one JSON file, mirroring
 * `permission-policy-store.ts`'s own shape/rationale almost exactly — a
 * project's runner commands are small and change rarely (a user typing
 * three command strings once, or accepting a detected suggestion), so
 * every mutation re-reads then rewrites the whole file rather than an
 * append log. Keyed by a project's absolute `projectPath`, the same
 * identifier `PermissionPolicyStore`/`McpConfigStore` already key their
 * own per-project records on.
 *
 * No "global" tier, same reasoning as `PermissionPolicyStore`: a project's
 * test/lint/build commands are inherently project-specific (there is no
 * sensible cross-project default), so unlike `McpConfigStore`'s
 * global-plus-override shape there is nothing to inherit from.
 * --------------------------------------------------------------------- */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultNodeStateDir } from './ssh/verify-and-persist';

const TEST_RUNNER_CONFIG_FILE_NAME = 'test-runner-config.json';
const TEST_RUNNER_CONFIG_SCHEMA_VERSION = 1;

/** A project's saved test/lint/build commands. A key absent from the object means "not configured", never a guessed default — matches `TestRunnerCommandsV1`'s own wire contract (`@loombox/protocol`). */
export interface TestRunnerCommands {
  test?: string;
  lint?: string;
  build?: string;
}

interface TestRunnerConfigFileV1 {
  v: 1;
  projects: Record<string, TestRunnerCommands>;
}

/** Thrown for any malformed on-disk config (corrupt JSON, a non-string command). Never returns a partially-valid result. */
export class TestRunnerConfigError extends Error {
  constructor(message: string) {
    super(`test runner config store: ${message}`);
    this.name = 'TestRunnerConfigError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COMMAND_KEYS = ['test', 'lint', 'build'] as const;

function validateCommands(raw: unknown, context: string): TestRunnerCommands {
  if (typeof raw !== 'object' || raw === null) {
    throw new TestRunnerConfigError(`${context}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const commands: TestRunnerCommands = {};
  for (const key of COMMAND_KEYS) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw new TestRunnerConfigError(`${context}.${key}: must be a non-empty string`);
    }
    commands[key] = value;
  }
  return commands;
}

function validateFile(parsed: unknown, filePath: string): TestRunnerConfigFileV1 {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TestRunnerConfigError(`config file "${filePath}" must contain a JSON object`);
  }
  const obj = parsed as { projects?: unknown };
  const projects: Record<string, TestRunnerCommands> = {};
  if (obj.projects !== undefined) {
    if (typeof obj.projects !== 'object' || obj.projects === null || Array.isArray(obj.projects)) {
      throw new TestRunnerConfigError(`config file "${filePath}": "projects" must be an object`);
    }
    for (const [projectPath, value] of Object.entries(obj.projects)) {
      projects[projectPath] = validateCommands(value, `${filePath} (project "${projectPath}")`);
    }
  }
  return { v: TEST_RUNNER_CONFIG_SCHEMA_VERSION, projects };
}

export interface TestRunnerConfigStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's per-project test/lint/build commands (SPEC §7.15;
 * issue #245) across a node restart. See this module's doc comment for the
 * storage shape/rationale.
 */
export class TestRunnerConfigStore {
  private readonly filePath: string;

  constructor(options: TestRunnerConfigStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, TEST_RUNNER_CONFIG_FILE_NAME);
  }

  /** `projectPath`'s saved commands, or `{}` (nothing configured — never a guessed default) when nothing has been saved for it. */
  get(projectPath: string): TestRunnerCommands {
    return this.readFile().projects[projectPath] ?? {};
  }

  /**
   * Merges `commands` over `projectPath`'s existing saved commands (a key
   * present in `commands` overwrites, a key simply absent from `commands`
   * is left as whatever was already saved — the UI only ever submits the
   * field(s) the user actually changed/confirmed, e.g. accepting just the
   * detected `test` suggestion must not clear an already-saved `lint`).
   * Pass an explicit empty string nowhere — {@link validateCommands}
   * (via {@link readFile}) already rejects that on the next read, and
   * `unset` below is the real way to clear one.
   */
  save(projectPath: string, commands: TestRunnerCommands): TestRunnerCommands {
    const file = this.readFile();
    const merged = { ...file.projects[projectPath], ...commands };
    file.projects[projectPath] = merged;
    this.writeFile(file);
    return merged;
  }

  /** Clears one saved command key (reverting it to "not configured"), leaving the other keys untouched. A no-op if `projectPath` had nothing saved for `key`. */
  unset(projectPath: string, key: keyof TestRunnerCommands): TestRunnerCommands {
    const file = this.readFile();
    const existing = { ...file.projects[projectPath] };
    delete existing[key];
    file.projects[projectPath] = existing;
    this.writeFile(file);
    return existing;
  }

  private readFile(): TestRunnerConfigFileV1 {
    if (!existsSync(this.filePath)) {
      return { v: TEST_RUNNER_CONFIG_SCHEMA_VERSION, projects: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new TestRunnerConfigError(
        `config file "${this.filePath}" is not valid JSON: ${errorMessage(error)}`,
      );
    }
    return validateFile(parsed, this.filePath);
  }

  private writeFile(file: TestRunnerConfigFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
