#!/usr/bin/env node
// Prints apps/mobile's current derived native version as JSON
// (`{"name":"1.2.3","code":1002003}`) -- the same values
// patch-android-project.mjs/patch-ios-project.mjs already wrote into the
// generated native projects, needed again as plain shell variables by
// release-mobile.yml's App Store Connect upload step (altool's
// `--bundle-version`/`--bundle-short-version-string` flags), so both stay
// derived from the one source (lib/native-version.mjs) instead of a second,
// driftable computation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveNativeVersion } from './lib/native-version.mjs';

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
console.log(JSON.stringify(deriveNativeVersion(pkg.version)));
