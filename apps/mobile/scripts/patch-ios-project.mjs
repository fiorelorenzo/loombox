#!/usr/bin/env node
// Sets ios/App/App.xcodeproj/project.pbxproj's MARKETING_VERSION /
// CURRENT_PROJECT_VERSION build settings from apps/mobile/package.json's own
// version (see lib/native-version.mjs), the same pair Info.plist's
// CFBundleShortVersionString/CFBundleVersion resolve from via
// `$(MARKETING_VERSION)`/`$(CURRENT_PROJECT_VERSION)` on every Xcode 11+
// project (Capacitor 8's iOS template included -- confirmed against Apple's
// own "Xcode Project Versioning" docs, since this box has no Xcode to
// generate a real ios/ tree and inspect directly; see README.md's "iOS: build -> sign -> submit").
// `ios/` is fully gitignored for the same reason android/ is -- see
// patch-android-project.mjs's doc comment -- so this runs after every
// `cap add ios`, same as that script.
//
// A plain global regex replace (not `agvtool`) on purpose: `agvtool`'s
// `apple-generic` versioning system is a per-target Xcode setting Capacitor's
// template does not obviously turn on, and this box cannot check either way
// (no Xcode). A direct MARKETING_VERSION=/CURRENT_PROJECT_VERSION= substitution
// needs no such setting and matches every build configuration in one pass.
//
// UNVERIFIED ON THIS BOX: written from Capacitor's documented default
// project layout and Apple's own versioning docs, never run against a real
// generated ios/ tree (this is a Linux devbox -- `cap add ios` needs Xcode).
// The release-mobile.yml ios job that calls this runs on GitHub's
// macos-latest, where it can actually be exercised for the first time.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveNativeVersion } from './lib/native-version.mjs';

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pbxprojPath = path.join(mobileDir, 'ios/App/App.xcodeproj/project.pbxproj');

if (!existsSync(pbxprojPath)) {
  console.error(
    `patch-ios-project: ${pbxprojPath} does not exist -- run "pnpm cap:add:ios" first (macOS + Xcode only).`,
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
const { name, code } = deriveNativeVersion(pkg.version);

let pbxproj = readFileSync(pbxprojPath, 'utf8');
const marketingRe = /MARKETING_VERSION = [^;]+;/g;
const buildRe = /CURRENT_PROJECT_VERSION = [^;]+;/g;
const marketingHits = pbxproj.match(marketingRe);
const buildHits = pbxproj.match(buildRe);
if (!marketingHits || !buildHits) {
  console.error(
    'patch-ios-project: no MARKETING_VERSION/CURRENT_PROJECT_VERSION build setting found -- ' +
      "Capacitor's generated Xcode project must have changed shape; update the regexes above.",
  );
  process.exit(1);
}
pbxproj = pbxproj
  .replace(marketingRe, `MARKETING_VERSION = ${name};`)
  .replace(buildRe, `CURRENT_PROJECT_VERSION = ${code};`);
writeFileSync(pbxprojPath, pbxproj);
console.log(
  `patch-ios-project: MARKETING_VERSION=${name} (${marketingHits.length} occurrence(s)), ` +
    `CURRENT_PROJECT_VERSION=${code} (${buildHits.length} occurrence(s))`,
);
