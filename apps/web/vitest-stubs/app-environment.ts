/**
 * Vitest stand-in for SvelteKit's `$app/environment` virtual module (issue
 * #865). Same reason `vitest-stubs/env-dynamic-public.ts` exists (see its
 * own doc comment): `vitest.config.ts` deliberately loads the plain
 * `@sveltejs/vite-plugin-svelte` rather than `sveltekit()`, so none of
 * SvelteKit's virtual `$env`/`$app` modules actually exist under test — any
 * component that imports one needs an aliased stand-in like this or
 * `svelte/server`'s `render()` fails to even load the module graph.
 *
 * Only `version` is exported: it's the only member `SettingsPage.svelte`
 * (the one component under test that imports from this module) actually
 * reads — `+layout.svelte`'s own `browser` import is exercised only via the
 * Playwright e2e suite against a real `vite dev`/`vite preview` server,
 * never through this vitest config, so it needs no stand-in here.
 *
 * A plain non-empty string, not a real commit sha: `SettingsPage.test.ts`
 * asserts the "Build <token>" line renders *some* value, exactly what a
 * real deploy's `LOOMBOX_BUILD_COMMIT`-derived `kit.version.name` (see
 * `svelte.config.js`) would also produce — it never asserts this literal
 * value, so a test-only placeholder is honest here.
 */
export const version = 'vitest-stub-version';
