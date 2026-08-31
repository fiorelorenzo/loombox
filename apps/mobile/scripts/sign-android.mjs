#!/usr/bin/env node
// Wires android/app/build.gradle's release build type to a real signing
// identity, driven entirely by env vars -- there is no keystore checked into
// this repo and there never will be one (see "What Lorenzo has to obtain" in
// apps/mobile/README.md). Run this against a fresh `cap add android` output,
// after patch-android-project.mjs, and before `./gradlew bundleRelease`.
//
// Fails loudly and specifically (which var is missing) instead of letting an
// absent keystore surface as Gradle's own opaque "Keystore file … not found"
// deep inside a `bundleRelease` stack trace, or worse, silently producing an
// unsigned release artifact neither store will accept.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { missingSecrets } from './lib/secret-gates.mjs';

const missing = missingSecrets('android-signing');
if (missing.length > 0) {
  console.error(
    'sign-android: cannot sign a release build -- the following secret(s) are not set:',
  );
  for (const name of missing) console.error(`  - ${name}`);
  console.error(
    'See apps/mobile/README.md#what-lorenzo-has-to-obtain for what each one is and how to generate it.',
  );
  console.error(
    '(Unsigned debug builds need none of this -- see the "mobile" job in .github/workflows/ci.yml.)',
  );
  process.exit(1);
}

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildGradlePath = path.join(mobileDir, 'android/app/build.gradle');
const keystorePath = path.join(mobileDir, 'android/app/release.keystore');

if (!existsSync(buildGradlePath)) {
  console.error(
    `sign-android: ${buildGradlePath} does not exist -- run "pnpm cap:add:android" first.`,
  );
  process.exit(1);
}

writeFileSync(keystorePath, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64'));

let gradle = readFileSync(buildGradlePath, 'utf8');
if (gradle.includes('signingConfigs {')) {
  console.error(
    'sign-android: android/app/build.gradle already has a signingConfigs block -- refusing ' +
      'to add a second one (run this against a fresh "cap add android" output, not a reused tree).',
  );
  process.exit(1);
}
if (!/android\s*\{/.test(gradle)) {
  console.error(
    'sign-android: no "android {" block found in build.gradle -- ' +
      "Capacitor's generated template must have changed shape; update this script.",
  );
  process.exit(1);
}
const releaseBlockRe = /(buildTypes\s*\{\s*release\s*\{)/;
if (!releaseBlockRe.test(gradle)) {
  console.error(
    'sign-android: no "buildTypes { release {" block found in build.gradle -- ' +
      "Capacitor's generated template must have changed shape; update this script.",
  );
  process.exit(1);
}

// storeFile/keyAlias land in the file (not secret); the two passwords are
// read from the environment *by Gradle itself*, at build time, so a
// released or archived build.gradle never carries a plaintext secret even
// transiently.
const signingConfigBlock = `
    signingConfigs {
        release {
            storeFile file('release.keystore')
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('ANDROID_KEY_ALIAS')
            keyPassword System.getenv('ANDROID_KEY_PASSWORD')
        }
    }
`;
gradle = gradle
  .replace(/android\s*\{/, (m) => `${m}\n${signingConfigBlock}`)
  .replace(releaseBlockRe, '$1\n            signingConfig signingConfigs.release\n');

writeFileSync(buildGradlePath, gradle);
console.log(
  `sign-android: wired android/app/build.gradle to ${keystorePath} ` +
    '(stays untracked -- android/ is fully gitignored).',
);
