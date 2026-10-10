# Company Intelligence Workspaces

The dashboard includes five connected intelligence views in addition to Company Details and the existing Trends & Charts workspace.

## API Health & Data Freshness

`GET /api/me/health` probes the authenticated user's D1-backed dashboard data and reports Worker/database status, snapshot coverage, and per-company freshness. Freshness is measured from the latest successful saved `company_snapshots` record for each connected company against one daily UTC boundary at 18:10. A snapshot at or after the latest 18:10 UTC boundary is fresh; a snapshot before it is stale. There is no 12-hour/aging state and no rolling 24-hour cutoff. This aligns the status with Torn company API data being locked between 18:00 and 18:10 UTC daily. A connected company without a saved snapshot is `never` synced and counts as stale for the summary. Summary counts cover every connected company; the detailed table shows at most the 100 most recently refreshed companies and discloses when the list is truncated. Database probe failures are returned as a safe, explicit health state without leaking internal diagnostics. This is a dashboard Worker/database and saved-data health signal, not a guarantee that Torn's upstream API is currently reachable. `/health` also performs a database connectivity probe without exposing account-specific data and returns HTTP 503 when D1 is unavailable.

## Historical Trends and Comparisons

`GET /api/me/companies/:companyId/history?days=7|30|90|365|all` returns an owner-scoped daily series derived from successful `company_snapshots`. The response includes daily/weekly income, star rating, roster size, reporting timestamps, and window summary deltas. Multiple snapshots on one date are collapsed to the latest saved snapshot for that date. The UI shows period-over-period daily-income averages when the selected history window has sufficient coverage. Missing or restricted values remain unknown rather than being treated as zero.

## Member Activity & Roster Insights

`GET /api/me/member-insights?companyId=...` is owner-scoped and summarizes the selected connected company's roster, capacity, available MAN/INT/END stats, effectiveness, known wages, tenure, position mix, and snapshot history. Unavailable employee stats are excluded from averages. Administrators can also use `GET /api/admin/member-activity?days=30` for account-level activity and data coverage. Its last-activity signal is the `players.updated_at` field, which is updated by account-record writes and should be interpreted as an approximate activity signal rather than a complete audit trail.

## Executive Overview and Customizable Dashboard Layout

The Executive Overview combines health, current income, roster metrics, historical trend, recent alerts, automation status, and competitive indicators. `GET /api/me/dashboard-layout` reads a per-user widget layout from `user_page_data`; `POST /api/me/dashboard-layout` validates and persists a whitelist of widget IDs, visibility, and ordering. The default layout is used when no saved preferences exist. Layout preferences contain no API keys or company data.

## Data scope and privacy

All `/api/me/*` routes require an active dashboard session and filter data by its `player_id`. History and roster endpoints verify company ownership before returning records. The admin activity route requires the existing administrator identity check. None of these endpoints modify company data-sharing permissions or expose stored credentials.

## Migrations and deployment

Apply `migrations/auth/0007_automation_delivery_and_rules.sql` after the Automation Center migration. The Pages preview validates the frontend bundle, but the Worker and D1 migration must be deployed separately according to the project's Cloudflare deployment process before production API calls can use these endpoints.


## Performance & Staffing Insights

The Performance & Staffing Insights workspace adds explainable, non-forecasting review prompts from saved history and current roster data. Income anomaly checks require at least four recorded days in each of two adjacent 7-day windows and a material average drop; single-point income outliers are compared against the median of recent reporting points. Rating and roster changes are checked against dated snapshots. Staffing prompts use only available employee effectiveness, mapped role requirements, capacity, and stat-coverage information. Missing values are not treated as zero, and unused capacity is not interpreted as an automatic hiring recommendation.

Findings are review prompts, not predictions or automatic personnel decisions. Users can mark findings open, monitoring, resolved, or dismissed. This status tracking is saved in browser local storage per selected company and browser, not synced across devices. The Executive Overview includes a customizable Actionable Insights widget. Existing Automation Center rules provide configurable thresholds and deduplicated scheduled alerts for income drops, rating changes, roster changes, and stale data; the new insights workspace links to those controls rather than creating a second alert engine. No income forecasting is included.
