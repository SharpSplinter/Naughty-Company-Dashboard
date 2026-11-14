# Production backup, migration, rollback and cutover review

**Original review date:** 2026-11-03  
**State refresh:** 2026-11-14 04:24 UTC (current Time Travel bookmark re-read, production D1/Worker/Pages baseline rechecked, PR-head quality gates reviewed)  
**Scope:** PR #152, branch `portal-rebuild`  
**Decision:** **NO-GO for production cutover at this review.** The production Time Travel current bookmark and live D1/Worker/Pages baseline have been rechecked, and the release workflow/configuration safeguards are present. PR #152 remains OPEN/DRAFT with no submitted GitHub review approvals. The latest Halloween/Revitalize changes have not had a functional staging acceptance run on the current release candidate, production service-key fallback acceptance remains to be confirmed, and explicit approval to merge/deploy has not been given. This review performs no production mutation.

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

The portal staging D1 migration ledger was read after the final PR #152 staging integration: 30 migration records through `0025_halloween_attack_metrics.sql`, with 64 tables. Full quality gates passed on [run #43508964744](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43508964744), and the complete isolated D1/Queue integration passed on [run #43508964870](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43508964870). That integration verified private-live consent/owner checks, faction stats missing/unexpected-field metadata, roster/personalstats/gym-energy collection, immutable weekly report creation and comparison, authenticated APIs, admin recovery safeguards, transient-error retries and DLQ behavior. These runs contacted only portal staging D1 and sanitized fixture Workers; no production D1 or Worker was contacted.

## 2. Production administrator-access blocker (owner-reported, 2026-11-14)

The project owner reports being unable to reach the production administrator controls because production still uses the legacy separate administrator username/password step-up. This is consistent with the current `main` implementation: the Worker expects the `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` configuration and the production UI presents a separate administrator credential form after the member session is established. This is distinct from the PR #152 portal implementation, which has not been deployed.

The intended PR #152 authorization flow is:

1. The member signs in with a Torn API key belonging to their own account. The Worker validates that key with Torn, confirms the player's identity and Naughty Souls faction membership, and creates a session tied to that verified Torn player ID.
2. Administrator privilege is a separate role attached to that verified player ID in the D1 `administrators` registry. The Worker joins the active role to the authenticated session and checks it on every `/api/admin/*` request.
3. The portal administrator registry UI grants/revokes by Torn player ID. The owner bootstrap is limited to the configured `ADMIN_PLAYER_ID` and uses insert-if-absent semantics; it does not override a previously revoked row.
4. A Torn ID by itself is not an authentication secret. The Torn API key proves account control; the verified player ID is the stable identity to which the administrator role is attached.

**Operational consequence:** The new Torn-identity/administrator-registry flow cannot provide production admin access until the portal D1 migrations (including `0012_administrator_registry.sql`), the portal Worker, and the `naughtyfamily` Pages frontend are deployed together. Until then, production continues to use the legacy administrator credential step-up, which the owner reports is currently unusable. Staging acceptance of the new role flow is not proof that production has switched over.

Do not attempt to work around production authorization, alter production administrator records, or change production secrets as an interim fix. A full production D1 export backup and isolated data restore rehearsal have completed successfully; the exact backup/checksum and rehearsal results are recorded in Section 6. The current Time Travel bookmark was re-read at 2026-11-14 04:23:12.859 UTC and recorded below. Re-read the current bookmark again immediately before migration if any writes, maintenance-driven bookmark advance, or meaningful delay occurs. The cutover remains paused pending final feature-level staging acceptance, confirmation of the production service-key fallback, explicit release approval, and the operator-ready migration/deployment window. Production remains unchanged.

## 3. Verified production baseline

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

Cloudflare D1 Time Travel bookmarks are generated automatically; there is no manual bookmark-creation action. A fresh read-only `GET` of the current bookmark was completed at **2026-11-14T04:23:12.859Z** for production D1 `naughty-company-dashboard`. It returned `000004ca-0000033a-00005123-06be4f012000b1afd17db773eeaf4ef8`, unchanged from the export-time bookmark recorded in Section 6. This is a freshly revalidated current-bookmark reference, **not a newly minted snapshot**. Cloudflare documents that bookmarks advance automatically and can also move due to internal maintenance without application SQL writes. Re-read the current bookmark immediately before the actual migration if the cutover is delayed or any writes/maintenance events occur.

## 4. Deployment safety controls

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

## 5. Migration review

The portal staging D1 has successfully applied the portal branch migration chain through `0025_halloween_attack_metrics.sql` (30 migration records; 64 tables), with end-to-end staging integration confirmed on run #43508964870. Production has already applied `0012_company_ranking_snapshots.sql`; the portal-specific migration files still pending in production are:

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

**Important distinction:** the portal migration/feature integration rehearsal remains against a clean isolated acceptance database, not a clone of production data. Separately, the full production D1 backup was restored into a temporary isolated D1 database on 2026-11-14; see Section 6 for that production-data restore rehearsal and its validation limits.

### Required pre-migration checks

1. Freeze the release commit and confirm that the deployed Worker version, Pages canonical deployment and D1 migration ledger have not changed since this review.
2. Confirm that `wrangler.toml` still points to the production Worker and the production D1 UUID above; compare it against `wrangler.acceptance.toml` to ensure no staging ID can be used.
3. Run `npx wrangler d1 migrations list naughty-company-dashboard --remote --config wrangler.toml` and confirm that the portal-specific pending filenames are exactly `0012_administrator_registry.sql` and `0013`–`0025`; confirm `0012_company_ranking_snapshots.sql` is already applied.
4. Export and verify the full production D1 database as described below. Store the backup in restricted encrypted storage outside the repository, GitHub Actions artifacts, and public logs.
5. Read and record the current D1 Time Travel bookmark through the read-only API immediately before migration. Cloudflare creates bookmarks automatically; there is no manual-create operation. Re-read it again if writes, internal bookmark advancement, or a meaningful delay occurs.
6. Review the pending SQL files in order and confirm the live ledger matches the post-PR-155 baseline ending in `0012_company_ranking_snapshots.sql`. Pay particular attention to the two distinct files sharing the `0012` numeric prefix; compare exact filenames, not only numeric prefixes.
7. Confirm required production Worker secret names exist without printing or disclosing their values. In particular, verify the configured encryption secret and the service-owned Torn keys required by the production runtime. Do not run `wrangler secret put` as a substitute; secret changes can deploy the currently targeted Worker.
8. Obtain explicit release approval before dispatching the production workflow.

## 6. Production backup procedure

D1 Time Travel provides point-in-time recovery within the preceding 30 days. A separate SQL export provides a portable backup. Cloudflare notes that a D1 export can block queries while it runs, so schedule it during a quiet release window.

### Completed production export and isolated restore rehearsal (2026-11-14)

A full D1-compatible SQL export was completed from production database `naughty-company-dashboard` (`bbbe128a-c5cc-46ec-b8ef-93860183e795`). The export captured Time Travel bookmark `000004ca-0000033a-00005123-06be4f012000b1afd17db773eeaf4ef8` at 2026-11-14 03:38:56 UTC. The untouched SQL export is 7,706,099 bytes with SHA-256 `8ac318ed69c22eea82d8bc5cff55fe010236a3dc9c979ed718fae3ee0282eb7e`.

**Current bookmark recheck (2026-11-14 04:23:12.859 UTC):** a read-only `GET /time_travel/bookmark` with no timestamp parameter returned the same bookmark token as the export-time record above. This validates that token as the current bookmark at the time of this review; it does not create a new manual snapshot. Cloudflare states Time Travel is always enabled, bookmarks are automatically generated, and bookmark values may advance due to internal maintenance events. See [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

The first direct import attempt exposed a 4.3 MB `global_rankings_cache` statement exceeding D1's per-statement limit. The export also interleaves data for a child table before a later referenced table definition. A lossless import-normalized derivative was prepared: it breaks the 4,295,173-character JSON value into bounded hex-literal append operations, creates all 40 application tables before row data, inserts parent tables before dependants using the exported foreign-key graph, restores `sqlite_sequence` state after data, and creates all 22 explicit indexes last. The JSON value and its `fetched_at` timestamp were reconstructed and compared exactly.

The normalized SQL is 12,029,770 bytes, SHA-256 `1188579647f91ad310ec9069eaedd2e896c591a2f7e3ac5365474fb790a34ab2`. It passed a complete local SQLite transaction replay in 0.48 seconds: `PRAGMA integrity_check` returned `ok`, `PRAGMA foreign_key_check` returned zero violations, 40 application tables and 934 rows were present, and the 16-entry migration ledger ended with `0012_company_ranking_snapshots.sql`.

The same normalized SQL then imported successfully into temporary isolated D1 database `naughty-company-dashboard-restore-rehearsal-v3-20261113` in ENAM: 1,270 statements completed, with 40 application tables, 22 explicit indexes, 934 application rows, and 16 migration entries. All 40 per-table row counts matched the local replay. The 4,295,173-character global rankings JSON was valid and contained 15,344 array entries. Cloudflare D1's table-valued `pragma_foreign_key_check` returned zero violations. Cloudflare's D1 REST query API rejected a direct `PRAGMA integrity_check` request with `SQLITE_AUTH`; therefore the local integrity result is explicitly not represented as a direct D1 integrity-check result.

All three temporary restore-rehearsal D1 databases (two failed attempts and the successful verified copy) were deleted after the checks. No rehearsal database remains. No production D1 writes, migrations, restores, Worker deployments, Pages deployments, or secret changes were performed.

The refreshed encrypted archive is stored outside the repository and includes both the untouched original export and the normalized restore SQL, sanitized production metadata, checksums and this rehearsal report. Archive SHA-256: `052e5bcf352d17ae988eae15ff051e76c5380259c19dc0c694de5611c2c7fb4b`. The download reference and separately issued archive password are retained in the owner conversation; neither is committed here.

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

## 7. Migration and deployment order

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

## 8. Rollback plan and limitations

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

## 9. Remaining production gates

- [x] Operator-confirmed real-key permission/consent acceptance for private bars/cooldowns, optional detailed networth, and Halloween historical summaries/logs, as recorded in the PR's validation history. This does not replace the staging functional acceptance still required for the latest Halloween dashboard changes.
- [x] Admin/non-admin end-to-end acceptance on the isolated staging Worker/D1/Pages environment, including the synthetic administrator and denied non-admin paths. Production authorization has not been switched.
- [x] Physical Android TalkBack/layout review, automated accessibility checks, sustained staging load and read-only production request-budget review. Device/version details and granular per-control/table outcomes remain documented limitations.
- [x] Full production D1 export completed, SQL checksum verified, and AES-256 archive uploaded outside the repository; owner should retain a downloaded copy separately.
- [x] Isolated production-data restore rehearsal completed; 40 application tables, 22 explicit indexes and 934 rows matched, with zero D1 foreign-key violations. Direct D1 PRAGMA integrity_check remains unavailable through the REST API; exact normalized SQL passed local SQLite integrity_check.
- [x] Current production Time Travel bookmark re-read and recorded at 2026-11-14 04:23:12.859 UTC. The value is unchanged from the export-time bookmark; Cloudflare automatically generates bookmarks and does not offer manual snapshot creation. Re-read immediately before migration if anything changes or time passes.
- [x] Production migration ledger and schema rechecked read-only at 2026-11-14 04:24 UTC: 16 migrations, 41 tables; last applied migration remains `0012_company_ranking_snapshots.sql`. Portal-specific `0012_administrator_registry.sql` and `0013`–`0025` remain pending.
- [x] Production Worker secret binding names inspected without reading values. `KEY_ENCRYPTION_SECRET`, `TORN_API_KEY_CUSTOM`, and `TORN_FACTION_API_KEY` are present. The optional dedicated `TORN_API_KEY_FULL_ACCESS` binding is not configured; the portal code falls back to the Custom Access service key for the public global-ranking path. That fallback must be functionally accepted on staging before release.
- [ ] Functional acceptance on the current release candidate in isolated staging: Live/current-year and Historical/all-time/year-specific scopes, member comparisons, partial-coverage behavior, Revitalize proc percentage and exact numerator/denominator, plus critical admin/member flows. The latest quality gates are not a substitute for this runtime acceptance.
- [ ] Explicit owner approval to merge PR #152, dispatch the production Worker migration/deployment workflow, and publish the new `naughtyfamily` Pages target.
- [ ] Post-deployment smoke tests completed and rollback operator available.

## 10. Current production changes versus the separate portal cutover

The existing Company Dashboard release is live; the Naughty Family portal branch is not.

Completed before this state refresh:
- PR #155 merged at `f0420232231fa9708cece921a4fd5921eaad8e71`.
- Production D1 migration `0012_company_ranking_snapshots.sql` applied successfully.
- Production Worker deployed as version `af3b0630-c758-4910-9a41-d43c8c330960`, 100% traffic.
- Existing Pages project manually deployed from Android; canonical deployment `b0352cf1-db23-437e-87b4-a363d08b53b8`; user confirmed Trends & Charts displays the correct data.
- Automatic production/preview Git deployments on the legacy Pages project remain disabled.

Not performed for the separate Naughty Family portal cutover:
- Full production D1 SQL export backup has been created, checksummed, and packaged in an AES-256 archive outside the repository. An import-normalized derivative passed an isolated D1 data restore rehearsal; the original export remains unchanged in the archive.
- No portal migrations `0012_administrator_registry.sql` or `0013`–`0025` have been applied to production.
- No portal-branch Worker has been deployed to production.
- No production deployment has been created for the `naughtyfamily` Pages target.
- No production rollback/restore has been performed.

The portal branch Worker deployment workflow remains manual-only and requires the explicit `naughty-company-api` target plus an operator-supplied backup reference. That manual reference input is still not an automated check of backup contents; the owner must supply the verified archive reference at release time. The backup now exists and has passed the isolated restore rehearsal documented above. This workflow safeguard becomes effective after merge. This section is a state clarification, not authorization to deploy.

## 11. Final release review (2026-11-14 04:24 UTC)

### Read-only production evidence

- Production D1 identity was verified as `naughty-company-dashboard` / `bbbe128a-c5cc-46ec-b8ef-93860183e795`. A read-only schema query returned 41 tables (including Cloudflare's internal `_cf_KV` table) and a read-only `d1_migrations` query returned 16 records, ending with `0012_company_ranking_snapshots.sql`. No portal migration has been applied.
- The current production Worker deployment is `naughty-company-api`, version `af3b0630-c758-4910-9a41-d43c8c330960`, serving 100% traffic from deployment `c1705050-3a5b-424d-bd1d-50a71c185fcc` (created 2026-11-13 20:00:55 UTC).
- Legacy Pages project `naughty-company-dashboard` remains on successful production deployment `b0352cf1-db23-437e-87b4-a363d08b53b8` (2026-11-13 20:23:19 UTC). Its Git automatic production/preview deployments are disabled.
- Separate Pages project `naughtyfamily` has no production deployment. Its automatic production/preview Git deployments are disabled. It remains the intended target for the future portal deployment; the legacy Pages project remains the fallback.
- Production Worker secret binding names were read without accessing values. `KEY_ENCRYPTION_SECRET`, `TORN_API_KEY_CUSTOM`, and `TORN_FACTION_API_KEY` are present. `TORN_API_KEY_FULL_ACCESS` is absent; the branch code has a Custom Access fallback. Do not change secrets as part of this review.
- The branch Worker deployment workflow was inspected. It is `workflow_dispatch` only, requires the `main` ref, explicit `naughty-company-api` target, and a non-empty external-backup reference. It independently verifies the production Worker/D1 names and IDs. The reference input is not cryptographic validation of backup contents; the operator remains responsible for checksum/access verification.

### PR and validation evidence

- PR #152 remains OPEN/DRAFT. No GitHub review approvals or inline review threads are recorded. The branch has no commits behind current `main` (merge base `097762ac6f1d8afc071b37c1518f235073834644`).
- Latest release-candidate code commit reviewed: `a9f4d8b8e10c7ed7eb5832c6bd9711f65d444361`.
- [Quality Gates #1021](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43556243253) passed TypeScript, production frontend build, staging harness syntax checks and backend regression tests. [Discord Bot Quality Gates #123](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43556243261) also passed.
- The prior full isolated D1/Queue staging integration and sustained-load acceptance remain valid for the code they tested, but they predate the latest Halloween event-year/member-comparison and Revitalize-rate changes. No functional staging deployment/acceptance was performed on this exact release candidate; CI does not prove runtime behavior against staging D1/Queue/Pages.
- The current bookmark was read again at 04:23:12.859 UTC and matched the export-time bookmark. Cloudflare documents that bookmarks are generated automatically; this was a fresh read of the current token, not a separately minted backup snapshot.

### Release decision

**NO-GO for production cutover.** The production baseline, external SQL backup/restore rehearsal, current Time Travel bookmark, target isolation and manual deployment safeguards have been reviewed. Before any merge/deployment, complete functional staging acceptance on this exact release candidate, resolve/accept the Custom Access fallback for the public global-ranking service-key path, and obtain explicit owner approval. After approval, take another current bookmark immediately before migration, verify the external backup is accessible/checksummed, recheck pending migration filenames, then follow Sections 7–8. This review did not merge the PR, change its draft status, deploy Worker/Pages, run SQL writes, apply migrations, modify secrets, or restore production D1.

## Cloudflare references

- [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 Wrangler commands and migrations](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Cloudflare Pages branch deployment controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)
- [Cloudflare Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
