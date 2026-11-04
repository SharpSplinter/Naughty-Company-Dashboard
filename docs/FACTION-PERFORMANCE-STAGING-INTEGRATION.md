# Faction performance staging integration

This is the stateful acceptance test for faction collection, active-week rankings and immutable completed-week history. It exercises the actual Worker queue handler, Cloudflare D1 writes, scheduled finalizer queue path and authenticated read APIs against the non-production database, while all Torn API responses come from a deterministic fixture Worker.

## Resources used

| Resource | Name / ID |
| --- | --- |
| Staging D1 | `naughty-company-api-staging` |
| Staging D1 ID | `1e37f1a5-daa3-41fb-8c1b-7a9c6e3d0405` |
| Integration queue | `ncd-faction-performance-integration` |
| Integration DLQ | `ncd-faction-performance-integration-dlq` |
| Fixture Worker | `naughty-company-api-faction-performance-mock` |
| Integration Worker | `naughty-company-api-faction-performance-integration` |

The production D1 database ID `bbbe128a-c5cc-46ec-b8ef-93860183e795` is deliberately absent from both staging Wrangler configs. The staging configs have no cron triggers. The integration Worker has no production routes and never borrows a member's Torn key. The integration Worker talks to the fixture Worker through the private `TORN_API_FIXTURE` Service Binding, so its Torn-shaped API requests do not depend on public `workers.dev` DNS or outbound routing.

## Run procedure

The workflow is `.github/workflows/faction-performance-staging-integration.yml`. It has two explicit opt-ins:

- **Pre-merge run:** add or edit `.github/STAGING_INTEGRATION_RUN_NOW` on the `portal-rebuild` branch and push that commit. The workflow's push path filter watches only that marker file; ordinary PR updates do not deploy the staging Workers or run the D1 integration.
- **Manual run:** after the workflow is registered on the repository's default branch, use **Actions → Faction performance staging integration → Run workflow**, choose `portal-rebuild`, and confirm `naughty-company-api-staging`. GitHub requires `workflow_dispatch` workflow files to exist on the default branch.

Do not merge PR #152 just to register the manual workflow. The existing production `worker-deploy.yml` listens for changes to `src/worker/**`, `migrations/auth/**`, and `wrangler.toml` on `main`, then applies production D1 migrations and deploys the Worker.

The workflow performs these steps in order:

1. Runs `npm run typecheck`, `npm test`, and Node syntax checks for the integration scripts.
2. Verifies both Wrangler configs are pinned to the staging D1 and have no cron triggers.
3. Applies pending migrations from this branch to staging D1 and displays the migration ledger.
4. Creates only the two dedicated integration queues, if they do not already exist.
5. Deploys the sanitized Torn fixture Worker and the separate integration Worker.
6. Pushes test collection messages to the real Cloudflare Queue and checks persisted D1 results.

The migration-only workflow `.github/workflows/faction-performance-staging-migration.yml` is also available when migration verification is desired separately.

The repository secret `CLOUDFLARE_API_TOKEN` must be authorized for D1 writes, Worker script deployments, and Queues management (including queue creation and message publishing). The workflow does not need a Torn API secret.

## Assertions

The driver `scripts/run-faction-performance-staging-integration.mjs` verifies:

- Migrations 0019, 0020, 0021 and 0022 plus all collection, boundary, immutable report and faction-wide stats tables are present.
- Roster collection creates six synthetic membership intervals and marks a seeded departed interval as left without deleting it.
- Public personalstats collection processes six members over the five-member queue page boundary and persists all 18 counters.
- Gym-energy collection persists all six synthetic contributors.
- All three successful collection types advance `last_success_at`.
- The authenticated faction stats API returns the latest scheduled `/faction/stats` aggregate snapshot, actual capture timestamp, recognized totals, missing/unrecognized field metadata, and collection freshness state.
- The authenticated faction performance API returns the completed roster with joined stats and gym-energy samples, public last-action fields, and the target's configured revive setting separate from key-owner-specific revivability.
- The authenticated faction activity API compares the two latest completed roster snapshots and returns typed, bounded membership/status/activity/flag/revive-setting/position changes.
- The authenticated weekly-rankings API uses synthetic Sunday-boundary baseline runs and later samples to verify separate Xanax/LSD deltas, negative networth movement, starting/current networth values, gym-energy delta/ranking, actual capture timestamps and selected-metric rank ordering.
- The shared queue handler finalizes two synthetic closed weeks after their ending boundary runs reach terminal states; both report headers and member rows persist atomically.
- A member who leaves midweek remains in the earlier report using the last pre-departure sample and is absent from the following week's report.
- Immutable report triggers reject attempted member-result updates; the authenticated history API lists the completed reports and returns weekly value changes, prior rank and rank movement for comparisons.
- A permanent per-member Torn API error creates a failed sample with NULL metrics and does not advance `last_success_at`.
- A synthetic Torn 429 is retried by Cloudflare Queues, reaches the dedicated DLQ, and records a terminal failed run without advancing `last_success_at`.
- Faction-wide stats collection uses a separate 15-minute idempotent run key and the same retry/DLQ lifecycle; missing enum names remain explicit and are never replaced with zero.
- The authenticated admin weekly-boundary diagnostics endpoint reports recent Sunday registry/run state, retry age, frozen-cohort/capture counts, actual first/last capture times, timing deviation, and adjacent immutable-report references.
- The admin recovery endpoint retries a synthetic failed Sunday personalstats run using the existing frozen cohort and queue run ID, verifies it completes, confirms the action is written to the admin audit log, and rejects recovery with HTTP 409 when either adjacent immutable weekly report references the boundary.
- The integration creates a temporary administrator role for its temporary authenticated test player; deleting that test player removes the temporary role and session.

All API responses are generated from the sanitized schema fixture or synthetic data. The configured test key is a fake fixture key, not a Torn credential. No `TORN_API_KEY` or `TORN_FACTION_API_KEY` repository secret is required.

## Expected side effects

The workflow applies the pending migrations to staging D1, creates two dedicated queues, and deploys two staging-only Workers. Those Workers remain deployed after the workflow; they have no cron triggers. The integration creates synthetic test collection, boundary and immutable report rows and keeps them in staging D1 as run evidence. It selects an unused recent Sunday pair for each run so reruns do not overwrite historical reports. It creates and removes a temporary authenticated test player/session during the API check.

No production D1 migration, production Worker deployment, Pages deployment, or live Torn API collection is part of this test.
