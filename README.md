# Naughty Family Portal

A React + Vite multi-workspace portal for Naughty Souls faction members in Torn. The portal brings the existing Company Dashboard together with Halloween event intelligence, a faction workspace, shared account settings, and role-protected administration.

## Workspaces

- `/` — member portal
- `/company` — existing company operations dashboard
- `/halloween` — current-year and historical Halloween intelligence
- `/faction` — weekly rankings and history, faction totals, live member status, recent faction activity, director directory, company income history, and weekly star distribution
- `/settings` — personal API connections and account settings
- `/admin` — administrator workspace

All workspaces use the same authenticated member session. Sign-in is based on a member's own Torn API key and verified Naughty Souls membership. Company access is configured separately and is not a requirement for faction portal sign-in.

## Faction performance roadmap

The full product specification, verified API contract, data model, implementation phases and acceptance tests are maintained in [docs/FACTION-PERFORMANCE-DASHBOARD-PLAN.md](docs/FACTION-PERFORMANCE-DASHBOARD-PLAN.md). The branch implements scheduled public roster/stat/gym-energy collection, Sunday UTC rankings, immutable completed-week reports and comparisons, faction-wide totals, public live member status, a bounded activity feed, and audited administrator-only Sunday-boundary recovery. Weekly rankings include sortable columns, status/participation/anomaly filters and current/archived member drilldowns with metric deltas and capture provenance. Account Settings now includes a separate, consented owner-key connection for bars/cooldowns and optional detailed networth, with owner verification, AES-GCM storage, a shared 30-second request throttle, current-snapshot sharing and disconnect/departure deletion. Private-live refresh is member-triggered only; staging-D1 and real-member key acceptance remain pending. Longer activity trends, lifetime-counter context and finer per-metric freshness also remain planned work.

## Local development

- Install Node.js 20 or later.
- Run `npm ci`.
- Run `npm run dev` to start the frontend.
- Run `npm run typecheck` to check TypeScript.
- Run `npm test` to run backend regression tests.
- Run `npm run build` to create the production static site in `dist/`.

## Cloudflare Pages

The new production Pages project is `naughtyfamily.pages.dev`.

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root
- Build variable: `VITE_API_BASE_URL=https://naughty-company-api.kboone801.workers.dev`
- Production branch: `main`
- Preview deployments: disabled
- Automatic production deployments remain paused during the migration.

The previous `naughty-company-dashboard.pages.dev` project remains in place until the replacement is ready. No staging Pages project or preview deployment is used.

## Account security and Torn API

Members use their own Limited Access Torn API key to verify identity and Naughty Souls faction membership. Company director and secondary company keys are separate personal connections managed by the member in Account Settings. Members can replace their faction login key, add or remove company keys, and revoke all active sessions. Historical Halloween log collection requires each contributing member's own Full Access API key; Custom Access is not supported for that collector. Private faction live data uses a third, separate owner-key connection: the Worker verifies the key belongs to the signed-in player, requests only that owner's bars/cooldowns, and requests detailed networth only after a separate opt-in. The member explicitly consents to sharing their latest bars/cooldowns snapshot with authenticated current Naughty Souls members. The API key is AES-GCM encrypted and never shared. Only the latest private live snapshot is retained; the owner may refresh it manually or disconnect it, which deletes the key and snapshot. A shared 30-second server-side request throttle applies to connect and refresh attempts.

The faction-wide Halloween archive is shared with authenticated Naughty Souls members. Missing collection coverage must remain distinguishable from a true zero. Removing a saved credential must not silently erase event records already contributed to the shared archive. Each member records the Trick or Treat start time they selected in Torn: any 15-minute slot from 10:00 through 16:00 TCT (UTC). Their personal collection and live-snapshot window starts on October 25 at that time and ends on November 1 at the same TCT clock time. Members can correct the saved slot until collection or snapshot capture begins; afterward it is locked to protect the integrity of contributed data. Historical collection jobs retain the exact personal start/end timestamps they were created with.

Membership is rechecked during authenticated requests and by a bounded scheduled sweep for inactive accounts. Both paths atomically claim a per-member five-minute check window so overlapping requests and cron runs do not duplicate Torn calls. Verification state distinguishes an in-flight check, a genuine Torn outage, and a confirmed departure whose cleanup is pending. Only a genuine outage can use the short grace tied to the last successful verification (at most 15 minutes); a confirmed departure remains fail-closed until cleanup succeeds, even if Torn becomes unavailable during a retry. The same full departure cleanup is used whether a member is discovered by an authenticated request, the scheduled sweep, or either Halloween collector. Cleanup revokes administrator access first, then invalidates all sessions, removes the saved faction login key and Halloween contribution data, clears the stale faction-directory entry, and removes company-sharing relationships. Torn outages, rate limits, and key-validation failures are not treated as proof that someone has left.

Never submit another player's key, Torn password, session token, or other authentication material. API keys must only be used for data the member is authorized to access.

## Backend and deployment

The API Worker remains `naughty-company-api` at `https://naughty-company-api.kboone801.workers.dev`, using the `naughty-company-dashboard` D1 database. The portal branch contains ordered migrations through `migrations/auth/0023_member_private_live_connections.sql`. Migrations `0012`–`0018` cover administrator registry, membership verification and Halloween consent/collection; `0019` adds public faction-performance collection and membership history; `0020` adds idempotent Sunday-boundary runs; `0021` adds immutable completed-week reports; `0022` adds faction-wide stats snapshots; and `0023` adds separate consented owner-key private-live storage, snapshots and request throttling. A separate `naughty-company-api-staging` D1 database and fixture-backed integration Workers are used for stateful acceptance. Staging integration [Run 20](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41565717801) passed the public faction-performance D1/Queue pipeline. Staging [Run 21](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41569343997) applied migration `0023`, verified the staging migration ledger and confirmed all three private-live tables exist, then reran the public faction-performance D1/Queue acceptance successfully. Staging [Run 22](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41570310084) exercised private-live connect/refresh/networth-opt-in/disconnect through the isolated staging Worker and sanitized Torn Service Binding with synthetic members; all checks and the full public faction D1/Queue regression passed. No production D1 migration or production Worker/Pages cutover was performed.

Production Worker deployment is managed separately from Pages. Keep automatic production deployments paused and Pages preview deployments disabled until the migration review, non-admin/admin end-to-end acceptance, and explicit cutover approval are complete. The previous `naughty-company-dashboard.pages.dev` site remains the rollback target.
