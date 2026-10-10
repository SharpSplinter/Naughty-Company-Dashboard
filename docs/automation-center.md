# Automation Center

The Automation Center adds private in-app alerts and visibility into scheduled Worker runs.

## First-release rules

- **Daily income drop:** compares the two most recent successful `company_snapshots` for the signed-in owner's company. It only triggers when both snapshots contain a finite `profile.income.daily` value and the previous value is greater than zero.
- **Stale company data:** alerts when the latest successful snapshot exceeds the configured age, or when no snapshot exists yet.
- **Refresh failure:** records a private alert when a scheduled company refresh fails. Error messages are truncated and credential-like values are redacted.

Rules are owner-scoped. An empty company selection means the owner's connected companies only. Alert APIs always filter by the authenticated `player_id`; they do not read another member's private company data and do not modify `company_sharing_recipients` or any Data Sharing settings. Alert events are deduplicated by rule and source event, with a configurable cooldown.

## Storage and deployment

The migration is `migrations/auth/0006_automation.sql`. It creates `alert_rules`, `alert_events`, and `automation_runs`. The Worker also creates these tables idempotently on first use so preview environments can exercise the feature before the migration is applied.

Before deploying the Worker to production, apply pending D1 migrations to the configured `naughty-company-dashboard` database, then deploy the Worker and verify `/health` and the authenticated alert endpoints. Do not apply the migration to production solely because a preview Pages build passed.

The scheduler now uses one daily `10 18 * * *` trigger. The handler detects Sunday from `scheduledTime` to perform the larger weekly faction-directory batch and capture weekly star counts, avoiding two overlapping runs at the same Sunday timestamp.

## API surface

- `GET /api/me/alert-rules`
- `POST /api/me/alert-rules`
- `POST /api/me/alert-rules/:ruleId` to change enabled state or bounded thresholds
- `DELETE /api/me/alert-rules/:ruleId`
- `GET /api/me/alerts?limit=50`
- `POST /api/me/alerts/:eventId/acknowledge`
- `GET /api/admin/automation/runs?limit=100&days=30` for the verified administrator; `days` accepts `7`, `30`, `90`, `365`, or `all` and returns the run list plus range-wide summary metrics and the top three repeated failure summaries.

Users can edit an existing alert rule in place: income-drop thresholds, stale-data age limits, and cooldown windows are saved through the owner-scoped rule endpoint without deleting alert history.

The administrator Operations panel includes Automation Insights: success rate (excluding in-progress runs), completed/failed/partial counts, average runtime, company failures, alerts created, time-window and status filters, per-run duration, and the most frequent recorded failure summaries. Summary aggregates cover the entire selected time window even though the visible run list is capped at 100 entries.

Notifications are in-app only in this release. External delivery, quiet hours, and additional metric types remain later stages.
