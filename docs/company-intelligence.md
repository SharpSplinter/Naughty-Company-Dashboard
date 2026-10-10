# Company Intelligence Workspaces

The dashboard includes five connected intelligence views in addition to Company Details and the existing Trends & Charts workspace.

## API Health & Data Freshness

`GET /api/me/health` probes the authenticated user's D1-backed dashboard data and reports Worker/database status, snapshot coverage, and per-company freshness. Freshness is measured from the last successful saved company record: under 12 hours is fresh, 12 to 24 hours is aging, and 24 hours or more is stale. This is a data-freshness signal, not a guarantee that Torn's upstream API is currently reachable. `/health` also performs a database connectivity probe without exposing account-specific data.

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
