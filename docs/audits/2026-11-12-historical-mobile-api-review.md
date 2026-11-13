# Historical Lock-in Audit, Mobile Review, and API Budget Assessment

**Review date:** 12 November 2026 (America/New_York)  
**Repository baseline reviewed:** `main` at `c1a104aff63c66cd3c7ea23fb5c1601ec6418337`  
**Primary audit tracker:** [Issue #117](https://github.com/SharpSplinter/Naughty-Company-Dashboard/issues/117)  
**Review mode:** Read-only source and recorded-evidence review. No production database query, production deployment, or live mobile-device test was performed for this report.

## Executive assessment

| Area | Assessment | What is still needed |
|---|---|---|
| Historical stock and profit | **Baseline reconciles; acceptance remains open** | Two subsequent real lock-ins after source-timestamp validation, checked against production history and Discord delivery |
| Mobile experience | **Responsive structure is present; runtime verification pending** | Viewport smoke test at narrow phone, large phone, tablet, and desktop widths |
| Torn API budget | **Controlled batching exists, but error classification needs correction** | Correct Torn error-code mapping, request-level telemetry, and a measured production baseline |
| Worker/D1 request budget | **Some avoidable repeated reads found** | De-duplicate the Trends history request and measure Worker/D1 usage |

The historical evidence from 19–20 October is internally consistent, but it is not proof of two post-validation daily lock-ins. The code review also found a specific Torn API error-code mapping defect: the client currently maps Torn error code 9 to rate limiting, whereas Torn documents code 5 as “Too many requests” and code 9 as “API disabled.” This should be fixed before relying on rate-limit alerts or retry logic.

## 1. Historical stock and profit audit

### 1.1 Existing production evidence: Knotty Oil [Hiring]

The last detailed production cross-check recorded in Issue #117 covers reporting days 19 and 20 October 2026 for Knotty Oil [Hiring], company ID `96639`. The recorded evidence came from the read-only query run [39539719140](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/39539719140).

| Reporting day (UTC) | Canonical director/stock row | Snapshot provenance | Stock quantity | Daily income | Trends daily profit |
|---|---:|---|---:|---:|---:|
| 2026-10-19 | 1 | `legacy`; fetched 18:11:06.367Z | 1,182,390 | $155,446,380 | $61,501,610 (reconstructed) |
| 2026-10-20 | 1 | `lock-in`; fetched 18:11:06.000Z | 999,865 | $156,636,975 | $62,692,205 (reconstructed) |

**Stock movement:** 999,865 − 1,182,390 = **−182,525 units**. The October 20 Discord daily summary reported the same stock movement. The canonical director history had one row for each day. October 19 had three ordinary profile rows, but those did not create duplicate canonical director/stock rows.

**Profit reconciliation:** the saved input values on both dates were:

- Advertising budget: $13,200,000
- Fully known employee wages: $80,744,770
- Stock-order expense: $0

The cost reconstruction is:

| Reporting day | Calculation | Reconstructed profit |
|---|---|---:|
| 2026-10-19 | $155,446,380 − $13,200,000 − $80,744,770 − $0 | **$61,501,610** |
| 2026-10-20 | $156,636,975 − $13,200,000 − $80,744,770 − $0 | **$62,692,205** |

The profit movement was +$1,190,595, the same as the daily-income movement because the three expense inputs were unchanged. The recorded Discord delivery ledger and saved post-send state for October 20 corroborated income, profit, and stock quantity.

### 1.2 Evidence limitation

October 20 is explicitly a `lock-in` row. October 19 is tagged `legacy`, so it is useful as a reconciled baseline but does not independently prove that the current Torn source-timestamp validation was applied to that record. Neither date is a subsequent cycle after the current validation deployment.

**Issue #117 therefore remains open.** The required two subsequent real daily lock-in cycles have not been evidenced in the audit material reviewed here. This review did not query production D1 for newer rows, so it does not claim that more recent cycles have passed or failed.

### 1.3 Current code-level controls found

The reviewed source contains the following protections:

- Scheduled company capture requests the combined Torn `timestamp,profile,stock,employees` selection and passes the Torn source timestamp into the official snapshot gate.
- The reporting day is aligned to the 18:00 UTC boundary using the saved timestamp minus 18 hours.
- Canonical director stock snapshots distinguish `lock-in`, `legacy`, and `initialization` provenance.
- The official scheduled lock-in path can replace a same-day legacy/initialization row, but does not turn ordinary on-demand refreshes into official lock-ins.
- The admin endpoint refresh code explicitly avoids appending immutable history from live on-demand profile, employee, or stock refreshes.
- The Trends history path selects one latest company profile snapshot per reporting day, joins canonical stock provenance and daily financial stock history, and exposes advertising budget, employee wages, and stock-order expense.
- Stock quantity remains unknown when any item in a saved stock payload lacks a finite quantity; it is not silently summed as zero.
- Historical daily profit is cost-reconstructed only when daily income, advertising budget, wages, and stock-order expense are all available. A direct reported value is retained with reconciliation detail; incomplete inputs remain incomplete.
- Existing merged work includes [PR #122](https://github.com/SharpSplinter/Naughty-Company-Dashboard/pull/122) for unknown stock quantities, [PR #124](https://github.com/SharpSplinter/Naughty-Company-Dashboard/pull/124) for the 18:10 UTC source-time gate, [PR #125](https://github.com/SharpSplinter/Naughty-Company-Dashboard/pull/125) for stock provenance in Trends, and [PR #126](https://github.com/SharpSplinter/Naughty-Company-Dashboard/pull/126) for auditable profit inputs and reconciliation.

These are code-level controls, not substitutes for real-cycle evidence.

### 1.4 Checklist for each of the next two lock-ins

For the selected company and each required reporting day, record:

| Check | Evidence to capture | Pass condition |
|---|---|---|
| Scheduled trigger | Cron, scheduled timestamp, automation run ID | The intended 18:10 UTC daily capture ran |
| Torn source time | Returned source timestamp and saved snapshot timestamp | Source timestamp passes the official gate and maps to the expected reporting day |
| Canonical stock row | Row count, `snapshot_kind`, `fetched_at`, `snapshot_day` | Exactly one canonical row for the company/day; provenance is `lock-in` |
| Ordinary refresh isolation | Profile/employee/stock refreshes and resulting history rows | Ordinary refreshes do not add or overwrite official lock-in history |
| Daily stock | Item quantities, total quantity, stock source timestamp | Total is numeric only when every item quantity is known |
| Profit inputs | Daily income, advertising, wage coverage/count, stock-order expense | All four values are numeric for a reconstructed profit; otherwise profit stays incomplete |
| Profit reconciliation | Reported profit, calculated profit, reconciliation delta | The displayed source and delta agree with the saved inputs |
| Consecutive-day movement | Current and previous reporting-day stock totals | Delta is current minus previous; no skipped or arbitrary live baseline |
| Trends consistency | Chart point, summary delta, historical reporting-point table | All views show the same saved reporting points and values |
| Discord corroboration | Delivery ledger, report date, saved summary values | Discord reflects the same reporting-day data, or a documented delivery failure exists |

**Daily profit identity:** when all inputs are complete,

`daily profit = daily income - advertising budget - employee wages - stock-order expense`

**Stock movement identity:** when both reporting-day totals are known,

`stock delta = current reporting-day quantity - previous reporting-day quantity`

After two subsequent real daily lock-ins pass the above checks, attach the evidence to Issue #117 and then consider closure. A failed, missing, or partial cycle should be recorded explicitly and should not count as a pass.

## 2. Mobile layout review

### 2.1 Responsive behavior present in source

The application includes a viewport meta tag and a responsive navigation/layout strategy:

- The sidebar defaults to a collapsed state.
- On desktop, the collapsed sidebar becomes a 68px icon rail.
- At widths up to 640px, the collapsed sidebar moves off-canvas and the main content uses the full width.
- Expanding the sidebar on a phone opens a drawer constrained to `min(280px, 84vw)`, with a close control and a dimmed page overlay.
- The top bar, user/company switcher, welcome section, panels, and several metric grids have narrow-screen rules.
- Charts are placed in horizontally scrollable containers.
- Tables are placed in scroll containers rather than forcing their full width into the phone viewport.

This is a solid responsive foundation, but this was a CSS/React source review only. No real device, browser viewport, keyboard, or screen-reader test was run.

### 2.2 Narrow-screen pressure points

| Component | Source behavior | Risk / review note |
|---|---|---|
| Ranking table | `min-width: 1180px` | On a phone this necessarily requires horizontal scrolling; make the scroll affordance obvious and verify key columns remain understandable |
| Charts | SVG line chart `min-width: 520px` inside `overflow-x: auto` | Deliberate horizontal scrolling; test axis labels, touch scroll, and chart clipping |
| Sidebar controls | Toggle and close controls are 34px square in the phone rules | Usable in source, but smaller than a recommended comfortable touch target; consider 40–44px |
| Top-bar company label | Clamped to 70px, then 48px at widths ≤360px | Ellipsis prevents expansion, but test whether company switching remains understandable |
| Drawer backdrop | Overlay is rendered with `pointer-events: none`; a dedicated close button exists | Tapping the backdrop will not itself dismiss the drawer; decide whether that behavior is intentional and test the close control |
| Dense data tables | Tables retain nowrap behavior and depend on their scroll wrappers | Confirm horizontal scrolling is discoverable and does not trap vertical scrolling |

### 2.3 Suggested manual viewport matrix

Run this against the staging build with both a regular member and an administrator session:

| Viewport | Primary checks |
|---|---|
| 320 × 720 | No page-level horizontal overflow; close button and company switcher usable; form fields fit |
| 360 × 800 | Drawer opens/closes; top bar does not collide; breadcrumbs may hide as designed |
| 390 × 844 | Overview cards, company switcher, table and chart scroll work with touch |
| 430 × 932 | Verify normal phone layout and the drawer overlay |
| 640 × 900 | Verify breakpoint transition and no abrupt width jumps |
| 768 × 1024 | Tablet navigation, multi-column grids, and ranking table scroll |
| 1024 × 768 | Desktop/tablet sidebar and content columns remain balanced |
| 1440 × 900 | Desktop layout and collapsed icon rail remain correct |

**Mobile assessment:** no confirmed blocker from source inspection, but runtime acceptance is pending. The highest-value fixes to consider after the viewport test are larger navigation touch targets, a clearer scroll affordance for wide tables/charts, and backdrop-tap dismissal if that is the intended drawer behavior.

## 3. Torn API budget review

### 3.1 Official quota reference

Torn's API documentation states a limit of **100 individual requests per minute per Torn user across all of that user's API keys**, plus a separate IP-level limit of 5,000 requests per minute. Torn also documents that cache hits within its service cache do not count toward the user's request limit. These limits can change; use the official API documentation as the source of truth: [Torn API documentation](https://staticfiles.torn.com/api.html).

Relevant documented error codes:

- **Code 5:** too many requests.
- **Code 9:** API disabled.

### 3.2 Confirmed client defect

The shared `TornApiClient` currently maps code 9 to HTTP 429 and leaves code 5 on the generic failure path. That is the reverse of the documented meaning for those two codes.

The client does preserve the upstream `Retry-After` header in `TornApiClientError`, but its generic request method throws immediately rather than implementing bounded retry/backoff.

**Priority: high.** Correct the mapping before adding automated rate-limit retries or using 429 counts as a trustworthy budget signal:

1. Map code 5 to the rate-limit path (429).
2. Map code 9 to a distinct API-disabled/configuration failure, not 429.
3. Keep 401/403 and API-disabled conditions out of retry loops.
4. For safe GETs, add only bounded backoff for actual rate limits and honor `Retry-After` where present.
5. Test both HTTP 429 and Torn JSON error payloads where the HTTP response itself is successful but the body contains an API error.

### 3.3 Torn request-volume model

The repository does not expose a complete per-upstream-request counter in the admin refresh summary. The following is a source-derived budget model, not a measurement of live production traffic.

| Workload | Source-derived request shape | Budget implication |
|---|---|---|
| Scheduled company capture | One combined `/company?selections=timestamp,profile,stock,employees` request per saved company key, per scheduled capture | Approximately `2 × connected company keys` requests per day across the two daily cron windows |
| Faction directory | One `/faction/members` request, then up to the processing limit of `/user/:id/job` lookups; confirmed directors can require an additional `/company/:id/profile` call | A batch of 35 is not 35 raw requests; director profile lookups add to the member/job calls |
| User-triggered faction refresh | POST route uses a 20-member processing limit and a 12-hour cache; admin refresh uses a forced batch of 35 | Forced admin refreshes can deliberately bypass the normal per-member freshness cache |
| Global rankings | Fetch the company-type catalog, then paginate type-specific company lists at 100 rows/page | Production queue processes up to three pages per Worker invocation, serializes the consumer at concurrency 1, and requeues remaining pages |
| Official global verification | One `/v2/company/snapshot` request in the 00:10 UTC scheduled window | One additional request on the verification run |
| Admin company endpoint refresh | Separate profile, employee, and stock calls for each selected company connection | Selecting all three costs up to three Torn requests per company, versus one combined selection request when its permissions are available |

For the faction directory, each checked member costs at least one job lookup. A member whose job confirms a company director can cost another profile lookup. Therefore, a single successful logical `faction-directory` endpoint in the admin job summary can represent many underlying Torn HTTP requests. The existing `attempted/succeeded` endpoint counters should not be interpreted as raw API-call counts.

The previous recorded faction run processed 135 users in four batches with 18 directors. That confirms the batching path can complete a substantial roster, but the logical endpoint result alone is not sufficient to infer the raw Torn request count.

### 3.4 Worker and D1 request budget

The Trends screen currently loads the same company history endpoint twice when opening the Trends view:

- `loadTrends()` requests the selected `days` range.
- `loadComparison()` separately requests a 30-, 90-, or 365-day range.

These are authenticated Worker/D1 reads, not Torn requests. The history handler reads the selected company's daily profile rows, canonical stock/provenance rows, and daily financial stock rows. The duplicate fetch therefore repeats Worker and D1 work and transfers overlapping history data.

**Priority: medium.** Request the largest range needed once, derive the selected chart and comparison periods from that response, and reuse it for the current view. Preserve the separate range controls at the UI level.

The report does not include Cloudflare analytics, actual D1 row-read counts, Worker invocation totals, or production request logs. Actual Worker/D1 cost cannot be calculated from source alone.

### 3.5 API budget recommendations

| Priority | Recommendation | Expected benefit |
|---|---|---|
| P1 | Correct Torn code 5/code 9 mapping and test it | Reliable throttling vs disabled-API diagnosis |
| P1 | Add per-request counters by workload and endpoint | Actual requests/minute and daily request budget become measurable |
| P1 | Log 429/code 5, Retry-After, timeout, API-disabled and permission-denied outcomes separately | Prevents configuration failures from being misclassified as rate limits |
| P2 | De-duplicate the two Trends history loads into one max-range fetch | Lowers duplicate Worker invocations, D1 reads, and repeated history payloads |
| P2 | Use the combined company-selection endpoint for manual refresh when permitted, with a safe permission-aware fallback | Reduces the three independent profile/employee/stock calls toward one per company |
| P2 | Add a warning threshold at 60–70% of the documented per-user minute limit | Preserves headroom for interactive user actions and retries |
| P2 | Add a queue/request budget test for the maximum expected company roster and faction size | Catches call-volume growth before a production schedule change |

The 60–70% warning level is a recommended internal safety threshold, not a Torn requirement. The official limit is 100 requests per user per minute.

## 4. Open decisions and next audit actions

1. Keep [Issue #117](https://github.com/SharpSplinter/Naughty-Company-Dashboard/issues/117) open until two subsequent post-validation lock-ins are checked end to end.
2. On each lock-in day, attach the evidence rows and calculations from Section 1.4, including source timestamp, canonical snapshot kind, profit-input completeness, stock delta, Trends agreement, and Discord corroboration.
3. Correct Torn error-code mapping before building rate-limit dashboards or retry policies.
4. Add request-level counters that distinguish Torn HTTP calls from logical endpoint/job counts.
5. Run the mobile viewport matrix on the staging build and capture any overflow, touch-target, navigation, or table-scroll defects.
6. Re-review Cloudflare Worker/D1 usage after adding request counters and de-duplicating Trends history reads.

## 5. Scope and confidence notes

- Historical figures above are copied from the recorded October 19–20 production audit in Issue #117; they were not re-queried from production during this review.
- Mobile findings are based on CSS/React source inspection only, not a device/browser test.
- API request counts are source-derived workload shapes, not observed usage or quota percentages.
- No production database, Worker, Pages, Discord bot, Torn API credential, or user data was changed as part of this review.
- The separate seven-day weekly-profit changes in PRs #152 and #153 remain draft work and are not part of the reviewed `main` baseline cited at the top of this report.
