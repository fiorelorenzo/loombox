---
'@loombox/node': patch
---

The node's identity keypair is now anchored to its 0600 `identity.json`, with the
OS keyring demoted to a best-effort cache in front of it, and a volatile backend
(a Linux kernel keyring with no Secret Service session) is refused outright. An
empty keyring next to a populated file is treated as a cold cache and the file's
keypair is adopted, so a reboot no longer makes the node come back as a different
device (#815).
