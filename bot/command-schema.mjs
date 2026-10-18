// Canonical guild slash-command schema, shared by registration and contract tests.
const sub = (name, description, options = []) => ({ type: 1, name, description, ...(options.length ? { options } : {}) });
const str = (name, description, required = false, extras = {}) => ({ type: 3, name, description, required, ...extras });
const integer = (name, description, required = false, extras = {}) => ({ type: 4, name, description, required, ...extras });
const companyId = () => str("company_id", "Connected company ID; defaults to your most recently saved company", false, { min_length: 1, max_length: 20 });
const period = () => str("period", "Historical window", false, { choices: [
  { name: "7 days", value: "7" }, { name: "30 days", value: "30" },
  { name: "90 days", value: "90" }, { name: "365 days", value: "365" }, { name: "All history", value: "all" }
] });
const detail = () => str("detail", "Roster detail level", false, { choices: [
  { name: "Brief", value: "brief" }, { name: "Full", value: "full" }
] });

export const commands = [
  { name: "ping", description: "Check that Naughty Company Bot is responding" },
  { name: "help", description: "Show commands, privacy notes, and account-linking instructions" },
  { name: "link", description: "Get the private dashboard account-linking instructions" },
  { name: "link-code", description: "Redeem a one-time code generated in your dashboard" },
  { name: "status", description: "Check your private dashboard account-link status" },
  { name: "unlink", description: "Disconnect your dashboard account from this Discord account" },
  { name: "bot", description: "Bot operational status", options: [
    sub("status", "Check bot and dashboard API availability")
  ]},
  { name: "company", description: "Privately inspect your connected company data", options: [
    sub("list", "List companies connected to your dashboard"),
    sub("overview", "Show income, profit, stars, employees, stock, and freshness", [companyId()]),
    sub("income", "Show daily and weekly income with available historical change", [companyId(), period()]),
    sub("profit", "Show reported profit and available cost breakdown", [companyId(), period()]),
    sub("stars", "Show current company rating and historical change", [companyId()]),
    sub("ads", "Show advertising budget fields available in saved company data", [companyId()]),
    sub("stock", "Show stock quantities and historical differences", [companyId(), period()]),
    sub("employees", "Show employee roster and summary", [companyId(), detail()]),
    sub("wages", "Show known employee wage totals and data coverage", [companyId()]),
    sub("alerts", "Show recent dashboard alerts for your account", [companyId()]),
    sub("trends", "Summarize saved history by period and metric", [companyId(), period(), str("metric", "Metric to inspect", false, { choices: [
      { name: "Overview", value: "overview" }, { name: "Income", value: "income" },
      { name: "Stars", value: "stars" }, { name: "Stock", value: "stock" },
      { name: "Employees", value: "employees" }
    ]})])
  ]},
  { name: "rankings", description: "Browse the shared global and faction company rankings", options: [
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
  ]},
  { name: "alerts", description: "Configure and inspect private dashboard alerts", options: [
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
    sub("recent", "Show recent alert events", [integer("limit", "Number of alerts, maximum 10", false, { min_value: 1, max_value: 10 })]),
    sub("acknowledge", "Acknowledge one of your alerts", [str("event_id", "Alert event ID from /alerts recent", true, { min_length: 1, max_length: 80 })]),
    sub("rules", "List your enabled and disabled dashboard alert rules")
  ]}
];
