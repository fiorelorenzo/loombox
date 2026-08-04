// A plain source-scan against the real `svelte/compiler` AST, not a
// rendered-DOM test — mirrors `styles/tokens.test.ts`'s own reasoning (jsdom
// never injects a component's `<style>` block, so the only way to actually
// exercise "does this CSS apply" is to read the same structure the Svelte
// compiler itself parses).
//
// The bug (issue #665): Svelte scopes a component's own selectors with a
// hash class, so `Button.svelte`'s `.ui-button` compiles to
// `.ui-button.svelte-xxxx` — two classes, specificity (0,2,0). A consumer
// overriding it writes `:global(.open)`, which compiles to a bare `.open` —
// one class, specificity (0,1,0). The primitive's own root rule always wins,
// silently: no warning, no error, no lint, and the override is simply never
// painted. Seven real call sites shipped exactly this bug (Inbox row with no
// card and a centred title, onboarding choice cards centred, etc.) before it
// was caught by hand — this test is the guard so that class of bug cannot
// come back through a new call site, or regress at an old one.
//
// The check: compile every `.svelte` file under `apps/web/src`, and for
// every `<Primitive class="foo">` call site (a component invocation with a
// static `class` attribute), assert that no CSS property declared in the
// *consumer's own* `.foo`/`:global(.foo)` rule is also declared on that
// primitive's own scoped root rule (the single, bare class selector its root
// element always renders, e.g. `.ui-button`, `.ui-row`). A colliding
// property can never win that specificity fight, so declaring it there is
// dead weight at best and a silently-discarded override at worst — the fix
// is always a prop on the primitive (`Button`'s `align`, `Row`'s `surface`,
// following `ToolCard`'s `surface` precedent, #576), never a louder
// selector.
//
// This is deliberately AST-based rather than a source-text regex, which
// sidesteps the two traps a naive scanner hits: a `/\/\*.*?\*\//` sweep has
// to be told to strip CSS comments first (a doc comment between a rule's
// `}` and the next selector defeats a naive property match) and a
// `/<Foo[^>]*>/` tag scan has to be brace-aware (an arrow function's `=>`
// inside a sibling `onclick` attribute ends a naive scan early and hides the
// call site entirely). Reading the compiler's own parsed CSS `Declaration`
// nodes and `Attribute` nodes never sees either shape — comments never
// become AST nodes, and an attribute's expression is parsed as real
// JS/TS, not scanned character-by-character.
import { parse, type AST } from 'svelte/compiler';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const libDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(libDir, '..'); // apps/web/src
const rootLibDir = join(srcDir, 'lib');

function walkSvelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSvelteFiles(full, out);
    else if (extname(entry.name) === '.svelte') out.push(full);
  }
  return out;
}

/** `./Foo.svelte` / `../ui/Foo.svelte` / `$lib/components/Foo.svelte` -> an absolute path, or `null` for anything this scan can't resolve to a local file (a bare package import — never a call site this test can check). */
function resolveImportPath(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  if (specifier.startsWith('$lib/')) return resolve(rootLibDir, specifier.slice('$lib/'.length));
  return null;
}

/** The `{...}` expression shape a `class={...}` attribute's `ExpressionTag` can carry — extracted from the AST's own type rather than importing `estree` directly (this package has no direct dependency on `@types/estree`; `svelte/compiler` already resolves it for its own types, and this reaches the same type structurally through them). */
type TagExpression = AST.ExpressionTag['expression'];

/** Unwraps a chain of method calls (every primitive here ends its own `class={...}` expression with `.trim()`) down to the template literal underneath, or `null` if the expression isn't shaped that way. */
function unwrapToTemplateLiteral(
  expr: TagExpression,
): (TagExpression & { type: 'TemplateLiteral' }) | null {
  if (expr.type === 'TemplateLiteral') return expr;
  if (expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression') {
    return unwrapToTemplateLiteral(expr.callee.object as TagExpression);
  }
  return null;
}

/** The root class token a component's own root native element (`RegularElement`/`SvelteElement` — never a nested `Component`, which belongs to a different file's scope) always renders: the first static segment of its `class` attribute. `null` when the file has no single, statically-analyzable root element (most non-primitive components — a false negative here is safe, it just means this file is never checked as a primitive; a false positive would not be). */
function extractRootClass(fragmentNodes: AST.Fragment['nodes']): string | null {
  for (const node of fragmentNodes) {
    if (node.type === 'Text' || node.type === 'Comment') continue;
    if (node.type !== 'RegularElement' && node.type !== 'SvelteElement') return null;
    const classAttr = node.attributes.find(
      (a): a is AST.Attribute => a.type === 'Attribute' && a.name === 'class',
    );
    if (!classAttr || classAttr.value === true) return null;
    const value = Array.isArray(classAttr.value) ? classAttr.value : [classAttr.value];
    const first = value[0];
    if (!first) return null;
    if (first.type === 'Text') return first.data.trim().split(/\s+/)[0] || null;
    if (first.type === 'ExpressionTag') {
      const quasi = unwrapToTemplateLiteral(first.expression)?.quasis[0];
      return quasi ? quasi.value.raw.trim().split(/\s+/)[0] || null : null;
    }
    return null;
  }
  return null;
}

/** Every top-level `Rule` in a `<style>` block whose selector is a single, unqualified class selector — bare (`.foo`) or wrapped in exactly one `:global(...)` (`:global(.foo)`) — mapped to its declared properties. Deliberately narrow: a compound selector (`.a.b`), a combinator (`.a .b`), or a pseudo-qualified one (`.a:hover`) is a different rule than "this class's own resting declarations" and is excluded on purpose, matching the issue's own "root rule" scope. */
function extractSimpleClassRules(css: AST.CSS.StyleSheet | null): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  if (!css) return rules;
  for (const node of css.children) {
    if (node.type !== 'Rule') continue;
    if (node.prelude.children.length !== 1) continue;
    const complex = node.prelude.children[0];
    if (complex.children.length !== 1) continue;
    const relative = complex.children[0];
    if (relative.combinator || relative.selectors.length !== 1) continue;
    const sel = relative.selectors[0];
    let className: string | undefined;
    if (sel.type === 'ClassSelector') {
      className = sel.name;
    } else if (sel.type === 'PseudoClassSelector' && sel.name === 'global') {
      const inner = sel.args;
      if (!inner || inner.children.length !== 1) continue;
      const innerComplex = inner.children[0];
      if (innerComplex.children.length !== 1) continue;
      const innerRelative = innerComplex.children[0];
      if (innerRelative.combinator || innerRelative.selectors.length !== 1) continue;
      const innerSel = innerRelative.selectors[0];
      if (innerSel.type !== 'ClassSelector') continue;
      className = innerSel.name;
    } else {
      continue;
    }
    const props = rules.get(className) ?? new Map<string, string>();
    for (const decl of node.block.children) {
      if (decl.type !== 'Declaration') continue;
      props.set(decl.property, decl.value);
    }
    rules.set(className, props);
  }
  return rules;
}

/** Every nested node-array a template node can hold, across every Svelte 5 control-flow shape — the walk needs all of these to reach a `<Primitive class="foo">` call site regardless of how deep it sits inside `{#if}`/`{#each}`/`{#await}`/`{#snippet}`. */
function childFragments(node: AST.Fragment['nodes'][number]): AST.Fragment['nodes'][] {
  const out: AST.Fragment['nodes'][] = [];
  if ('fragment' in node) out.push(node.fragment.nodes);
  if (node.type === 'IfBlock') {
    out.push(node.consequent.nodes);
    if (node.alternate) out.push(node.alternate.nodes);
  }
  if (node.type === 'EachBlock') {
    out.push(node.body.nodes);
    if (node.fallback) out.push(node.fallback.nodes);
  }
  if (node.type === 'AwaitBlock') {
    if (node.pending) out.push(node.pending.nodes);
    if (node.then) out.push(node.then.nodes);
    if (node.catch) out.push(node.catch.nodes);
  }
  if (node.type === 'SnippetBlock') out.push(node.body.nodes);
  return out;
}

function* walkTemplate(nodes: AST.Fragment['nodes']): Generator<AST.Fragment['nodes'][number]> {
  for (const node of nodes) {
    yield node;
    for (const nested of childFragments(node)) yield* walkTemplate(nested);
  }
}

interface CallSite {
  component: string;
  classes: string[];
  line: number;
}

/** Every `<Component class="foo bar">` call site with a fully-static `class` value, anywhere in the template — a dynamic `class={...}` isn't statically checkable and is skipped, not flagged. */
function extractCallSites(fragmentNodes: AST.Fragment['nodes']): CallSite[] {
  const sites: CallSite[] = [];
  for (const node of walkTemplate(fragmentNodes)) {
    if (node.type !== 'Component') continue;
    const classAttr = node.attributes.find(
      (a): a is AST.Attribute => a.type === 'Attribute' && a.name === 'class',
    );
    if (!classAttr || classAttr.value === true) continue;
    const value = Array.isArray(classAttr.value) ? classAttr.value : [classAttr.value];
    if (value.length !== 1 || value[0].type !== 'Text') continue;
    const classes = value[0].data.trim().split(/\s+/).filter(Boolean);
    sites.push({ component: node.name, classes, line: node.name_loc.start.line });
  }
  return sites;
}

interface ParsedFile {
  rootClass: string | null;
  rootRuleProps: Map<string, string>;
  styleRules: Map<string, Map<string, string>>;
  imports: Map<string, string>;
  callSites: CallSite[];
}

function parseAll(files: string[]): Map<string, ParsedFile> {
  const parsed = new Map<string, ParsedFile>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const ast = parse(source, { modern: true, filename: file });
    const rootClass = extractRootClass(ast.fragment.nodes);
    const styleRules = extractSimpleClassRules(ast.css);
    const imports = new Map<string, string>();
    const body = ast.instance?.content.body ?? [];
    for (const stmt of body) {
      if (stmt.type !== 'ImportDeclaration') continue;
      const specifier = stmt.source.value;
      if (typeof specifier !== 'string' || !specifier.endsWith('.svelte')) continue;
      const resolved = resolveImportPath(file, specifier);
      if (!resolved) continue;
      for (const spec of stmt.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') imports.set(spec.local.name, resolved);
      }
    }
    parsed.set(file, {
      rootClass,
      rootRuleProps: (rootClass && styleRules.get(rootClass)) || new Map(),
      styleRules,
      imports,
      callSites: extractCallSites(ast.fragment.nodes),
    });
  }
  return parsed;
}

interface Violation {
  file: string;
  line: number;
  component: string;
  className: string;
  primitiveFile: string;
  primitiveRootClass: string;
  properties: string[];
}

function findViolations(parsed: Map<string, ParsedFile>): Violation[] {
  const violations: Violation[] = [];
  for (const [file, info] of parsed) {
    for (const site of info.callSites) {
      const targetPath = info.imports.get(site.component);
      if (!targetPath) continue;
      const target = parsed.get(targetPath);
      if (!target?.rootClass || target.rootRuleProps.size === 0) continue;
      for (const className of site.classes) {
        const consumerProps = info.styleRules.get(className);
        if (!consumerProps) continue;
        const properties = [...consumerProps.keys()].filter((p) => target.rootRuleProps.has(p));
        if (properties.length > 0) {
          violations.push({
            file,
            line: site.line,
            component: site.component,
            className,
            primitiveFile: targetPath,
            primitiveRootClass: target.rootClass,
            properties,
          });
        }
      }
    }
  }
  return violations;
}

describe('primitive override scope (issue #665: a CSS override handed to a UI primitive is silently dropped)', () => {
  it("no call site declares a property for a primitive-bound class that also lives on that primitive's own scoped root rule", () => {
    const files = walkSvelteFiles(srcDir);
    // Sanity check on the fixture itself (same discipline `tokens.test.ts`
    // uses): if this collapses to near-zero, the AST walk broke silently
    // rather than the real invariant passing vacuously.
    expect(files.length).toBeGreaterThan(50);

    const parsed = parseAll(files);
    const callSiteCount = [...parsed.values()].reduce((sum, f) => sum + f.callSites.length, 0);
    expect(callSiteCount).toBeGreaterThan(30);

    const violations = findViolations(parsed);
    const message = violations
      .map(
        (v) =>
          `${v.file.slice(srcDir.length + 1)}:${v.line} <${v.component} class="${v.className}"> declares [${v.properties.join(', ')}] ` +
          `— already on ${v.primitiveFile.slice(srcDir.length + 1)}'s .${v.primitiveRootClass} root rule, so this can never win the specificity fight and is silently discarded`,
      )
      .join('\n');

    expect(violations, message).toEqual([]);
  });
});
