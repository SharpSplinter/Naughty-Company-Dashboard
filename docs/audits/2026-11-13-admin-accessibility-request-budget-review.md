# Admin, accessibility, and request-budget review

**Review date:** 2026-11-13  
**Repository:** `SharpSplinter/Naughty-Company-Dashboard`  
**Branch:** `portal-rebuild`  
**Reviewed commit:** `1a9fcfc2be71088d48081457af176a118ab40446`  
**Staging workflow:** [Run #43359038091](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43359038091)

## Scope and environment

This review exercised the administrator and ordinary-member experiences against the isolated acceptance environment:

- Pages: `naughtyfamily-staging.pages.dev`
- Worker: `naughtyfamily-api-staging.kboone801.workers.dev`
- D1: `naughtyfamily-acceptance-staging` (`02cca699-1232-495f-8a0a-de525058b92a`)

The workflow's isolation guard passed before deployment. It verified the named staging Worker, Pages project, D1 ID and staging queues, and rejected the known production D1 ID.

Fixtures were synthetic: two ordinary member sessions and one administrator session. The administrator role was inserted into the staging administrator registry for the test. No member Torn credential or real account was used. The workflow's unconditional cleanup succeeded and removed the three synthetic identities, their sessions, role entry and history. The non-admin denial audit rows for these synthetic actors were also removed.

## Authorization and role behavior

All checks passed:

- The admin session endpoint resolved the synthetic administrator as `isAdmin: true`.
- The ordinary member session resolved as `isAdmin: false`.
- Anonymous access to an admin API route returned HTTP 401.
- Seven representative ordinary-member attempts against admin read and write route families returned HTTP 403, including a grant request. The guard denied the request before any admin mutation handler ran.
- The ordinary-member browser did not display the Admin Panel workspace card. Direct navigation to `/admin` showed the access-denied view and did not mount the admin console.
- The administrator browser opened all eight sections: Overview, Members, Administrators, Operations, History & Backups, Global Settings, Weekly Boundaries and Audit Log.
- Role-grant and refresh-job actions remained disabled in read-only mode. No mutating admin request was sent by the browser walkthrough.

## Accessibility

Automated axe-core scans ran with WCAG 2.1 A/AA tags on ten rendered views: the member portal, the member's direct-admin denial view, and each of the eight administrator sections.

**Final result: zero axe violations, including zero serious or critical findings.**

The first scan identified two serious `scrollable-region-focusable` findings in Operations and Audit Log. The admin table scrollers were corrected to be keyboard-focusable and exposed as named regions. The complete staging suite was rerun after that fix and passed.

This is automated rule-based coverage. It does not replace manual screen-reader testing, keyboard-only usability review by a person, or physical-device validation.

## Request budget and load smoke

The admin browser walkthrough generated **14 admin API GET requests and zero mutations** while opening all eight sections.

The API smoke test made **20 successful admin GET requests**, in two rounds, with batches of five concurrent requests. Measured timings for this staging run were:

| Measure | Duration |
|---|---:|
| p50 | 241.6 ms |
| p95 | 463.7 ms |
| Maximum | 972 ms |

The route set covered the admin overview, member list, jobs, settings, history summary, audit log, administrator registry, weekly-boundary diagnostics, automation runs and member activity. All returned HTTP 200 for the administrator session. Ordinary-member and anonymous denial responses were tested separately as described above.

Two application request-cost improvements were included:

1. The admin request schema bootstrap now caches its initialization promise per D1 binding in the Worker isolate. This avoids repeating the admin job schema `PRAGMA` and the two `CREATE TABLE IF NOT EXISTS` checks on every admin route request. A failed initialization clears the cached promise so a later request can retry.
2. The History & Backups “Reload coverage” action now refreshes only the history summary rather than re-running the complete admin overview/member/jobs/settings/audit load.

The measured burst is deliberately small and read-only. It is a latency and request-count smoke, **not** a sustained stress test, a high-concurrency capacity test, or a substitute for Cloudflare production analytics. These numbers are specific to this staging run and must not be presented as production latency or capacity.

Read-only admin page navigation and API inspection do not call Torn. The staging tests did not trigger manual refresh jobs, connection repairs, settings writes, exports, restores, role changes or any other operation that could create Torn API traffic.

## Validation result

- Repository quality gates: passed on the reviewed commit.
- Discord Bot Quality Gates: passed on the reviewed commit.
- Staging isolation and D1 migration checks: passed.
- Staging Worker health, key-encryption readiness and CORS: passed.
- Existing authenticated Company Dashboard responsive suite: passed at its eight configured viewport widths.
- Admin/non-admin, accessibility and request-budget checks: passed.
- Synthetic fixture cleanup: passed.
- Staging validation artifact: [company-dashboard-staging-validation](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43359038091).

## Remaining limits and release gates

- The administrator console's full eight-section walkthrough and axe scan were performed in the desktop browser viewport. The existing eight-width responsive suite is for the Company Dashboard workspace; it is not a physical-device test of every administrator screen.
- Manual screen-reader and physical-device review remain advisable.
- Sustained load testing and a measured production Worker/D1 request baseline remain outstanding.
- Issue [#117](https://github.com/SharpSplinter/Naughty-Company-Dashboard/issues/117) remains open until two subsequent real production daily lock-in cycles pass the specified historical stock/profit checks.
- Production backup verification and cutover preparation remain outstanding.

No production D1 was queried or written by this review. No production Worker or Pages deployment/cutover was performed. PR #152 remains Draft and unmerged.
