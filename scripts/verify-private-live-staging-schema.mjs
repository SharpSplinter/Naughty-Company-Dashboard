import { spawnSync } from "node:child_process"

const command = [
  "d1", "execute", "naughty-company-api-staging",
  "--remote", "--config", "wrangler.staging.toml", "--json",
  "--command",
  "SELECT CASE WHEN COUNT(*) = 3 THEN 'PRIVATE_LIVE_SCHEMA_OK' ELSE 'PRIVATE_LIVE_SCHEMA_MISSING' END AS result FROM sqlite_master WHERE type = 'table' AND name IN ('member_private_live_keys', 'member_private_live_api_throttles', 'faction_member_private_live_snapshots')",
]

const result = spawnSync("npx", ["wrangler", ...command], {
  encoding: "utf8",
  env: process.env,
  timeout: 60_000,
})

if (result.error) throw result.error
if (result.status !== 0) {
  process.stderr.write(result.stderr || "")
  process.stdout.write(result.stdout || "")
  throw new Error("Could not query the isolated staging D1 schema.")
}
const output = (result.stdout || "") + (result.stderr || "")
if (!output.includes("PRIVATE_LIVE_SCHEMA_OK")) {
  process.stdout.write(output)
  throw new Error("Private-live migration 0023 tables are missing from naughty-company-api-staging.")
}
console.log("PASS private-live migration 0023 tables exist in naughty-company-api-staging.")
