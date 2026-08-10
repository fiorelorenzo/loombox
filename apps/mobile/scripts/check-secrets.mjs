#!/usr/bin/env node
// One clear gate for every credential-driven step release-mobile.yml runs,
// so a missing secret fails with a plain "here is exactly what's absent"
// message before touching Gradle/xcodebuild/an upload API, instead of
// surfacing as a cryptic tool-specific error two steps later (a Gradle
// "Keystore file … not found", an xcodebuild "no signing certificate",
// altool's own opaque auth failure). Matches
// .github/workflows/release-desktop.yml's own honesty: this file is the
// mobile equivalent of that workflow's `CSC_IDENTITY_AUTO_DISCOVERY: false`
// comment, made loud instead of silent because unlike electron-builder,
// none of these tools degrade gracefully to an unsigned build on their own.
//
// Usage: node check-secrets.mjs <gate>
//   android-signing        see lib/secret-gates.mjs
//   play-submission
//   ios-signing
//   app-store-submission
//
// Exits 0 (silent success line) if every var in the named gate is set,
// exits 1 with the missing names listed if not. Never partially proceeds.
import { GATES, missingSecrets } from './lib/secret-gates.mjs';

const gate = process.argv[2];
if (!gate || !GATES[gate]) {
  console.error(
    `check-secrets: unknown gate "${gate ?? '(none)'}" -- expected one of: ${Object.keys(GATES).join(', ')}`,
  );
  process.exit(1);
}

const missing = missingSecrets(gate);
if (missing.length > 0) {
  console.error(
    `check-secrets: "${gate}" is not configured -- the following secret(s) are not set:`,
  );
  for (const name of missing) console.error(`  - ${name}`);
  console.error('See apps/mobile/README.md#what-lorenzo-has-to-obtain for what each one is.');
  process.exit(1);
}
console.log(
  `check-secrets: "${gate}" is fully configured (${GATES[gate].length} secret(s) present).`,
);
