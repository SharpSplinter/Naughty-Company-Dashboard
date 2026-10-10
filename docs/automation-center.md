# Automation Center

The Automation Center is available to every authenticated dashboard user for their own companies, adding private in-app alerts and visibility into scheduled Worker runs. Account-level run analytics and administrative controls remain restricted to administrators.

## Rule templates

- **Daily income drop:** compares the two most recent successful `company_snapshots` for the signed-in owner's company. It only triggers when both snapshots contain a finite `profile.income.daily` value and the previous value is greater than zero.
- **Stale company data:** alerts when the latest successful snapshot exceeds the configured age, or when no snapshot exists yet.
- **Refresh failure:** records a private alert when a scheduled company refresh fails. Error messages are truncated and credential-like values are redacted.
- **Daily income increase:** celebrates a configured percentage increase between the two latest successful snapshots.
- **Company rating drop:** detects a configured percentage decrease in the saved star-rating field.
- **Employee roster change:** detects a configured percentage increase or decrease in employee headcount between snapshots.

Percentage thresholds are bounded, invalid/missing values do not trigger metric alerts, and each rule uses its own cooldown and deduplication key.

Rules are owner-scoped. An empty company selection means the owner's connected companies only. Alert APIs always filter by the authenticated `player_id`; they do not read another member's private company data and do not modify `company_sharing_recipients` or any Data Sharing settings. Alert events are deduplicated by rule and source event, with a configurable cooldown.

## Storage and deployment

The initial migration is `migrations/auth/0006_automation.sql`; `migrations/auth/0007_automation_delivery_and_rules.sql` expands the rule types and adds notification settings, encrypted webhook configuration, and delivery history. The initial migration creates `alert_rules`, `alert_events`, and `automation_runs`. The Worker creates the notification preference, webhook, and delivery-log tables idempotently on first use. On an existing database, the migration is still required to expand the `alert_rules` type constraint before the new metric rule types can be saved.

Before deploying the Worker to production, apply pending D1 migrations to the configured `naughty-company-dashboard` database, then deploy the Worker and verify `/health` and the authenticated alert endpoints. Do not apply the migration to production solely because a preview Pages build passed.

The scheduler now uses one daily `10 18 * * *` trigger. The handler detects Sunday from `scheduledTime` to perform the larger weekly faction-directory batch and capture weekly star counts, avoiding two overlapping runs at the same Sunday timestamp.

## API surface

- `GET /api/me/alert-rules`
- `POST /api/me/alert-rules`
- `POST /api/me/alert-rules/:ruleId` to change enabled state or bounded thresholds
- `DELETE /api/me/alert-rules/:ruleId`
- `GET /api/me/automation-preferences` / `POST /api/me/automation-preferences`
- `GET /api/me/automation-webhook`, `POST /api/me/automation-webhook`, `DELETE /api/me/automation-webhook`
- `GET /api/me/automation-webhook/deliveries?limit=20` and `POST /api/me/automation-webhook/retry/:eventId`
- `GET /api/me/alerts?limit=50`
- `POST /api/me/alerts/:eventId/acknowledge`
- `GET /api/admin/automation/runs?limit=100&days=30` for the verified administrator; `days` accepts `7`, `30`, `90`, `365`, or `all` and returns the run list plus range-wide summary metrics and the top three repeated failure summaries.

Users can edit an existing alert rule in place: income-drop thresholds, stale-data age limits, and cooldown windows are saved through the owner-scoped rule endpoint without deleting alert history.

The administrator Operations panel includes Automation Insights: success rate (excluding in-progress runs), completed/failed/partial counts, average runtime, company failures, alerts created, time-window and status filters, per-run duration, and the most frequent recorded failure summaries. Summary aggregates cover the entire selected time window even though the visible run list is capped at 100 entries.

## Notifications and delivery

- In-app alerts remain the durable source of truth and are never suppressed by quiet hours.
- Optional browser notifications are user-enabled and respect the configured IANA time zone and quiet-hours window. Permission is requested only after the user opts in. A browser that does not grant notification permission continues to show the in-app inbox normally.
- Optional HTTPS webhook delivery posts a compact `automation.alert` JSON event. The endpoint URL is encrypted at rest with the Worker key-encryption secret, is never returned to the browser after saving, and is validated to reject non-HTTPS URLs, embedded credentials, local hostnames, and common private IP ranges. Users should only configure endpoints they control.
- Webhook delivery attempts are logged per alert, including HTTP status and a bounded outcome message; failed attempts can be retried from the Automation Center. A webhook failure never rolls back the alert event.
- The minimum-severity preference applies to browser notifications and webhook delivery. Quiet hours currently suppress browser notifications only; webhook delivery is immediate. In-app alert history remains available at all times.

Apply `migrations/auth/0007_automation_delivery_and_rules.sql` after `0006_automation.sql` before deploying the Worker. It expands the allowed rule types while preserving existing rules and alert history, and creates notification preference, webhook, and delivery-log tables. The Worker creates these tables idempotently for preview environments, but the production migration is still required for the existing rule-type check constraint.


The alert inbox supports client-side search across alert titles, messages, and company names, plus filters for company, acknowledgement status, rule type, and severity. Filtering applies to the latest alert batch loaded for the signed-in account; the unread total remains account-wide.
