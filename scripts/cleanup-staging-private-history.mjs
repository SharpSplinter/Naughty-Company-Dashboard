import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG = "wrangler.acceptance.toml";
const DATABASE = "naughtyfamily-acceptance-staging";
const ACCOUNT_ID = "6c03b978ed9a59adc3f61c715bdad45c";
const sql = [
  "PRAGMA foreign_keys = ON;",
  "DELETE FROM players WHERE (player_id = '999999001' AND player_name = 'Staging Private History Member') OR (player_id = '999999002' AND player_name = 'Staging Private History Other Member');",
].join("\n") + "\n";

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required for staging fixture cleanup.");
if (process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT_ID) throw new Error("Refusing cleanup outside the reviewed Cloudflare account.");
const config = readFileSync(CONFIG, "utf8");
if (!config.includes('name = "naughtyfamily-api-staging"') ||
    !config.includes('database_name = "naughtyfamily-acceptance-staging"') ||
    !config.includes('database_id = "02cca699-1232-495f-8a0a-de525058b92a"') ||
    config.includes("bbbe128a-c5cc-46ec-b8ef-93860183e795")) {
  throw new Error("Refusing cleanup because the config no longer matches the isolated acceptance D1.");
}

const tempDir = mkdtempSync(join(tmpdir(), "ncd-private-history-cleanup-"));
const sqlPath = join(tempDir, "cleanup-private-history.sql");
try {
  writeFileSync(sqlPath, sql, "utf8");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "wrangler", "d1", "execute", DATABASE, "--remote", "--config", CONFIG, "--file", sqlPath,
  ], { stdio: "inherit", env: process.env });
  console.log("PASS removed synthetic private-history users and their sessions, company rows, and history from isolated staging D1.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
