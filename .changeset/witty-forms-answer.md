---
'@loombox/protocol': minor
'@loombox/providers-core': minor
'@loombox/providers-claude': patch
'@loombox/providers-codex': patch
'@loombox/providers-ohmypi': minor
'@loombox/supervisor': minor
'@loombox/node': minor
'@loombox/relay': patch
'@loombox/web': minor
---

Offer the agents a target can actually run, and fix what the forms ask. Nodes now probe each target's own PATH and announce which providers work there, so the agent picker is a real choice instead of a hardcoded one-option dropdown. Adds Codex and Oh My Pi as real providers alongside Claude Code. The new-session dialog leads with the starting prompt, no longer reshapes itself ten seconds after opening, and every form marks the one required field instead of labelling the four optional ones.
