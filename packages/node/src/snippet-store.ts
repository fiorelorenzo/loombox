/* ---------------------------------------------------------------------
 * Node-side persistence for a named prompt/snippet catalog (issue #261,
 * epic #29): a small, account-scoped catalog, mirroring `session-
 * template-store.ts`'s own shape and rationale exactly — this node serves
 * exactly one account (`resolve-account-id.ts`), so "per account"
 * collapses to "one list, no scoping key".
 *
 * Like `SessionTemplateStore`, a snippet has no ACP-specific field to
 * narrow: `@loombox/protocol`'s `SnippetV1` IS this store's value type,
 * and `snippetV1.safeParse` IS its on-disk validation — there is no
 * second, hand-rolled schema to keep in sync with the wire one.
 *
 * A single JSON file, mirroring `mcp-config-store.ts`'s own shape and
 * rationale: a node's snippet catalog is small and changes rarely (an
 * infrequent "save this prompt" action, not a hot path), so every
 * mutation re-reads then rewrites the whole file rather than an
 * append-log design.
 * --------------------------------------------------------------------- */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { snippetV1, type SnippetV1 } from '@loombox/protocol';

import { loadJsonFile } from './json-store';
import { defaultNodeStateDir } from './ssh/verify-and-persist';

const SNIPPET_FILE_NAME = 'snippets.json';
const SNIPPET_SCHEMA_VERSION = 1;

interface SnippetFileV1 {
  v: typeof SNIPPET_SCHEMA_VERSION;
  snippets: SnippetV1[];
}

/** Thrown for any malformed on-disk snippet catalog (corrupt JSON, a snippet failing `snippetV1`'s own schema). Never returns a partially-valid result. */
export class SnippetError extends Error {
  constructor(message: string) {
    super(`snippet store: ${message}`);
    this.name = 'SnippetError';
  }
}

function validateFile(parsed: unknown, filePath: string): SnippetFileV1 {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SnippetError(`file "${filePath}" is not a valid snippet catalog`);
  }
  const file = parsed as { snippets?: unknown };
  if (!Array.isArray(file.snippets)) {
    throw new SnippetError(`file "${filePath}" is not a valid snippet catalog`);
  }
  const snippets = file.snippets.map((entry, index) => {
    const result = snippetV1.safeParse(entry);
    if (!result.success) {
      throw new SnippetError(
        `snippets[${index}] in "${filePath}" is invalid: ${result.error.message}`,
      );
    }
    return result.data;
  });
  return { v: SNIPPET_SCHEMA_VERSION, snippets };
}

export interface SnippetStoreOptions {
  /** Injectable for tests (`os.mkdtemp()`); defaults to `defaultNodeStateDir()`, shared with every other node store. */
  stateDir?: string;
}

/**
 * Persists this node's named prompt/snippet catalog across a node restart
 * (issue #261's "persists across sessions and devices" acceptance — this
 * store is the device-local half; `snippet_list_set`/`_get` sync it to
 * every other device on the account). See this module's doc comment for
 * the storage shape/rationale.
 */
export class SnippetStore {
  private readonly filePath: string;

  constructor(options: SnippetStoreOptions = {}) {
    const stateDir = options.stateDir ?? defaultNodeStateDir();
    this.filePath = path.join(stateDir, SNIPPET_FILE_NAME);
  }

  /** Every saved snippet. `[]` for a node with none configured yet. */
  list(): SnippetV1[] {
    return this.readFile().snippets;
  }

  /** One snippet by id, or `undefined` if it doesn't exist (a deleted/never-created id — the caller's own "quiet degrade" case, never this store's to throw on). */
  get(id: string): SnippetV1 | undefined {
    return this.readFile().snippets.find((snippet) => snippet.id === id);
  }

  /** Creates or replaces (by `snippet.id`) the full catalog with `snippets` — mirrors `SessionTemplateStore.saveAll()`'s own "whole value, never a partial patch" contract. */
  saveAll(snippets: readonly SnippetV1[]): void {
    this.writeFile({ v: SNIPPET_SCHEMA_VERSION, snippets: [...snippets] });
  }

  private readFile(): SnippetFileV1 {
    return loadJsonFile(
      this.filePath,
      { v: SNIPPET_SCHEMA_VERSION, snippets: [] },
      validateFile,
      (message) => new SnippetError(message),
    );
  }

  private writeFile(file: SnippetFileV1): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }
}
