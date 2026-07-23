/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS bootstrap shim, `require()` is the point (see doc comment below). */
// Plain CommonJS, deliberately NOT compiled from TypeScript. Every package
// in this monorepo ships as raw TS run through `tsx` rather than a compiled
// dist (`packages/node`'s own "start": "tsx src/main.ts",
// `packages/relay`'s Docker image running "tsx src/main.ts" as its literal
// production entry point — there is no repo-wide "compile everything to JS
// first" convention to fit into). This file's only job is to register tsx's
// CommonJS require hook (https://tsx.is, the documented `-r tsx/cjs`
// recipe) BEFORE requiring the real entry point, so `index.ts` — and every
// `@loombox/*` workspace package it imports, all shipped the same way — is
// transpiled on the fly. Electron's `package.json#main` must point at a
// file Node can load directly (not `.ts`), which is why this tiny shim
// exists at all.
require('tsx/cjs');
require('./index.ts');
