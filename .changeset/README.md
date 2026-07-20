# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

Every change to a published package should ship with a changeset describing it.
Add one with:

```bash
pnpm changeset
```

Pick the affected packages and a semver bump (patch/minor/major), then write a
short human-readable summary. The changeset file lands here and is consumed by
`pnpm version-packages` (which updates versions + changelogs) and `pnpm release`
(which tags releases). All loombox packages are `private: true` and unpublished
to npm, so `pnpm release` never pushes anything to a registry; it exists so the
release workflow can create git tags and GitHub Releases off the version bump.

See [CONTRIBUTING.md](../CONTRIBUTING.md#releases) for the full release flow.
