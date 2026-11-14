import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG = "wrangler.acceptance.toml";
const DATABASE = "naughtyfamily-acceptance-staging";
const DATABASE_ID = "02cca699-1232-495f-8a0a-de525058b92a";
const ACCOUNT_ID = "6c03b978ed9a59adc3f61c715bdad45c";
const ADMIN_ID = "999999004";
const ADMIN_NAME = "Staging Private History Admin";
const FACTION_ID = "8317";

assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN is required for the staging fixture freshness refresh.");
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID, "Refusing to refresh fixtures outside the reviewed Cloudflare account.");

const config = readFileSync(CONFIG, "utf8");
assert.ok(config.includes('name = "naughtyfamily-api-staging"'), "Refusing to refresh a non-staging Worker.");
assert.ok(config.includes('database_name = "' + DATABASE + '"'), "Refusing to refresh a different D1 database.");
assert.ok(config.includes('database_id = "' + DATABASE_ID + '"'), "Refusing to refresh an unexpected staging D1 UUID.");
assert.ok(!config.includes("bbbe128a-c5cc-46ec-b8ef-93860183e795"), "Production D1 must never be used for staging fixture refresh.");

const nowIso = new Date().toISOString();
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const sql = [
  "UPDATE players",
  "SET faction_verified_at = " + quote(nowIso) + ", membership_check_attempted_at = " + quote(nowIso) + ", membership_check_status = NULL",
  "WHERE player_id = " + quote(ADMIN_ID) + " AND player_name = " + quote(ADMIN_NAME) + " AND faction_id = " + quote(FACTION_ID) + ";",
  "SELECT CASE WHEN changes() = 1 THEN 1 ELSE 0 END AS fixture_refresh_ok;",
].join("\n") + "\n";

const tempDir = mkdtempSync(join(tmpdir(), "ncd-staging-load-freshness-"));
const sqlPath = join(tempDir, "refresh-membership-freshness.sql");
try {
  writeFileSync(sqlPath, sql, "utf8");
  const output = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "wrangler", "d1", "execute", DATABASE, "--remote", "--config", CONFIG, "--file", sqlPath,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
  assert.match(output, /fixture_refresh_ok["\\s]*:\\s*1/, "Expected exactly one synthetic staging administrator fixture to be refreshed.");
  console.log("PASS refreshed membership freshness for the exact synthetic staging admin fixture before load testing.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
