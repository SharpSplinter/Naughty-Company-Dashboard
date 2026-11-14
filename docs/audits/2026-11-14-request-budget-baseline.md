# Production request-budget baseline

**Measurement date:** 2026-11-14  
**Working PR:** #152, branch `portal-rebuild`  
**Repository head at measurement:** `5256d6669388f2c7cc2c4fae96485627cb4fd246`  
**Scope:** Read-only Cloudflare analytics and D1 metadata. No production Worker deployment, D1 write, migration, load test, or credential change was performed.

## 1. Measurement window and method

The analytics window was 2026-11-07 02:03:11 UTC through 2026-11-14 02:03:11 UTC. Worker usage was binned using `America/New_York`. D1 query analytics were read from Cloudflare's `events.d1Queries` dataset and filtered to the exact production and acceptance-staging database UUIDs.

Cloudflare references:
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [D1 metrics and analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [D1 billing metrics](https://developers.cloudflare.com/d1/observability/billing/)

## 2. Production Worker telemetry

The existing production Worker `naughty-company-api` produced 30,540 ABR-adjusted events in the `cloudflare-workers` dataset over the seven-day window. These are observability event counts, not a guaranteed exact count of every incoming HTTP request; do not present them as exact request volume.

Daily bins (New York local midnight; first and last bins are partial):
| Local bin date | ABR-adjusted Worker events |
|---|---:|
| Nov 6 (partial) | 570 |
| Nov 7 | 4,270 |
| Nov 8 | 4,060 |
| Nov 9 | 4,330 |
| Nov 10 | 4,430 |
| Nov 11 | 4,430 |
| Nov 12 | 4,360 |
| Nov 13 (partial) | 4,090 |
| **Total** | **30,540** |

The telemetry usage endpoint reports account-wide events across datasets and services. This report isolates the `cloudflare-workers` dataset and `naughty-company-api` service from its breakdown rows.

## 3. D1 query usage

| Database | Query count | Rows read | Rows written | Mean SQL duration |
|---|---:|---:|---:|---:|
| Production `naughty-company-dashboard` | 180,753 | 1,868,398 | 59,493 | 0.404 ms |
| Acceptance staging `naughtyfamily-acceptance-staging` | 39,657 | 477,344 | 5,342 | 0.489 ms |

The mean duration is Cloudflare's `queryDurationMs`, which measures SQL execution inside D1. It does not include Worker execution, network routing, queue wait, or the full browser/API round trip. It therefore cannot be used as end-to-end latency or as a direct capacity conclusion. Cloudflare also notes that queries that fail before reaching SQL execution may not appear in `d1Queries`.

Staging totals include the portal integration and acceptance activity in the selected window. They are not a like-for-like workload comparison with production.

## 4. Current database metadata and migration ledgers

Read-only D1 details:
| Resource | UUID | D1 API `num_tables` | File size | Migration records |
|---|---|---:|---:|---:|
| Production `naughty-company-dashboard` | `bbbe128a-c5cc-46ec-b8ef-93860183e795` | 40 | 8,130,560 bytes | 16 |
| Staging `naughtyfamily-acceptance-staging` | `02cca699-1232-495f-8a0a-de525058b92a` | 64 | 7,122,944 bytes | 30 |

A separate read-only `sqlite_master` count returned 41 production tables and 65 staging tables. The one-table difference in each case is the `d1_migrations` ledger table; the Cloudflare database-details `num_tables` value excludes that migration ledger. These measurements are therefore consistent, not schema drift.

The production ledger has 16 entries and ends with `0012_company_ranking_snapshots.sql`. The portal branch's pending production migration filenames remain `0012_administrator_registry.sql` and `0013` through `0025`; confirm by exact filename because the two `0012` filenames are distinct. Staging has 30 entries through `0025_halloween_attack_metrics.sql` and also includes `0012_company_ranking_snapshots.sql`.

These reads reaffirm the documented production baseline. Re-check immediately before any future release.

## 5. Sustained-load validation status

The prior isolated staging load run [#43536991130](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43536991130) completed 1,500 synthetic administrator GETs over 300 seconds at 5 requests/second but failed with 203 HTTP 401 responses (13.53%). Its p95 was 472.4 ms and maximum 1,427.9 ms. Investigation traced the failures to the synthetic administrator's five-minute faction-verification freshness expiring during the test; this was a fixture-lifetime defect, not evidence of a production capacity problem.

The new harness refreshes only the exact synthetic administrator's `faction_verified_at` and membership-check metadata in the verified isolated staging D1 immediately before the benchmark. It runs 285 seconds at 5 requests/second (1,425 planned requests), leaving a 15-second margin inside the five-minute freshness window. The authenticated API workload itself remains GET-only; the isolated test setup performs one explicit synthetic-fixture metadata update before the run. This does not weaken application authentication or change production behavior.

Latest isolated staging acceptance run: [#43544138781](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43544138781). It was in progress at the time this report was written. Do not treat the sustained-load test as passed until that run's load step and unconditional fixture cleanup both complete successfully.

## 6. Remaining request-budget conclusions

- The read-only baseline is now captured for the existing production Worker and production D1.
- The 20-request staging smoke recorded in the earlier [admin/accessibility/request-budget review](2026-11-13-admin-accessibility-request-budget-review.md) remains a small latency smoke, not a capacity test.
- The sustained-load test must pass on the current PR head before closing this gate.
- Do not load-test production. Do not infer production behavior for the un-deployed Naughty Family portal Worker from legacy `naughty-company-api` analytics.
- Keep private-live refresh member-triggered. Do not add scheduled private-live polling without a separate request-budget and freshness review.

## 7. Release safety

PR #152 remains OPEN/DRAFT. The portal-specific production migrations, Worker deployment and `naughtyfamily` Pages production deployment have not been performed. No production resource was changed in collecting this baseline. The separate external encrypted D1 export, checksum and fresh pre-migration Time Travel bookmark remain mandatory before a future production cutover, together with explicit release approval.
