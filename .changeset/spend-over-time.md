---
'@loombox/protocol': minor
'@loombox/relay': minor
'@loombox/node': minor
'@loombox/shared': minor
'@loombox/web': minor
---

Aggregate spend-over-time view, per project and per provider (SPEC §7.9; issue #249)

`@loombox/node` persists a per-day/project/provider spend ledger (`SpendLedgerStore`), fed by the exact same `usage_update.costUsd` increase that already drives §7.16's spend-cap enforcement — one source, never two divergent cost computations. `@loombox/protocol` adds `spend_report_request`/`spend_report_response` (node-addressed by `nodeId`+`projectPath`, mirroring `tracker_snapshot_request`; the request itself carries no envelope since a date range is a query parameter, not project content), routed through `@loombox/relay`'s exhaustive message-routing table.

The per-project/per-provider grouping logic (`aggregateSpendLedgerRows`/`filterSpendLedgerRows`) now lives in `@loombox/shared` rather than `@loombox/node`, so `@loombox/web`'s new `SpendReportPanel` (mounted in the Config workbench tab) reuses the identical function the node runs server-side, rather than recomputing the rollup a second time in the browser. The panel offers a 7d/30d/90d/all-time period selector and shows a total plus per-provider breakdown; a period with nothing recorded reads as an honest "No spend recorded for this period." message, never a fabricated $0.00, matching the live session cost meter's own established convention.
