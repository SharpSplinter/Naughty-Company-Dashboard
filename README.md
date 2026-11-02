# Naughty Family Portal

A React + Vite multi-workspace portal for Naughty Souls faction members in Torn. The portal brings the existing Company Dashboard together with Halloween event intelligence, a faction workspace, shared account settings, and role-protected administration.

## Workspaces

- `/` — member portal
- `/company` — existing company operations dashboard
- `/halloween` — current-year and historical Halloween intelligence
- `/faction` — active member roster, cached director directory, company income history, and weekly star distribution
- `/settings` — personal API connections and account settings
- `/admin` — administrator workspace

All workspaces use the same authenticated member session. Sign-in is based on a member's own Torn API key and verified Naughty Souls membership. Company access is configured separately and is not a requirement for faction portal sign-in.

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

Members use their own Limited Access Torn API key to verify identity and Naughty Souls faction membership. Company director and secondary company keys are separate personal connections managed by the member in Account Settings. Members can replace their faction login key, add or remove company keys, and revoke all active sessions. Historical Halloween log collection requires each contributing member's own Full Access API key; Custom Access is not supported for that collector. Saved credentials are encrypted at rest by the Worker and are never stored as plaintext in browser storage.

The faction-wide Halloween archive is shared with authenticated Naughty Souls members. Missing collection coverage must remain distinguishable from a true zero. Removing a saved credential must not silently erase event records already contributed to the shared archive.

Membership is rechecked during authenticated requests and by a bounded scheduled sweep for inactive accounts. A confirmed faction departure invalidates sessions, removes the saved faction login key and Halloween contribution data, revokes administrator access, clears the stale faction-directory entry, and removes company-sharing relationships. Torn outages, rate limits, and key-validation failures are not treated as proof that someone has left.

Never submit another player's key, Torn password, session token, or other authentication material. API keys must only be used for data the member is authorized to access.

## Backend and deployment

The API Worker remains `naughty-company-api` at `https://naughty-company-api.kboone801.workers.dev`, using the `naughty-company-dashboard` D1 database. The portal rebuild adds ordered migrations through `migrations/auth/0016_membership_revalidation_scheduler.sql`; review and back up the production D1 database, then apply all required migrations in order before deploying Worker code that depends on them. In particular, migration `0016` adds the per-member scheduled membership-check timestamp used by the five-minute maintenance sweep. The migrations are not applied by this PR.

Production Worker deployment is managed separately from Pages. Keep automatic production deployments paused and Pages preview deployments disabled until the migration review, non-admin/admin end-to-end acceptance, and explicit cutover approval are complete. The previous `naughty-company-dashboard.pages.dev` site remains the rollback target.
