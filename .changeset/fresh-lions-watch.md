---
'@loombox/relay': patch
---

Pin the target-health fields through the relay's parse-and-forward. Zod strips keys its schema does not know, so a relay build older than the node's silently drops `loadPercent`, `hostname`, `platform` and `arch`, and the client shows an em dash for load and no machine identity at all. A stale production container did exactly that, with nothing anywhere reporting it.
