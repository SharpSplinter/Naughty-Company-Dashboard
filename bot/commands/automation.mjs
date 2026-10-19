import { group, sub, str } from "../command-options.mjs";

export const automationCommand = { name: "automation", description: "Inspect notification preferences and manage webhook delivery", options: [
    group("notifications", "Inspect notification preferences managed in the dashboard", [
      sub("status", "Show severity, quiet-hours, and webhook delivery preferences")
    ]),
    group("webhook", "Inspect webhook delivery and retry failures", [
      sub("status", "Show encrypted webhook configuration and last delivery status"),
      sub("deliveries", "List recent webhook delivery attempts"),
      sub("retry", "Retry a failed webhook delivery", [str("delivery", "Choose a failed delivery to retry", true, { min_length: 1, max_length: 80, autocomplete: true })]),
      sub("delete", "Remove the external webhook and turn webhook digests off")
    ])
  ]};
