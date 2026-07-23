/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS bootstrap shim, `require()` is the point (see doc comment below). */
// Same reasoning as `../main/bootstrap.cjs`: Electron's `webPreferences.
// preload` needs a file Node's loader can read directly, so this shim
// registers tsx's require hook and then loads the real (TypeScript)
// preload script. See `../main/window.ts`'s default `preloadPath`.
require('tsx/cjs');
require('./index.ts');
