import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** One selectable `~/.ssh/config` `Host` alias, with the connection recipe autodetected from it (issue #83, SPEC §7.23 step 1). `identityFiles` is empty when the config (or its inherited global defaults) names none — the add-target flow then falls back to ssh-agent identities (see `ssh-agent.ts`) or manual entry. */
export interface SshConfigHostEntry {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
}

export interface ParseSshConfigOptions {
  /** Overrides the home directory used to expand a leading `~` in `IdentityFile` values; defaults to `os.homedir()`. Tests pass a fixed value so expansion is deterministic. */
  homeDir?: string;
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return `${homeDir}${value.slice(1)}`;
  return value;
}

/**
 * Splits a config line's argument portion into whitespace-separated tokens,
 * honoring a double-quoted token as a single value with embedded spaces —
 * `ssh_config(5)`'s own quoting rule, needed for e.g.
 * `IdentityFile "~/.ssh/quoted key"`.
 */
function tokenize(rest: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      const end = rest.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push(rest.slice(i + 1));
        i = rest.length;
      } else {
        tokens.push(rest.slice(i + 1, end));
        i = end + 1;
      }
    } else {
      let j = i;
      while (j < rest.length && !/\s/.test(rest[j]!)) j++;
      tokens.push(rest.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

interface RawDirectives {
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
}

function emptyDirectives(): RawDirectives {
  return { identityFiles: [] };
}

/** Applies one recognized directive to `target`. Unknown directives (`ForwardAgent`, `ServerAliveInterval`, ...) and malformed values (a non-numeric `Port`, a value-less line) are silently ignored rather than thrown on — a real-world config commonly has plenty this parser doesn't care about. `HostName`/`User`/`Port` are first-value-wins per block (`ssh_config(5)`'s own precedence); `IdentityFile` is cumulative — a host can name several. */
function applyDirective(
  target: RawDirectives,
  keyword: string,
  values: string[],
  homeDir: string,
): void {
  const key = keyword.toLowerCase();
  const value = values[0];
  switch (key) {
    case 'hostname':
      if (value && target.hostName === undefined) target.hostName = value;
      break;
    case 'user':
      if (value && target.user === undefined) target.user = value;
      break;
    case 'port': {
      if (value === undefined) break;
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && target.port === undefined) target.port = port;
      break;
    }
    case 'identityfile':
      if (value) target.identityFiles.push(expandHome(value, homeDir));
      break;
    default:
      break;
  }
}

function isWildcardPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Parses an OpenSSH client config's text content (issue #83, SPEC §7.23 step
 * 1: "loombox reads your `~/.ssh/config`, offers known hosts"). Deliberately
 * a practical subset of the full `ssh_config(5)` grammar, not a complete
 * implementation:
 *
 * - Tracks `Host` blocks in file order; a line's directives attach to the
 *   nearest preceding `Host` block.
 * - A `Host` line may name several space-separated aliases at once, all
 *   sharing the same recipe (`Host mac macbook`).
 * - Directives appearing before the first `Host` line are global defaults,
 *   inherited by every concrete host below that doesn't set its own value —
 *   real ssh's own "applies until overridden" behavior, simplified: no
 *   `Match`/`Include` support, and no full glob-pattern precedence between
 *   multiple `Host` blocks (a later, more specific pattern does not layer
 *   over an earlier broader one the way real `ssh_config(5)` resolution
 *   does).
 * - A pattern containing `*` or `?` is never offered as a selectable
 *   candidate — there's no single concrete host to connect to — and its
 *   directives are not folded back into the global defaults either (a known,
 *   documented simplification).
 * - Malformed or unrecognized lines never throw; they're skipped, matching
 *   `loadSshConfig`'s "falls back to manual entry when nothing is
 *   discoverable" contract at the file level.
 */
export function parseSshConfig(
  content: string,
  options: ParseSshConfigOptions = {},
): SshConfigHostEntry[] {
  const homeDir = options.homeDir ?? homedir();
  const globalDefaults = emptyDirectives();
  const blocksByAlias = new Map<string, RawDirectives>();
  const aliasOrder: string[] = [];
  let current: RawDirectives | undefined;
  let sawHostLine = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const spaceIndex = line.search(/\s/);
    const keyword = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const rest = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1);

    if (keyword.toLowerCase() === 'host') {
      sawHostLine = true;
      current = emptyDirectives();
      for (const pattern of tokenize(rest)) {
        if (isWildcardPattern(pattern)) continue;
        if (!blocksByAlias.has(pattern)) {
          blocksByAlias.set(pattern, current);
          aliasOrder.push(pattern);
        }
      }
      continue;
    }

    const target = sawHostLine ? current : globalDefaults;
    if (!target) continue; // directive before any concrete Host block exists
    applyDirective(target, keyword, tokenize(rest), homeDir);
  }

  return aliasOrder.map((alias) => {
    const raw = blocksByAlias.get(alias)!;
    return {
      alias,
      hostName: raw.hostName ?? globalDefaults.hostName,
      user: raw.user ?? globalDefaults.user,
      port: raw.port ?? globalDefaults.port,
      identityFiles:
        raw.identityFiles.length > 0 ? raw.identityFiles : globalDefaults.identityFiles,
    };
  });
}

/**
 * Reads and parses `configPath` (default `~/.ssh/config`). Never throws: a
 * missing file — the common case for a user who has never used SSH aliases —
 * resolves to `[]`, which is exactly what should make the add-target flow
 * fall back to manual entry (issue #83's acceptance criterion) rather than
 * erroring.
 */
export async function loadSshConfig(
  configPath?: string,
  options: ParseSshConfigOptions = {},
): Promise<SshConfigHostEntry[]> {
  const homeDir = options.homeDir ?? homedir();
  const filePath = configPath ?? path.join(homeDir, '.ssh', 'config');
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return parseSshConfig(content, { ...options, homeDir });
}
