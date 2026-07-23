/**
 * Vitest stand-in for SvelteKit's `$env/dynamic/public` virtual module
 * (issue #381). `vitest.config.ts` deliberately loads the plain
 * `@sveltejs/vite-plugin-svelte` rather than `sveltekit()` (see that file's
 * doc comment on why), so none of SvelteKit's virtual `$env`/`$app` modules
 * actually exist under test — any component that imports one needs an
 * aliased stand-in like this or `svelte/server`'s `render()` fails to even
 * load the module graph.
 *
 * An always-empty `env` mirrors a real deployment with no
 * `PUBLIC_LOOMBOX_RELAY_URL` set: `+page.svelte`'s own `|| 'wss://...'`
 * fallback already covers that case, so tests exercising the page never
 * need this stub to return anything more than `{}`.
 */
export const env: Record<string, string | undefined> = {};
