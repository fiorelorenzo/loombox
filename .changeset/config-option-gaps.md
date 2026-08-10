---
'@loombox/providers-core': minor
'@loombox/protocol': minor
'@loombox/web': minor
---

Carry the three `SessionConfigOption` fields loombox was dropping (issue #897)

#633's audit against the real pinned `@agentclientprotocol/sdk` found three fields
that are genuinely part of ACP's own schema and that the client silently ignored: a
per-option and per-choice `description`, the boolean variant's `currentValue`, and
grouped select options.

All three now survive from the wire to the UI. A description reaches the config
popover, a boolean option renders as a switch that knows its own state instead of
being dropped for having no `options` array, and a grouped response keeps its groups
rather than being discarded by the flat-choice filter. The schema conformance test
covers each against the real SDK schema, so an SDK change that reshapes them fails
here rather than in production.
