# Naughty Family Portal

A React + Vite multi-workspace portal for Naughty Souls faction members in Torn. The portal brings the existing Company Dashboard together with Halloween event intelligence, a faction workspace, shared account settings, and role-protected administration.

## Workspaces

- `/` — member portal
- `/company` — existing company operations dashboard
- `/halloween` — current-year and historical Halloween intelligence
- `/faction` — weekly rankings and history, faction totals, live member status, recent faction activity, director directory, company income history, and weekly star distribution
- `/settings` — personal API connections and account settings
- `/admin` — administrator workspace

All workspaces use the same authenticated member session and one member-owned Torn API key. Sign-in verifies the key's Torn identity and Naughty Souls membership; the saved encrypted credential is reused for company data, private live status and optional Halloween log collection wherever its selections and the member's permissions allow.

## Faction performance roadmap

The full product specification, verified API contract, data model, implementation phases and acceptance tests are maintained in [docs/FACTION-PERFORMANCE-DASHBOARD-PLAN.md](docs/FACTION-PERFORMANCE-DASHBOARD-PLAN.md). The branch implements scheduled public roster/stat/gym-energy collection, Sunday UTC rankings, immutable completed-week reports and comparisons, faction-wide totals, public live member status, a bounded activity feed, and audited administrator-only Sunday-boundary recovery. Weekly rankings include sortable columns, status/participation/anomaly filters and current/archived member drilldowns with metric deltas and capture provenance. The portal uses one owner-verified primary sign-in key for identity and owner-only features, with optional encrypted secondary company keys scoped by the company profile returned by Torn. Staging real-key company refresh acceptance is confirmed for primary Full Access, primary Custom Access and secondary company keys; adding and removing secondary keys also passed. Private-live and Halloween feature permissions still require their own acceptance. Private-live refresh remains member-triggered and is protected by a shared 30-second per-member request throttle.

## Local development

- Install Node.js 20 or later.
- Run `npm ci`.
- Run `npm run dev` to start the frontend.
- Run `npm run typecheck` to check TypeScript.
- Run `npm test` to run backend regression tests.
- Run `npm run build` to create the production static site in `dist/`.

## Cloudflare Pages

The production cutover target is the `naughtyfamily` Pages project at `https://naughtyfamily.pages.dev`. It is configured for this repository and `main`, but automatic production/preview deployments are disabled and it has not yet received a production deployment.

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root
- Production build variable: `VITE_API_BASE_URL=https://naughty-company-api.kboone801.workers.dev`
- Production branch: `main`
- Automatic production deployments: disabled
- Preview deployments: disabled

The existing `naughty-company-dashboard.pages.dev` site is preserved as the legacy rollback target. Its current production deployment remains in place; automatic production and preview deployments are now disabled so a merge cannot replace that rollback copy. Acceptance uses the separate `naughtyfamily-staging.pages.dev` project and isolated `naughtyfamily-api-staging` Worker/D1. See [the production cutover review](docs/PRODUCTION-CUTOVER-REVIEW.md) before any production operation.

## Account security and Torn API

Members create one primary portal key on their own Torn account. The recommended Custom Access builder link is shown on sign-in; a Torn Full Access key is also accepted. The primary key's Torn owner ID is checked against the authenticated session. Company profile/employee/stock reads use that primary key by default, with optional encrypted secondary company keys scoped to the company ID returned by Torn. A secondary company key does not have to belong to the portal member's Torn player ID: it must successfully return a company profile, and the resulting company ID is saved under the authenticated portal account. Secondary keys do not replace the primary login credential or grant director permissions. Company-refresh acceptance on staging passed for primary Full Access, primary Custom Access and secondary keys. Private bars/cooldowns, optional detailed networth and Halloween summaries/logs continue to use the primary portal credential. The member separately opts into faction sharing of private bars/cooldowns and separately opts into detailed networth or historical Halloween log collection. The key is AES-GCM encrypted at rest and is never shared. Only the latest private live snapshot is retained; the owner may refresh it manually or disable its sharing, which deletes the current private snapshot. Replacing or deleting the portal key invalidates private-live/Halloween opt-in metadata and removes company-key records tied to that primary credential, while retaining company records and already-contributed Halloween archive history. Optional secondary company keys remain separate and can be removed individually in Account Settings. A shared 30-second server-side throttle applies to private-live connect and refresh attempts. The service-owned Worker secret `TORN_API_KEY_CUSTOM` is used for public global-company directory/ranking requests; `TORN_FACTION_API_KEY` remains dedicated to scheduled public faction collection. Neither service secret is a substitute for a member's own key. Halloween exchange estimates use the public Torn v2 `market -> itemmarket` selection with the service-owned Full Access API key, never a member's personal key. Its average price and Torn `cache_timestamp` are cached by item ID in D1 and displayed with the snapshot time. The estimate is gross reward value only; it does not subtract treats spent or transaction fees.

The faction-wide Halloween archive is shared with authenticated Naughty Souls members. Missing collection coverage must remain distinguishable from a true zero. Removing a saved credential must not silently erase event records already contributed to the shared archive. Each member records the Trick or Treat start time they selected in Torn: any 15-minute slot from 10:00 through 16:00 TCT (UTC). Their personal collection and live-snapshot window starts on October 25 at that time and ends on November 1 at the same TCT clock time. Members can correct the saved slot until collection or snapshot capture begins; afterward it is locked to protect the integrity of contributed data. Historical collection jobs retain the exact personal start/end timestamps they were created with.

Membership is rechecked during authenticated requests and by a bounded scheduled sweep for inactive accounts. Both paths atomically claim a per-member five-minute check window so overlapping requests and cron runs do not duplicate Torn calls. Verification state distinguishes an in-flight check, a genuine Torn outage, and a confirmed departure whose cleanup is pending. Only a genuine outage can use the short grace tied to the last successful verification (at most 15 minutes); a confirmed departure remains fail-closed until cleanup succeeds, even if Torn becomes unavailable during a retry. The same full departure cleanup is used whether a member is discovered by an authenticated request, the scheduled sweep, or either Halloween collector. Cleanup revokes administrator access first, then invalidates all sessions, removes the saved faction login key and Halloween contribution data, clears the stale faction-directory entry, and removes company-sharing relationships. Torn outages, rate limits, and key-validation failures are not treated as proof that someone has left.

Never submit another player's key, Torn password, session token, or other authentication material. API keys must only be used for data the member is authorized to access.

## Backend and deployment

The API Worker remains `naughty-company-api` at `https://naughty-company-api.kboone801.workers.dev`, using the `naughty-company-dashboard` D1 database. The portal branch contains ordered migrations through `migrations/auth/0024_halloween_custom_key_support.sql`. Migrations `0012`–`0018` cover administrator registry, membership verification and Halloween consent/collection; `0019` adds public faction-performance collection and membership history; `0020` adds idempotent Sunday-boundary runs; `0021` adds immutable completed-week reports; `0022` adds faction-wide stats snapshots; and `0023` adds private-live consent metadata, latest snapshots and request throttling; `0024` updates the Halloween historical-key schema to support Custom Access keys. The canonical member credential is stored in the existing encrypted `api_keys` record; feature registries are opt-in metadata and do not require members to submit additional keys. The isolated acceptance environment uses the `naughtyfamily-acceptance-staging` D1 database, `naughtyfamily-api-staging` Worker and `naughtyfamily-staging` Pages project. Staging integration [Run 20](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41565717801) passed the public faction-performance D1/Queue pipeline. Staging [Run 21](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41569343997) applied migration `0023`, verified the staging migration ledger and confirmed all three private-live tables exist, then reran the public faction-performance D1/Queue acceptance successfully. Staging [Run 22](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41570310084) exercised private-live connect/refresh/networth-opt-in/disconnect through the isolated staging Worker and sanitized Torn Service Binding with synthetic members; all checks and the full public faction D1/Queue regression passed. No production D1 migration, SQL export backup, production Worker deployment or Pages cutover has been performed. Production D1 is currently at migration `0011`; migrations `0012`–`0024` remain pending. The acceptance D1 ledger is through `0024`.

Production Worker deployment is manual-only on the PR branch and requires the confirmed `naughty-company-api` target plus an operator-supplied reference to an externally stored, verified D1 backup. The workflow does not create or validate the backup. The legacy Pages rollback site's automatic deployments are disabled, and the new `naughtyfamily` target remains paused. Do not run production migrations, deploy the Worker, or publish Pages until the backup, migration, admin/non-admin, rollback and cutover gates in [the production cutover review](docs/PRODUCTION-CUTOVER-REVIEW.md) are completed and explicitly approved.
