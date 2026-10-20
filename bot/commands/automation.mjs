import { group, sub, str } from "../command-options.mjs";

export const automationCommand = { name: "automation", description: "Inspect notification preferences and manage webhook delivery", options: [
    group("notifications", "Inspect notification preferences and private alert delivery", [
      sub("status", "Show preferences and private alert polling health"),
      sub("deliveries", "List failed private alert DM deliveries"),
      sub("retry", "Requeue an exhausted private alert DM", [str("event", "Choose a failed private alert to retry", true, { min_length: 1, max_length: 80, autocomplete: true })])
    ]),
    group("webhook", "Inspect webhook delivery and retry failures", [
      sub("status", "Show encrypted webhook configuration and last delivery status"),
      sub("deliveries", "List recent webhook delivery attempts"),
      sub("retry", "Retry a failed webhook delivery", [str("delivery", "Choose a failed delivery to retry", true, { min_length: 1, max_length: 80, autocomplete: true })]),
      sub("delete", "Remove the external webhook and turn webhook digests off")
    ])
  ]};
