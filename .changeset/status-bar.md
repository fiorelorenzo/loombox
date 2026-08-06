---
'@loombox/web': patch
---

Adds a permanent status bar (Zed-parity decision B1-1, issue #736), rendered on every page — inbox, settings, tracker, and the session view — not only while a session is open.

- Left zone: relay connection (every state gets a reading now, including healthy, unlike the retired conditional chip), aggregate target health, and a Behind badge (build identity mismatch) — both target segments open Settings > Nodes.
- Right zone: the selected session's own status (all eight `SessionStatusV1` values render distinctly; "No session selected" reads honestly rather than showing stale session state), a queued-session count, and the context/cost meter.
- The context/cost meter **moved out of** `ConfigBar` onto this bar (it is not duplicated) — `ConfigBar` no longer takes `usage`/`cumulativeCostUsd` props.
- The topbar's conditional connection chip and the account avatar's/Settings-menu's health dots are **removed** outright, not hidden — retired in favor of the bar's own connection/target-health segments.
