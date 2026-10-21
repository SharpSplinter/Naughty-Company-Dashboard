import { sub } from "../command-options.mjs";

export const dashboardCommand = { name: "dashboard", description: "Inspect dashboard health and cross-company snapshot coverage", options: [
    sub("health", "Show dashboard API, database, and company freshness"),
    sub("summary", "Summarize saved coverage, stale companies, and recent alerts"),
    sub("panel", "Open a private interactive dashboard with read-only navigation")
  ]};
