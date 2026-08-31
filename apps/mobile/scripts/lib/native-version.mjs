// Derives the native versionCode/build-number both stores require from
// apps/mobile/package.json's own semver, which Changesets already bumps:
// `.changeset/config.json`'s `ignore` array is empty (see CONTRIBUTING.md's
// "Releases" section, and issue #723/that section's own history of why it
// stays empty), so `@loombox/mobile` versions and tags exactly like every
// other package in this monorepo -- there is nothing extra to wire for
// issue #283's "Changesets covers apps/mobile" acceptance item, only this
// translation from semver string to the integer the stores need.
//
// Android's versionCode and iOS's CURRENT_PROJECT_VERSION both need a
// monotonically increasing *integer*, and both stores reject a re-upload
// whose integer doesn't strictly increase over the last one they accepted.
// Packing major/minor/patch into fixed-width decimal digits
// (major*1_000_000 + minor*1_000 + patch) preserves semver's own ordering
// exactly, as long as minor and patch each stay under 1000 -- headroom this
// repo is nowhere near (the most active package, @loombox/web, sits at
// minor 9 after months of shipping; `git tag -l '@loombox/web@*'` is the
// live count). Checking that bound explicitly, rather than trusting the
// arithmetic blindly, is the same lesson issue #924 drew from a real
// tag-collision bug in the desktop updater: verify a version scheme against
// this repo's actual tag/version history before shipping it.
export function deriveNativeVersion(semver) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(semver);
  if (!match) {
    throw new Error(`deriveNativeVersion: "${semver}" is not a semver string`);
  }
  const [, majorStr, minorStr, patchStr] = match;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);
  if (minor >= 1000 || patch >= 1000) {
    throw new Error(
      `deriveNativeVersion: "${semver}" has a minor or patch component >= 1000; the ` +
        'major*1_000_000 + minor*1_000 + patch packing would no longer preserve semver ' +
        'ordering. Widen the packing before releasing this version.',
    );
  }
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (code <= 0) {
    // apps/mobile/package.json sits at 0.0.0 until the first changeset that
    // touches it lands (Changesets' own convention for a not-yet-released
    // private package) -- both stores require a positive versionCode, so this
    // is a real, if early, way to fail: it means "cut the first real mobile
    // release before running this", not a bug in the arithmetic.
    throw new Error(
      `deriveNativeVersion: "${semver}" produced a non-positive versionCode (${code}); ` +
        'both stores require a positive integer. apps/mobile has not shipped a real ' +
        'version yet -- this only makes sense once a changeset has bumped it past 0.0.0.',
    );
  }
  return { name: `${major}.${minor}.${patch}`, code };
}
