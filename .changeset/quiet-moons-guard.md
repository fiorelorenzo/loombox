---
'@loombox/node': patch
---

Stop tests writing into the developer's real node state directory. `defaultNodeStateDir()` now throws under Vitest, so a test that forgets to inject a `stateDir` fails at the first call instead of corrupting `~/.loombox/node`. Session persistence made that omission destructive: six test files had already left 35 phantom session records in mine, which a real node reloads on boot.
