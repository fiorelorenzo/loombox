---
'@loombox/relay': patch
---

`/health` now checks Postgres and Redis before answering

Previously `/health` was a plain liveness stub: `{"status":"ok"}` on every
request, regardless of whether the relay's Postgres or Redis was actually
reachable. It's now a real readiness probe (SPEC §7.21): a `SELECT 1`
against Postgres and a `PING` against Redis (only when `REDIS_URL` is
configured), each racing its own short timeout so a hung dependency 503s
instead of hanging the request. 200 means both configured dependencies are
reachable; a 503 body names which one failed, e.g.
`{"status":"unhealthy","failed":["postgres"]}`. Still unauthenticated and
exempt from the per-IP rate limit — an external uptime checker has no
session and polls on its own schedule.

See `docs/deploy-relay.md`'s new "Monitoring" section for pointing an
external uptime service at this endpoint.
