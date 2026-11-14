import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG = "wrangler.acceptance.toml";
const DATABASE = "naughtyfamily-acceptance-staging";
const DATABASE_ID = "02cca699-1232-495f-8a0a-de525058b92a";
const ACCOUNT_ID = "6c03b978ed9a59adc3f61c715bdad45c";
const COMPANY_ID = "999999003";
const COMPANY_TYPE = "Adult Novelties";
const MEMBERS = [
  { id: "999999001", name: "Staging Private History Member", companyName: "Staging Private History Company", adBudget: 50000, wages: 100000, orderQuantity: 5, unitCost: 250, stockBase: 10000, stockStep: 100, incomeBase: 13500000, incomeStep: 125000 },
  { id: "999999002", name: "Staging Private History Other Member", companyName: "Other Member Private History Company", adBudget: 120000, wages: 230000, orderQuantity: 7, unitCost: 450, stockBase: 20000, stockStep: 250, incomeBase: 987650000, incomeStep: 250000 },
];
const ADMIN = { id: "999999004", name: "Staging Private History Admin" };

function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function profileFor(member, dailyIncome) {
  return {
    profile: {
      id: Number(COMPANY_ID),
      name: member.companyName,
      type: { id: 1, name: COMPANY_TYPE },
      rating: member.id === MEMBERS[0].id ? 8.5 : 7.2,
      days_old: 365,
      director: { id: Number(member.id), name: member.name },
      employees: { hired: 1, capacity: 10 },
      income: { daily: dailyIncome, weekly: dailyIncome * 7 },
      profit: { daily: dailyIncome - member.adBudget - member.wages - member.orderQuantity * member.unitCost },
      advertising_budget: member.adBudget,
    },
  };
}
function employeesFor(member) {
  return {
    employees: [{
      id: Number(member.id) + 100,
      name: "Synthetic History Employee",
      position: { id: 1, name: "Human Resources" },
      days_in_company: 365,
      stats: { manual_labor: 250, intelligence: 250, endurance: 250 },
      wage: member.wages,
      effectiveness: { total: 100, working_stats: 100, inactivity: 100, addiction: 100 },
      status: { description: "Active" },
      last_action: { relative: "Recently" },
    }],
  };
}
function stockFor(member, index) {
  return [{
    name: "Synthetic History Stock",
    in_stock: member.stockBase + index * member.stockStep,
    on_order: member.orderQuantity,
    cost: member.unitCost,
  }];
}

assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN is required.");
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID, "Refusing to seed outside the reviewed Cloudflare account.");
assert.ok(process.env.GITHUB_ENV, "GITHUB_ENV is required so the ephemeral sessions reach the Playwright step.");
const config = readFileSync(CONFIG, "utf8");
assert.match(config, /name\s*=\s*"naughtyfamily-api-staging"/);
assert.match(config, /database_name\s*=\s*"naughtyfamily-acceptance-staging"/);
assert.ok(config.includes('database_id = "' + DATABASE_ID + '"'), "Refusing to seed a different D1 database.");
assert.ok(!config.includes("bbbe128a-c5cc-46ec-b8ef-93860183e795"), "Production D1 must not appear in the acceptance config.");

const now = new Date();
const nowIso = now.toISOString();
const expiresAt = Math.floor(now.getTime() / 1000) + 3600;
const tokens = MEMBERS.map(() => randomBytes(32).toString("hex"));
const adminToken = randomBytes(32).toString("hex");
const tokenHashes = tokens.map(sha256);
const adminTokenHash = sha256(adminToken);
const incomeSeries = MEMBERS.map(member => Array.from({ length: 7 }, (_, index) => member.incomeBase + index * member.incomeStep));

const statements = [
  "PRAGMA foreign_keys = ON;",
  // Only previously created fixture identities are removed. A colliding real member ID is never deleted.
  "DELETE FROM admin_audit_log WHERE actor_player_id IN (" + [MEMBERS[0].id, MEMBERS[1].id, ADMIN.id].map(sqlQuote).join(", ") + ");",
  "DELETE FROM players WHERE (player_id = " + sqlQuote(MEMBERS[0].id) + " AND player_name = " + sqlQuote(MEMBERS[0].name) + ") OR (player_id = " + sqlQuote(MEMBERS[1].id) + " AND player_name = " + sqlQuote(MEMBERS[1].name) + ") OR (player_id = " + sqlQuote(ADMIN.id) + " AND player_name = " + sqlQuote(ADMIN.name) + ");",
];
for (let index = 0; index < MEMBERS.length; index += 1) {
  const member = MEMBERS[index];
  statements.push(
    "INSERT INTO players (player_id, player_name, created_at, updated_at, faction_id, faction_verified_at) VALUES (" +
    [member.id, member.name, nowIso, nowIso, "8317", nowIso].map(sqlQuote).join(", ") + ");"
  );
  statements.push(
    "INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (" +
    [tokenHashes[index], member.id, expiresAt, nowIso].map(sqlQuote).join(", ") + ");"
  );

  let latestProfile = null;
  let latestEmployees = null;
  let latestFetchedAt = null;
  for (let pointIndex = 0; pointIndex < 7; pointIndex += 1) {
    // Seven consecutive reporting dates, ending yesterday, with the official 18:00 UTC boundary.
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7 + pointIndex, 18, 10, 0, 0));
    const fetchedAt = day.toISOString();
    const profile = profileFor(member, incomeSeries[index][pointIndex]);
    const employees = employeesFor(member);
    const stock = stockFor(member, pointIndex);
    const profileJson = JSON.stringify(profile);
    const employeesJson = JSON.stringify(employees);
    const stockJson = JSON.stringify(stock);
    latestProfile = profileJson;
    latestEmployees = employeesJson;
    latestFetchedAt = fetchedAt;

    statements.push(
      "INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (" +
      [member.id, COMPANY_ID, profileJson, employeesJson, fetchedAt].map(sqlQuote).join(", ") + ");"
    );
    statements.push(
      "INSERT INTO company_financial_snapshots (player_id, company_id, stock_json, fetched_at) VALUES (" +
      [member.id, COMPANY_ID, stockJson, fetchedAt].map(sqlQuote).join(", ") + ");"
    );
  }
  statements.push(
    "INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (" +
    [member.id, COMPANY_ID, member.companyName, COMPANY_TYPE, latestProfile, latestEmployees, latestFetchedAt].map(sqlQuote).join(", ") + ");"
  );
}

statements.push(
  "INSERT INTO players (player_id, player_name, created_at, updated_at, faction_id, faction_verified_at) VALUES (" +
  [ADMIN.id, ADMIN.name, nowIso, nowIso, "8317", nowIso].map(sqlQuote).join(", ") + ");"
);
statements.push(
  "INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (" +
  [adminTokenHash, ADMIN.id, expiresAt, nowIso].map(sqlQuote).join(", ") + ");"
);
statements.push(
  "INSERT INTO administrators (player_id, granted_by, granted_at) VALUES (" +
  [ADMIN.id, ADMIN.id, nowIso].map(sqlQuote).join(", ") + ");"
);

const tempDir = mkdtempSync(join(tmpdir(), "ncd-private-history-seed-"));
const sqlPath = join(tempDir, "seed-private-history.sql");
try {
  writeFileSync(sqlPath, statements.join("\n") + "\n", "utf8");
  console.log("::add-mask::" + tokens[0]);
  console.log("::add-mask::" + tokens[1]);
  console.log("::add-mask::" + adminToken);
  console.log("Seeding two synthetic non-admin members, one synthetic administrator and seven private reporting dates in the isolated acceptance D1.");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "wrangler", "d1", "execute", DATABASE, "--remote", "--config", CONFIG, "--file", sqlPath,
  ], { stdio: "inherit", env: process.env });

  const envValues = {
    STAGING_TEST_SESSION_TOKEN: tokens[0],
    STAGING_TEST_OTHER_SESSION_TOKEN: tokens[1],
    STAGING_TEST_ADMIN_SESSION_TOKEN: adminToken,
    STAGING_TEST_ADMIN_PLAYER_ID: ADMIN.id,
    STAGING_TEST_COMPANY_ID: COMPANY_ID,
    STAGING_TEST_PLAYER_ID: MEMBERS[0].id,
    STAGING_TEST_OTHER_PLAYER_ID: MEMBERS[1].id,
    STAGING_TEST_EXPECTED_INCOME_SERIES: JSON.stringify(incomeSeries[0]),
    STAGING_TEST_OTHER_INCOME_SERIES: JSON.stringify(incomeSeries[1]),
  };
  appendFileSync(process.env.GITHUB_ENV, Object.entries(envValues).map(([key, value]) => key + "=" + value).join("\n") + "\n");
  console.log("PASS seeded synthetic authenticated sessions, private company records, seven reporting dates, cost reconciliation inputs, and stock snapshots.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
