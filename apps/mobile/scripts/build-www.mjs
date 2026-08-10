// Bundles `src/www-bootstrap.ts` (which pulls in `diagnostics.ts`) into
// `www/diagnostics.js` — a single self-contained ESM file the static
// `www/index.html` loads. This IS `apps/mobile`'s `build` — there is no
// SvelteKit build here yet (see the spike doc for why: apps/web's
// `adapter-node` output has no static `index.html` for Capacitor's
// `webDir` to bundle, only `adapter-static` does, and switching apps/web's
// production adapter is a real decision, not a spike-scope change). This
// diagnostic page is deliberately the whole webDir for now, standing in for
// the real PWA build until that decision lands.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/www-bootstrap.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'www/diagnostics.js',
  sourcemap: true,
});
