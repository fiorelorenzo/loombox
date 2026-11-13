#!/usr/bin/env node
// Issue #950: reapplies OS-level backup exclusion for the platform's WebView
// storage directory (which holds the AMK, see packages/web-core's
// amk-store.ts) after every native-project regeneration.
//
// android/ and ios/ stay gitignored generated output (see the root
// .gitignore's apps/mobile block) — `cap add`/`cap update`/`cap sync`
// rewrite AndroidManifest.xml and AppDelegate.swift from Capacitor's own
// template, which would silently drop a one-off hand edit. Wiring this as a
// Capacitor CLI hook (https://capacitorjs.com/docs/cli/hooks) instead means
// the exclusion survives every regeneration without the native trees having
// to come out of .gitignore and become committed source.
//
// `capacitor:update:after` fires once per platform, with
// $CAPACITOR_PLATFORM_NAME set, from three call sites in @capacitor/cli:
// `cap add` (which calls update() internally after copying the template),
// `cap update`, and `cap sync` (which also calls update() first) — so this
// one hook covers every path that can (re)create these files from scratch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidBackupRulesApi31Xml,
  androidBackupRulesXml,
  patchAndroidManifest,
  patchAppDelegate,
} from './backup-exclusion.mjs';

const mobileRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function patchAndroid() {
  const manifestPath = join(mobileRoot, 'android/app/src/main/AndroidManifest.xml');
  if (!existsSync(manifestPath)) {
    return;
  }
  writeFileSync(manifestPath, patchAndroidManifest(readFileSync(manifestPath, 'utf8')));

  const xmlDir = join(mobileRoot, 'android/app/src/main/res/xml');
  mkdirSync(xmlDir, { recursive: true });
  writeFileSync(join(xmlDir, 'backup_rules.xml'), androidBackupRulesXml());
  writeFileSync(join(xmlDir, 'backup_rules_api31.xml'), androidBackupRulesApi31Xml());
}

function patchIos() {
  const appDelegatePath = join(mobileRoot, 'ios/App/App/AppDelegate.swift');
  if (!existsSync(appDelegatePath)) {
    return;
  }
  writeFileSync(appDelegatePath, patchAppDelegate(readFileSync(appDelegatePath, 'utf8')));
}

const platform = process.env.CAPACITOR_PLATFORM_NAME;
if (platform === 'android') {
  patchAndroid();
} else if (platform === 'ios') {
  patchIos();
} else {
  // Unexpected/absent platform name: patch whichever generated tree exists
  // rather than silently doing nothing.
  patchAndroid();
  patchIos();
}
