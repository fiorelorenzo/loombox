import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as browser from './browser';
import * as barrel from './index';

/**
 * The browser entry's whole job is a boundary: nothing reachable from it may
 * import a `node:` builtin. `vite build` hides a violation (Rollup tree-shakes
 * the unused Node classes), so it only ever surfaces in `vite dev`, as the app
 * painting correctly and then dying on hydration with `Cannot access
 * "node:events.EventEmitter" in client code`. That is a miserable thing to
 * debug, so the graph is asserted here instead.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Every relative import in a module, resolved to a `.ts` file under `src/`. */
function localImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
  return specifiers.map((specifier) => resolve(dirname(file), `${specifier}.ts`));
}

/** Walks the real import graph from an entry module, following relative imports only. */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...localImports(file));
  }
  return seen;
}

describe('browser entry (@loombox/providers-core/browser)', () => {
  it('pulls in no node: builtin anywhere in its import graph', () => {
    const offenders: string[] = [];
    for (const file of moduleGraph(join(SRC_DIR, 'browser.ts'))) {
      const source = readFileSync(file, 'utf8');
      const nodeImports = [...source.matchAll(/from\s+'(node:[^']+)'/g)].map((m) => m[1]);
      // A type-only import is erased before the browser ever sees it; a value
      // import is what throws.
      const valueImports = nodeImports.filter(
        (specifier) => !new RegExp(`import type \\{[^}]*\\} from '${specifier}'`).test(source),
      );
      if (valueImports.length > 0) {
        offenders.push(`${file.slice(SRC_DIR.length + 1)} -> ${valueImports.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not re-export the EventEmitter-based classes the barrel does', () => {
    // These are the three that make the barrel unusable from a client bundle.
    for (const nodeOnly of ['AcpClient', 'PermissionQueue', 'ConfigOptionStore']) {
      expect(barrel).toHaveProperty(nodeOnly);
      expect(browser).not.toHaveProperty(nodeOnly);
    }
  });

  it('still exports what a client actually needs, including the error class that used to live in client.ts', () => {
    // A representative slice of what apps/web imports; if the boundary is drawn
    // too tight the web app stops compiling, which this catches here instead.
    for (const needed of [
      'createPermissionQueueState',
      'headPermissionRequest',
      'resolvePermissionRequest',
      'createTranscriptState',
      'reduceSessionEvent',
      'parseMcpServerConfig',
      'MCP_SERVER_PRESET_CATALOG',
      'parsePluginConfig',
      'McpServerSecretMissingError',
    ]) {
      expect(browser).toHaveProperty(needed);
    }
  });

  it('keeps the barrel a superset, so Node code never loses an export to this split', () => {
    const missing = Object.keys(browser).filter((name) => !(name in barrel));
    expect(missing).toEqual([]);
  });
});
