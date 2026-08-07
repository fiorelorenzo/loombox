import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { mapConfigOptions } from './client';

/**
 * Regression test for issue #633: `config_option_update`'s field names and
 * shape were audited field-by-field against the REAL, pinned
 * `@agentclientprotocol/sdk@1.3.0` schema (this package's own devDependency
 * — added specifically so this file can import and execute it, not just
 * quote it) rather than against the docs site or a fixture that mirrors
 * loombox's own assumption. `client.ts`'s `RawConfigOption`/
 * `RawSessionUpdate`/`mapConfigOptions` doc comments carry the resulting
 * file+line citations; this file turns those citations into an executable
 * check that runs the SDK's OWN generated zod schema — not a hand-rolled
 * copy of it — against the exact payload shapes this client sends and
 * receives, so a future SDK version bump that renames or reshapes
 * `SessionConfigOption`/`ConfigOptionUpdate` fails this test instead of
 * silently reintroducing a #623/#633-class bug in production.
 *
 * `@agentclientprotocol/sdk`'s own `package.json` "exports" map only lists
 * its top-level entry point (`dist/acp.js`, which re-exports TYPES only —
 * useless for a runtime check) plus a couple of `experimental/*` subpaths;
 * `dist/schema/zod.gen.js`, where the actual zod schema objects live, is
 * real, published, on-disk source but not a specifier Node's resolver will
 * hand back for a bare `@agentclientprotocol/sdk/dist/schema/zod.gen.js`
 * import (confirmed directly: `ERR_PACKAGE_PATH_NOT_EXPORTED`). Resolving
 * the package's exported `.` entry first (which IS allowed) and building
 * the sibling file path from there, then importing that exact file:// URL
 * directly, sidesteps the "exports" restriction without reaching into
 * pnpm's private `.pnpm` store layout by hand — the restriction is a
 * bare-specifier resolution policy, not a boundary around the file itself.
 */
async function loadAcpSdkZodSchemas(): Promise<{
  zSessionConfigOption: z.ZodTypeAny;
  zConfigOptionUpdate: z.ZodTypeAny;
  zSessionNotification: z.ZodTypeAny;
}> {
  const require = createRequire(import.meta.url);
  const mainEntryPath = require.resolve('@agentclientprotocol/sdk'); // .../dist/acp.js
  const packageRoot = path.dirname(path.dirname(mainEntryPath)); // strip dist/acp.js
  const zodGenPath = path.join(packageRoot, 'dist', 'schema', 'zod.gen.js');
  // Exception (ts-no-dynamic-import): `zodGenPath` is a path computed at
  // runtime from wherever pnpm actually resolved the pinned SDK's package
  // root — it cannot be a static specifier, and package.json's "exports"
  // map blocks a static `@agentclientprotocol/sdk/dist/schema/zod.gen.js`
  // import outright regardless (see this function's own doc comment).
  const mod: unknown = await import(pathToFileURL(zodGenPath).href);
  return mod as {
    zSessionConfigOption: z.ZodTypeAny;
    zConfigOptionUpdate: z.ZodTypeAny;
    zSessionNotification: z.ZodTypeAny;
  };
}

const RECORDED_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'omp-acp-session-new-response.json',
);
interface RecordedConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}
const recorded = JSON.parse(readFileSync(RECORDED_PATH, 'utf8')) as {
  sessionNewResult: { configOptions: RecordedConfigOption[] };
};

describe('config_option_update vs. the real @agentclientprotocol/sdk schema (issue #633)', () => {
  it("the real omp acp binary's recorded session/new configOptions catalog — the same recording mapConfigOptions's own tests already rely on — parses against the SDK's own zSessionConfigOption schema verbatim, proving it's genuine ACP data, not a fixture shaped after loombox's own assumption", async () => {
    const { zSessionConfigOption } = await loadAcpSdkZodSchemas();
    for (const option of recorded.sessionNewResult.configOptions) {
      const result = zSessionConfigOption.safeParse(option);
      expect(
        result.success,
        `category "${option.category}": ${JSON.stringify('error' in result ? result.error?.issues : undefined)}`,
      ).toBe(true);
    }
  });

  it("a config_option_update notification shaped exactly like test/fixtures/config-acp-agent.mjs sends it (sessionUpdate: 'config_option_update', configOptions: [...]) parses against the SDK's own zSessionNotification schema", async () => {
    const { zSessionNotification } = await loadAcpSdkZodSchemas();
    const notification = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: recorded.sessionNewResult.configOptions,
      },
    };
    const result = zSessionNotification.safeParse(notification);
    expect(result.success).toBe(true);
  });

  it("REJECTS the exact invented shape issue #633 was filed about — sessionUpdate discriminant renamed to kind, configOptions renamed to options — turning the audit's finding into an executable check rather than a comment nobody re-verifies", async () => {
    const { zSessionNotification } = await loadAcpSdkZodSchemas();
    const inventedShapeNotification = {
      sessionId: 'sess-1',
      update: {
        kind: 'config_option_update',
        options: recorded.sessionNewResult.configOptions.map((option) => ({
          category: option.category,
          current: option.currentValue,
          choices: option.options.map((choice) => ({ id: choice.value, name: choice.name })),
        })),
      },
    };
    const result = zSessionNotification.safeParse(inventedShapeNotification);
    expect(result.success).toBe(false);
  });

  it('mapConfigOptions maps the SDK-schema-validated recorded catalog to the same internal shape its own dedicated test suite already asserts, proving the mapping this file validates the input of is the same one the client actually runs', async () => {
    const { zSessionConfigOption } = await loadAcpSdkZodSchemas();
    for (const option of recorded.sessionNewResult.configOptions) {
      expect(zSessionConfigOption.safeParse(option).success).toBe(true);
    }

    const options = mapConfigOptions(recorded.sessionNewResult);
    expect(options.map((o) => o.category).sort()).toEqual(['mode', 'model', 'thought_level']);
    expect(options.find((o) => o.category === 'thought_level')?.current).toBe('high');
  });

  it("issue #897's two 'currently unobserved, but real' claims are genuinely SDK-schema-valid, not just plausible-sounding: a type: 'boolean' option and a grouped-options select both parse against the real zSessionConfigOption schema even though mapConfigOptions can't represent either one yet (see client.ts's RawConfigOption doc comment)", async () => {
    const { zSessionConfigOption } = await loadAcpSdkZodSchemas();

    const booleanOption = {
      id: 'auto_approve',
      name: 'Auto-approve tool calls',
      category: '_custom_auto_approve',
      type: 'boolean',
      currentValue: true,
    };
    expect(zSessionConfigOption.safeParse(booleanOption).success).toBe(true);
    // mapConfigOptions doesn't crash on it, but it can't carry a real
    // selection either: choices stays empty since there's no `options`
    // array on a boolean-type entry at all (issue #897).
    // The wire genuinely sends a boolean `currentValue` here (confirmed
    // above via the real SDK schema) — `RawConfigOption.currentValue` is
    // deliberately typed `string`-only (honest for the `'select'` variant
    // this client actually handles; see `client.ts`'s doc comment), so a
    // boolean-shaped payload needs the same escape hatch `client.test.ts`
    // already uses for an untyped recorded fixture.
    expect(
      mapConfigOptions({ configOptions: [booleanOption] } as unknown as Parameters<
        typeof mapConfigOptions
      >[0])[0]?.choices,
    ).toEqual([]);

    const groupedSelectOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'anthropic/claude-opus-5',
      options: [
        {
          group: 'Fast',
          name: 'Fast',
          options: [{ value: 'anthropic/claude-haiku-4-5', name: 'Haiku' }],
        },
      ],
    };
    expect(zSessionConfigOption.safeParse(groupedSelectOption).success).toBe(true);
    // mapConfigOptions's flat-choice filter silently drops every entry of a
    // grouped response (issue #897) rather than crashing.
    expect(mapConfigOptions({ configOptions: [groupedSelectOption] })[0]?.choices).toEqual([]);
  });
});
