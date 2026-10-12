import { createHash, randomBytes } from "node:crypto";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const databaseId = "1e37f1a5-daa3-41fb-8c1b-7a9c6e3d0405";
const apiUrl = "https://naughty-company-api-staging.kboone801.workers.dev";
if (!accountId || !apiToken) throw new Error("Cloudflare staging credentials are missing.");

async function query(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(`Staging D1 query failed (HTTP ${response.status}): ${JSON.stringify(payload.errors ?? []).slice(0, 500)}`);
  }
  return payload;
}

const playerId = `staging-smoke-${randomBytes(6).toString("hex")}`;
const companyId = "424242";
const sessionToken = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
const now = new Date();
const nowIso = now.toISOString();
const expiry = Math.floor(now.getTime() / 1000) + 600;
const currentStock = [{ name: "Oil (Barrel)", id: 173, in_stock: 130, on_order: 7, cost: 5, price: 160 }];
const snapshots = [
  { day: "2026-10-09", stock: [{ name: "Oil (Barrel)", id: 173, in_stock: 80, on_order: 0, cost: 5, price: 160 }] },
  { day: "2026-10-10", stock: [{ name: "Oil (Barrel)", id: 173, in_stock: 110, on_order: 3, cost: 5, price: 160 }] },
];

try {
  await query("INSERT INTO players (player_id, player_name, created_at, updated_at) VALUES (?, ?, ?, ?)", [playerId, "Staging Stock Smoke Test", nowIso, nowIso]);
  await query("INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [tokenHash, playerId, expiry, nowIso]);
  await query("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [playerId, companyId, "Staging Stock Test Co", "Test", JSON.stringify({}), JSON.stringify([]), nowIso]);
  await query("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?)", [playerId, companyId, JSON.stringify(currentStock), nowIso]);
  for (const snapshot of snapshots) {
    await query("INSERT INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at, snapshot_kind) VALUES (?, ?, ?, ?, ?, ?, 'lock-in')", [playerId, companyId, snapshot.day, JSON.stringify({}), JSON.stringify(snapshot.stock), `${snapshot.day}T18:10:00.000Z`]);
  }

  const response = await fetch(`${apiUrl}/api/me/companies/${companyId}`, {
    headers: { Authorization: `Bearer ${sessionToken}`, Accept: "application/json" },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Staging company endpoint returned HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  if (!Array.isArray(payload.stockHistory) || payload.stockHistory.length !== 2) throw new Error("API did not return both saved stock snapshots.");
  if (payload.stockHistory[0].day !== "2026-10-09" || payload.stockHistory[1].day !== "2026-10-10") throw new Error("Stock history is not ordered oldest to newest.");
  if (!Array.isArray(payload.stock) || payload.stock[0]?.in_stock !== 130) throw new Error("Current stock was not returned as expected.");

  const currentSnapshotDay = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const prior = payload.stockHistory.filter((snapshot) => typeof snapshot.day === "string" && snapshot.day < currentSnapshotDay).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
  const priorQuantity = prior?.stock?.reduce((sum, item) => sum + Number(item.in_stock ?? item.quantity ?? item.amount ?? 0), 0);
  const currentQuantity = payload.stock.reduce((sum, item) => sum + Number(item.in_stock ?? item.quantity ?? item.amount ?? 0), 0);
  const delta = currentQuantity - priorQuantity;
  if (delta !== 20) throw new Error(`Expected stock delta +20, received ${delta}.`);
  console.log(JSON.stringify({ ok: true, apiStatus: response.status, snapshots: payload.stockHistory.length, priorStock: priorQuantity, currentStock: currentQuantity, stockDelta: delta, onOrder: payload.stock.reduce((sum, item) => sum + Number(item.on_order ?? 0), 0), stockCost: payload.stock.reduce((sum, item) => sum + Number(item.cost ?? 0), 0) }));
} finally {
  await query("DELETE FROM faction_director_snapshots WHERE player_id = ? AND company_id = ?", [playerId, companyId]).catch(() => {});
  await query("DELETE FROM company_financials WHERE player_id = ? AND company_id = ?", [playerId, companyId]).catch(() => {});
  await query("DELETE FROM companies WHERE player_id = ? AND company_id = ?", [playerId, companyId]).catch(() => {});
  await query("DELETE FROM sessions WHERE player_id = ?", [playerId]).catch(() => {});
  await query("DELETE FROM players WHERE player_id = ?", [playerId]).catch(() => {});
}
