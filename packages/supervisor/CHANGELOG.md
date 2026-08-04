# @loombox/supervisor

## 0.1.1

### Patch Changes

- Updated dependencies [d09e12b]
- Updated dependencies [fc2c12e]
  - @loombox/providers-core@0.2.0
  - @loombox/providers-claude@0.0.2
  - @loombox/providers-codex@0.0.2
  - @loombox/providers-ohmypi@0.1.1

## 0.1.0

### Minor Changes

- 4f7dcd4: Actually wire the per-target provider probe. `main.ts` never passed `providerCandidates`, which defaults to an empty list and makes the probe a documented no-op, so every production target announced `providers: []` and clients correctly refused to create sessions on it. The candidate list now comes from `AgentSupervisor`'s own default provider set (`DEFAULT_PROVIDER_REQUIREMENTS`), so the advertised set and the spawnable set cannot drift.
- fcb76fc: Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.

### Patch Changes

- Updated dependencies [55161ed]
- Updated dependencies [fcb76fc]
  - @loombox/providers-core@0.1.0
  - @loombox/providers-claude@0.0.1
  - @loombox/providers-codex@0.0.1
  - @loombox/providers-ohmypi@0.1.0
