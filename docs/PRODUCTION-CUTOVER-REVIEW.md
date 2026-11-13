# Production backup, migration, rollback and cutover review

**Original review date:** 2026-11-03  
**State refresh:** 2026-11-13 (read-only Cloudflare/GitHub verification)  
**Scope:** PR #152, branch `portal-rebuild`  
**Decision:** The separate Naughty Family portal production cutover remains paused. The existing Company Dashboard baseline has since received PR #155 in production; this refresh updates the cutover baseline and does not perform any production mutation.

**2026-11-13 baseline update:** PR #155 merged at `f0420232231fa9708cece921a4fd5921eaad8e71`. Its production Worker deployment succeeded, migration `0012_company_ranking_snapshots.sql` was applied, and the existing `naughty-company-dashboard` Pages site was manually deployed from Android. The owner confirmed Trends & Charts displays the correct data. This does **not** deploy the Naughty Family portal branch or authorize its remaining migrations.

## 1. Acceptance status

### Company API keys — accepted on staging

The operator confirmed successful company-data refresh on the isolated staging portal with:

- A primary Torn Full Access key.
- A primary Torn Custom Access key.
- Secondary company API keys.

Secondary company keys were also added and removed successfully. A secondary key is validated by the company profile returned by Torn, and the returned company ID scopes the credential under the authenticated portal account. It is not required to belong to the portal member's Torn player ID. It does not replace the primary sign-in key or grant director permissions.

This acceptance is specifically for company profile/employee/stock refresh. It does **not** establish permission acceptance for owner-only bars/cooldowns, detailed networth, or Halloween historical logs; those features have separate selections and consent requirements.

The stateful acceptance environment is:

- Pages: `https://naughtyfamily-staging.pages.dev`
- Worker: `https://naughtyfamily-api-staging.kboone801.workers.dev`
- D1: `naughtyfamily-acceptance-staging`

The acceptance D1 migration ledger was read and verified through `0024_halloween_custom_key_support.sql` (28 applied migration records, 60 tables). The branch also contains `0025_halloween_attack_metrics.sql`; that migration had not yet been applied to the acceptance D1 at this state refresh. The deployment also passed TypeScript, backend tests, production frontend build, staging D1 migration checks, Worker health/encryption/CORS checks, and Pages bundle verification. The successful staging deployment is [GitHub Actions run #41582829643](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41582829643). The latest quality-gate run is [#41582751329](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41582751329).

## 2. Verified production baseline

These values were read from Cloudflare and the live production D1 database during this review. Re-check them immediately before a release; do not assume they remain unchanged.

| Resource | Verified state |
|---|---|
| Production API Worker | `naughty-company-api` |
| Production D1 | `naughty-company-dashboard` |
| Production D1 UUID | `bbbe128a-c5cc-46ec-b8ef-93860183e795` |
| Production D1 schema | 41 tables; existing member/session/company/history data is present |
| Production migration ledger | 16 entries; latest is `0012_company_ranking_snapshots.sql` |
| PR migrations awaiting production | `0012_administrator_registry.sql` and `0013` through `0025` |
| Active Worker version | `af3b0630-c758-4910-9a41-d43c8c330960` (100% traffic; deployed 2026-11-13 20:00:55 UTC) |
| Legacy Pages site | `https://naughty-company-dashboard.pages.dev` |
| Legacy Pages canonical production deployment | `b0352cf1-db23-437e-87b4-a363d08b53b8` (2026-11-13; PR #155 frontend) |
| New Pages target | `https://naughtyfamily.pages.dev`; no production deployment yet |
| New Pages API base | `https://naughty-company-api.kboone801.workers.dev` |

The live production D1 ledger now contains 16 migration records and ends with `0012_company_ranking_snapshots.sql`; the live schema has 41 tables. The pending portal branch migrations are `0012_administrator_registry.sql` and `0013` through `0025`. The two `0012` filenames are distinct migration records; the read-only ledger confirmed only the company-ranking file is applied in production. Production is not a clean or empty database. Do not repoint acceptance resources at production.

A read-only Time Travel bookmark was available during the review. It is only a review-time observation, not the release rollback point. Capture a fresh bookmark immediately before the production migration.

## 3. Deployment safety controls

### Pages

The legacy `naughty-company-dashboard` Pages project's Git automatic deployments are currently disabled. The latest production deployment is `b0352cf1-db23-437e-87b4-a363d08b53b8`, published on 2026-11-13 after PR #155. Preserve this site as the current live Company Dashboard and fallback; do not publish the separate portal branch to this project.

The new `naughtyfamily` Pages target is configured for `main`, with automatic production and preview deployments disabled. It has no production deployment yet. The production `VITE_API_BASE_URL` is set to the current production API Worker.

The legacy Pages production publish for PR #155 has already completed. The separate `naughtyfamily` target still has no production deployment. For the eventual portal cutover, deploy deliberately to `naughtyfamily` only after its Worker/schema is ready. Do not re-enable legacy Git deployment during the release.

### Worker

The previous `.github/workflows/worker-deploy.yml` ran on pushes to `main`, applied pending production D1 migrations, then deployed the production Worker. That made a merge capable of changing production implicitly.

The PR branch now makes this workflow `workflow_dispatch` only. It requires:
- The workflow to be run from `main`.
- The explicit target `naughty-company-api`.
- An operator-supplied reference to a verified production backup stored outside this repository.

The workflow lists pending migrations, applies them, lists the ledger again, deploys the Worker, and checks production health plus encryption readiness. The backup-reference input is a manual gate only: the workflow does not create, download, inspect, or validate the backup. The operator must complete those checks independently before dispatching it. This safeguard takes effect when the PR's workflow change is merged to `main`.

## 4. Migration review

The acceptance D1 has successfully applied the portal branch migration chain through `0024` (28 migration records; 60 tables). Migration `0025_halloween_attack_metrics.sql` is present on the current branch and still needs its staging integration run. Production has already applied `0012_company_ranking_snapshots.sql`; the portal-specific migration files still pending in production are:

| Migration file | Purpose |
|---|---|
| `0012_administrator_registry.sql` | Durable administrator role registry |
| `0013`–`0018` | Membership verification/revalidation and Halloween collection/consent schema |
| `0019` | Public faction-performance collection runs, roster/stat/gym snapshots and membership intervals |
| `0020` | Idempotent Sunday-boundary run registry |
| `0021` | Immutable completed-week reports and member results |
| `0022` | Faction-wide stats collection/snapshots |
| `0023` | Private-live consent metadata, latest snapshots and request throttling |
| `0024` | Rebuilds the Halloween historical-key table to admit Full and Custom Access credentials while copying existing rows |
| `0025` | Detailed Halloween attack/Revitalize metrics collection |

The migration review found no intentional deletion of company history. Migrations `0019`–`0023` add the faction/private-live structures. Migration `0024` creates a replacement historical-key table, copies the old table's rows, drops the old table and renames the replacement. In the current production schema, the `halloween_historical_keys` table does not yet exist because its creating migration `0014` is still pending; consequently it will be created and then rebuilt empty during the ordered migration chain. Still verify the final table definition, row counts and database integrity after migration.

**Important limitation:** the stateful migration rehearsal was against a clean isolated acceptance database, not a clone of production data. Do not describe it as a production-data restore rehearsal.

### Required pre-migration checks

1. Freeze the release commit and confirm that the deployed Worker version, Pages canonical deployment and D1 migration ledger have not changed since this review.
2. Confirm that `wrangler.toml` still points to the production Worker and the production D1 UUID above; compare it against `wrangler.acceptance.toml` to ensure no staging ID can be used.
3. Run `npx wrangler d1 migrations list naughty-company-dashboard --remote --config wrangler.toml` and confirm that the portal-specific pending filenames are exactly `0012_administrator_registry.sql` and `0013`–`0025`; confirm `0012_company_ranking_snapshots.sql` is already applied.
4. Export and verify the full production D1 database as described below. Store the backup in restricted encrypted storage outside the repository, GitHub Actions artifacts, and public logs.
5. Capture and record a fresh D1 Time Travel bookmark immediately before migration.
6. Review the pending SQL files in order and confirm the live ledger matches the post-PR-155 baseline ending in `0012_company_ranking_snapshots.sql`. Pay particular attention to the two distinct files sharing the `0012` numeric prefix; compare exact filenames, not only numeric prefixes.
7. Confirm required production Worker secret names exist without printing or disclosing their values. In particular, verify the configured encryption secret and the service-owned Torn keys required by the production runtime. Do not run `wrangler secret put` as a substitute; secret changes can deploy the currently targeted Worker.
8. Obtain explicit release approval before dispatching the production workflow.

## 5. Production backup procedure

D1 Time Travel provides point-in-time recovery within the preceding 30 days. A separate SQL export provides a portable backup. Cloudflare notes that a D1 export can block queries while it runs, so schedule it during a quiet release window.

From a trusted, authenticated operator environment:

```sh
npx wrangler whoami
npx wrangler d1 migrations list naughty-company-dashboard --remote --config wrangler.toml
npx wrangler d1 export naughty-company-dashboard --remote --output "$BACKUP_PATH"
sha256sum "$BACKUP_PATH"
```

Requirements:
- `BACKUP_PATH` must resolve to encrypted, access-controlled storage outside the repository.
- Confirm that the export completed, is non-empty, and has a recorded SHA-256 checksum.
- Keep the export and its checksum in a restricted location accessible to the recovery operator. Do not upload the SQL export to a general CI artifact, commit it, or paste it into chat.
- Record the backup storage reference in the manual Worker workflow's `backup_reference` input.
- Capture a fresh Time Travel bookmark through Cloudflare's D1 Time Travel API immediately before migrations. Keep the bookmark alongside the backup reference.
- Do not use the review-time bookmark as the pre-release bookmark if any writes have occurred since it was captured.

Cloudflare Wrangler documents that `d1 migrations apply` captures a backup and that a failed migration is rolled back while earlier successful migrations remain applied. Treat this as an additional safety net, not as a replacement for the verified external export and Time Travel bookmark.

## 6. Migration and deployment order

After the preceding checks and explicit approval:

1. Merge PR #152 only after final code review and remaining feature-level acceptance.
2. Confirm the legacy Pages production deployment remains frozen and the new Pages target remains paused.
3. Complete the external D1 export and fresh Time Travel bookmark; verify the backup checksum and access.
4. On `main`, manually dispatch **Deploy Cloudflare Worker** with target `naughty-company-api` and the external backup reference. The workflow applies the pending D1 migrations, verifies the migration ledger, deploys the Worker, then checks `/health`, D1 health and key-encryption readiness.
5. Confirm the production ledger includes the portal migration files through `0025_halloween_attack_metrics.sql` after deployment. Run read-only `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and check the `halloween_historical_keys` and `halloween_attack_metrics_jobs` table definitions and expected row counts.
6. Verify the production Worker accepts CORS from `https://naughtyfamily.pages.dev`. The current branch's origin allowlist explicitly permits this exact hostname.
7. Run authenticated smoke tests with a standard member and an administrator: sign-in, session, company data refresh, member settings, public faction endpoints, consent-gated feature endpoints, and admin authorization. Confirm no private data is exposed to another member.
8. Build with `VITE_API_BASE_URL=https://naughty-company-api.kboone801.workers.dev` and manually publish `dist/` to Pages project `naughtyfamily`. Do not publish to the legacy `naughty-company-dashboard` project.
9. Verify the new Pages root, JavaScript bundle API URL, browser CORS, sign-in, company refresh, and critical workspace flows. Keep the previous Pages site frozen as the fallback.
10. Record the deployed Worker version, Pages deployment ID, D1 migration ledger, backup reference/checksum and smoke-test results in the release record.

## 7. Rollback plan and limitations

### Worker code rollback

The active production Worker version observed during the 2026-11-13 refresh was `af3b0630-c758-4910-9a41-d43c8c330960` (100% traffic). Re-read the active deployment immediately before portal cutover and record that exact pre-release version ID for any code rollback.

Cloudflare supports:

```sh
npx wrangler rollback <PREVIOUS_VERSION_ID> --name naughty-company-api
```

A Worker rollback changes code deployment, not D1 schema or data. Cloudflare also warns that bindings are not rolled back and older code may fail against changed data structures. Prefer a forward-fix migration when the schema has changed, and only roll code back after confirming compatibility with the migrated schema.

### Pages rollback

The legacy project remains at `https://naughty-company-dashboard.pages.dev`, with current PR #155 deployment `b0352cf1-db23-437e-87b4-a363d08b53b8` preserved. It is the immediate fallback destination if the new `naughtyfamily` cutover fails.

The new `naughtyfamily` project currently has no production deployment, so there is no prior deployment inside that project to roll back to before its first release. After the first successful production deployment, Cloudflare Pages can roll back to an earlier successful production deployment in that same project. For the first cutover, keep the legacy project and deployment available and document the user-facing fallback URL.

### D1 data rollback

Use the fresh pre-migration Time Travel bookmark for point-in-time restore only as a last resort, with explicit approval and after assessing all writes made since that bookmark. Restoring D1 rewinds the database itself; it is not an application-only rollback and can discard legitimate writes created after the restore point.

Prefer forward fixes for schema/application defects. If restoring is unavoidable:
- Stop writes and scheduled/queue activity through an approved maintenance action.
- Take a second backup of the current, post-failure database before restoring.
- Restore using the captured bookmark or timestamp, following Cloudflare's Time Travel procedure.
- Reconcile any valid post-bookmark writes from the post-failure export.
- Deploy code compatible with the restored schema.
- Verify ledger, integrity, foreign keys, authentication, company/history records and all critical routes before reopening traffic.

Do not run a restore or overwrite production D1 as part of a routine application rollback.

## 8. Remaining production gates

- [ ] Separate real-key acceptance for bars/cooldowns, detailed networth and Halloween historical logs with their required selections/consents.
- [ ] Admin/non-admin end-to-end acceptance on the target production-like deployment.
- [ ] Mobile, accessibility, load and request-budget review.
- [ ] Pre-cutover D1 export backup completed, checksum verified and securely retained.
- [ ] Fresh pre-cutover Time Travel bookmark captured and recorded.
- [ ] Production migration list and current schema rechecked.
- [ ] Production Worker secret names/readiness verified without revealing secret values.
- [ ] Explicit approval to merge/deploy and to publish the new Pages target.
- [ ] Post-deployment smoke tests completed and rollback operator available.

## 9. Current production changes versus the separate portal cutover

The existing Company Dashboard release is live; the Naughty Family portal branch is not.

Completed before this state refresh:
- PR #155 merged at `f0420232231fa9708cece921a4fd5921eaad8e71`.
- Production D1 migration `0012_company_ranking_snapshots.sql` applied successfully.
- Production Worker deployed as version `af3b0630-c758-4910-9a41-d43c8c330960`, 100% traffic.
- Existing Pages project manually deployed from Android; canonical deployment `b0352cf1-db23-437e-87b4-a363d08b53b8`; user confirmed Trends & Charts displays the correct data.
- Automatic production/preview Git deployments on the legacy Pages project remain disabled.

Not performed for the separate Naughty Family portal cutover:
- No verified external production D1 SQL export backup has been created for this cutover.
- No portal migrations `0012_administrator_registry.sql` or `0013`–`0025` have been applied to production.
- No portal-branch Worker has been deployed to production.
- No production deployment has been created for the `naughtyfamily` Pages target.
- No production rollback/restore has been performed.

The portal branch Worker deployment workflow remains manual-only and requires the explicit `naughty-company-api` target plus an operator-supplied backup reference. The backup reference is a manual gate, not proof that the backup was created or validated. This workflow safeguard becomes effective after merge. This section is a state clarification, not authorization to deploy.

## Cloudflare references

- [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 Wrangler commands and migrations](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare Pages branch deployment controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)
- [Cloudflare Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
