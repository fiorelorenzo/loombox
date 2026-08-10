#!/usr/bin/env node
// Sets android/app/build.gradle's versionCode/versionName from
// apps/mobile/package.json's own version (see lib/native-version.mjs) after
// `cap add android` regenerates the project. `android/` is fully gitignored
// (capacitor.config.ts's doc comment, and the spike doc's "nothing in
// either tree is hand-edited" -- see #281) -- every field Capacitor's
// template hardcodes, including the version pair below, has to be patched
// back in on every run rather than committed once.
//
// Idempotent: matches Capacitor 8.5's own generated defaults
// (`versionCode 1` / `versionName "1.0"`) exactly, verified against a real
// `cap add android` run in this PR (see apps/mobile/README.md's "Building locally").
// Run this against a real store release version only -- see
// lib/native-version.mjs's own doc comment for why apps/mobile's current
// 0.0.0 deliberately makes this script fail.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveNativeVersion } from './lib/native-version.mjs';

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildGradlePath = path.join(mobileDir, 'android/app/build.gradle');

if (!existsSync(buildGradlePath)) {
  console.error(
    `patch-android-project: ${buildGradlePath} does not exist -- run "pnpm cap:add:android" first.`,
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
const { name, code } = deriveNativeVersion(pkg.version);

let gradle = readFileSync(buildGradlePath, 'utf8');
const versionCodeRe = /versionCode\s+\d+/;
const versionNameRe = /versionName\s+"[^"]*"/;
if (!versionCodeRe.test(gradle) || !versionNameRe.test(gradle)) {
  console.error(
    'patch-android-project: no versionCode/versionName line found in build.gradle -- ' +
      "Capacitor's generated template must have changed shape; update the regexes above.",
  );
  process.exit(1);
}
gradle = gradle
  .replace(versionCodeRe, `versionCode ${code}`)
  .replace(versionNameRe, `versionName "${name}"`);
writeFileSync(buildGradlePath, gradle);
console.log(`patch-android-project: versionCode=${code} versionName=${name}`);
