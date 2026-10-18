import { sub, group, str, integer, companyId, period, detail } from "../command-options.mjs";

export const companyCommand = { name: "company", description: "Privately inspect your connected company data", options: [
    sub("list", "List companies connected to your dashboard"),
    sub("overview", "Show income, profit, stars, employees, stock, and freshness", [companyId()]),
    sub("income", "Show daily and weekly income with available historical change", [companyId(), period()]),
    sub("profit", "Show reported profit and available cost breakdown", [companyId(), period()]),
    sub("stars", "Show current company rating and historical change", [companyId()]),
    sub("ads", "Show advertising budget fields available in saved company data", [companyId()]),
    sub("stock", "Show stock quantities and historical differences", [companyId(), period()]),
    sub("employees", "Show employee roster and summary", [companyId(), detail()]),
    sub("wages", "Show known employee wage totals and data coverage", [companyId()]),
    group("alerts", "Inspect recent alerts and notification settings", [
    sub("recent", "Show recent dashboard alerts for your account", [companyId(), integer("limit", "Number of alerts, maximum 10", false, { min_value: 1, max_value: 10 })]),
    sub("enable", "Enable private Discord alert DMs"),
    sub("disable", "Disable private Discord alert DMs without unlinking"),
    sub("configure", "Change alert severity and quiet-hours preferences", [
      str("minimum_severity", "Lowest severity delivered", false, { choices: [
        { name: "Info and above", value: "info" }, { name: "Warning and critical only", value: "warning" },
        { name: "Critical only", value: "critical" }
      ]}),
      { type: 5, name: "quiet_hours_enabled", description: "Enable or disable quiet hours", required: false },
      str("quiet_hours_start", "Quiet-hours start, 24-hour HH:MM", false, { min_length: 5, max_length: 5 }),
      str("quiet_hours_end", "Quiet-hours end, 24-hour HH:MM", false, { min_length: 5, max_length: 5 }),
      str("timezone", "IANA time zone, e.g. America/New_York", false, { max_length: 80 })
    ]),
    sub("status", "Show alert delivery and preference status"),
    sub("settings", "Show current severity and quiet-hours settings"),
    sub("acknowledge", "Acknowledge an active alert", [str("alert", "Pick an active alert to acknowledge", true, { min_length: 1, max_length: 80, autocomplete: true })]),
    sub("rules", "List your enabled and disabled dashboard alert rules")
  ]),
    sub("trends", "Summarize saved history by period and metric", [companyId(), period(), str("metric", "Metric to inspect", false, { choices: [
      { name: "Overview", value: "overview" }, { name: "Income", value: "income" },
      { name: "Stars", value: "stars" }, { name: "Stock", value: "stock" },
      { name: "Employees", value: "employees" }
    ]})]),
    group("rankings", "Browse global and faction company rankings", [
    sub("companies", "Browse cached global companies by type", [
      integer("company_type_id", "Torn company type ID", true, { min_value: 1 }),
      integer("page", "Result page, 10 companies per page", false, { min_value: 1, max_value: 100 }),
      str("sort", "Ranking sort order", false, { choices: [
        { name: "Weekly income", value: "weekly_income" }, { name: "Daily income", value: "daily_income" },
        { name: "Star rating", value: "stars" }
      ]})
    ]),
    sub("company", "Show your connected company's position and nearby competitors", [companyId()]),
    sub("compare", "Compare your connected company with same-type cached benchmarks", [companyId()]),
    sub("global", "Compatibility alias for your global company ranking"),
    sub("faction", "List faction company directors ranked by weekly income", [
      integer("page", "Result page, 10 companies per page", false, { min_value: 1, max_value: 100 }),
      str("sort", "Ranking sort order", false, { choices: [
        { name: "Weekly income", value: "weekly_income" }, { name: "Daily income", value: "daily_income" },
        { name: "Star rating", value: "stars" }
      ]})
    ])
  ])
  ]};
