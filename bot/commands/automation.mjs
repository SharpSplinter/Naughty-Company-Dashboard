import { sub, group, str, integer } from "../command-options.mjs";

export const automationCommand = { name: "automation", description: "Manage private alert rules, notification preferences, and webhook delivery", options: [
    group("rules", "Create and manage your private alert rules", [
      sub("list", "List your alert rules and their current state"),
      sub("create", "Create a private alert rule", [
        str("rule_type", "Rule template", true, { choices: [
          { name: "Daily income drop", value: "income_drop" },
          { name: "Stale company data", value: "stale_data" },
          { name: "Scheduled refresh failure", value: "refresh_failure" },
          { name: "Daily income increase", value: "income_increase" },
          { name: "Company rating drop", value: "rating_drop" },
          { name: "Employee roster change", value: "roster_change" }
        ]}),
        str("company", "Optional company; leave blank to cover all connected companies", false, { min_length: 1, max_length: 20, autocomplete: true }),
        integer("threshold_percent", "Change percentage threshold, 1–90", false, { min_value: 1, max_value: 90 }),
        integer("cooldown_hours", "Repeat-alert cooldown in hours, 1–168", false, { min_value: 1, max_value: 168 }),
        integer("stale_after_hours", "Stale-data age in hours, 1–168", false, { min_value: 1, max_value: 168 })
      ]),
      sub("enable", "Enable a paused alert rule", [str("rule", "Choose a paused rule", true, { min_length: 1, max_length: 80, autocomplete: true })]),
      sub("disable", "Pause an enabled alert rule", [str("rule", "Choose an enabled rule", true, { min_length: 1, max_length: 80, autocomplete: true })]),
      sub("delete", "Delete a rule and its associated alert history", [str("rule", "Choose a rule to delete", true, { min_length: 1, max_length: 80, autocomplete: true })])
    ]),
    group("notifications", "Inspect and configure alert notification preferences", [
      sub("status", "Show severity, quiet-hours, and delivery preferences"),
      sub("configure", "Change severity, quiet hours, time zone, or digest mode", [
        str("minimum_severity", "Lowest severity for browser/webhook delivery", false, { choices: [
          { name: "Info and above", value: "info" },
          { name: "Warning and critical only", value: "warning" },
          { name: "Critical only", value: "critical" }
        ]}),
        { type: 5, name: "quiet_hours_enabled", description: "Suppress supported notifications during quiet hours", required: false },
        str("quiet_hours_start", "Quiet-hours start, 24-hour HH:MM", false, { min_length: 5, max_length: 5 }),
        str("quiet_hours_end", "Quiet-hours end, 24-hour HH:MM", false, { min_length: 5, max_length: 5 }),
        str("timezone", "IANA time zone, e.g. America/New_York", false, { max_length: 80 }),
        str("digest_mode", "External webhook delivery mode, separate from Discord DMs", false, { choices: [
          { name: "Instant alerts", value: "instant" },
          { name: "Daily summary only", value: "daily" },
          { name: "Instant alerts and daily summary", value: "both" },
          { name: "Webhook delivery off", value: "off" }
        ]})
      ])
    ]),
    group("webhook", "Inspect webhook delivery and retry failures", [
      sub("status", "Show encrypted webhook configuration and last delivery status"),
      sub("deliveries", "List recent webhook delivery attempts"),
      sub("retry", "Retry a failed webhook delivery", [str("delivery", "Choose a failed delivery to retry", true, { min_length: 1, max_length: 80, autocomplete: true })]),
      sub("delete", "Remove the external webhook and turn webhook digests off")
    ])
  ]};
