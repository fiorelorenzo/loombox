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
(which publishes). v0 packages are not released yet, so this is wiring only.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution flow.
