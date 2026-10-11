const enc = new TextEncoder();
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const privateReply = content => ({ type: 4, data: { content, flags: 64 } });
async function dashboardFetch(env, path, init = {}) {
  if (!env.DASHBOARD_API) throw new Error("dashboard_binding_missing");
  return env.DASHBOARD_API.fetch(new Request("https://naughty-company-api" + path, init));
}
const hexBytes = s => Uint8Array.from((s.match(/.{2}/g) || []), x => parseInt(x, 16));
async function signed(req, env) {
  const sig = req.headers.get("x-signature-ed25519"), ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig) || !/^\d+$/.test(ts) || Math.abs(Date.now()/1000 - Number(ts)) > 300) return false;
  try { return await crypto.subtle.verify("Ed25519", await crypto.subtle.importKey("raw", hexBytes(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]), hexBytes(sig), enc.encode(ts + await req.clone().text())); } catch { return false; }
}
async function key(env) { if (!/^[0-9a-f]{64}$/i.test(env.BOT_ENCRYPTION_KEY || "")) throw Error("configuration"); return crypto.subtle.importKey("raw", hexBytes(env.BOT_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(value, env) { const iv = crypto.getRandomValues(new Uint8Array(12)); const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(value))); return { cipher: [...bytes].map(x => x.toString(16).padStart(2,"0")).join(""), iv: [...iv].map(x => x.toString(16).padStart(2,"0")).join("") }; }
async function unseal(cipher, iv, env) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexBytes(iv) }, await key(env), hexBytes(cipher))); }

async function ensureBotSchema(env) {
  await env.BOT_DB.prepare("CREATE TABLE IF NOT EXISTS discord_alert_state (discord_user_id TEXT PRIMARY KEY, linked_at TEXT NOT NULL)").run();
  await env.BOT_DB.prepare("CREATE TABLE IF NOT EXISTS discord_alert_deliveries (discord_user_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(discord_user_id,event_id))").run();
}
async function storeBotLink(user, playerId, token, env) {
  const sealed = await seal(token, env), now = new Date().toISOString();
  await env.BOT_DB.prepare("INSERT INTO discord_links(discord_user_id,dashboard_player_id,encrypted_session_token,token_iv,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(discord_user_id) DO UPDATE SET dashboard_player_id=excluded.dashboard_player_id,encrypted_session_token=excluded.encrypted_session_token,token_iv=excluded.token_iv,updated_at=excluded.updated_at").bind(user, playerId, sealed.cipher, sealed.iv, now).run();
  await env.BOT_DB.prepare("INSERT INTO alert_preferences(discord_user_id) VALUES(?1) ON CONFLICT(discord_user_id) DO NOTHING").bind(user).run();
  await env.BOT_DB.prepare("INSERT INTO discord_alert_state(discord_user_id,linked_at) VALUES(?,?) ON CONFLICT(discord_user_id) DO UPDATE SET linked_at=excluded.linked_at").bind(user, now).run();
}
async function sendPrivateDiscordMessage(env, userId, content) {
  const headers = { authorization: "Bot " + env.DISCORD_TOKEN, "content-type": "application/json", "user-agent": "NaughtyCompanyDashboardBot/1.0" };
  const channelResponse = await fetch("https://discord.com/api/v10/users/@me/channels", { method: "POST", headers, body: JSON.stringify({ recipient_id: userId }) });
  if (!channelResponse.ok) return false;
  const channel = await channelResponse.json();
  if (!channel?.id) return false;
  const messageResponse = await fetch("https://discord.com/api/v10/channels/" + encodeURIComponent(channel.id) + "/messages", { method: "POST", headers, body: JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } }) });
  return messageResponse.ok;
}
async function pollPrivateAlerts(env) {
  if (!env.BOT_DB || !env.BOT_ENCRYPTION_KEY || !env.DISCORD_TOKEN || !env.DASHBOARD_API) return;
  await ensureBotSchema(env);
  const rows = await env.BOT_DB.prepare("SELECT discord_user_id AS discordUserId, encrypted_session_token AS cipher, token_iv AS iv FROM discord_links").all();
  for (const link of rows.results || []) {
    try {
      const token = await unseal(link.cipher, link.iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const linkResponse = await dashboardFetch(env, "/api/me/discord-link", { headers, signal: AbortSignal.timeout(8000) });
      if (!linkResponse.ok) continue;
      const linkStatus = await linkResponse.json();
      if (!linkStatus.linked || !linkStatus.alertsEnabled) continue;
      let state = await env.BOT_DB.prepare("SELECT linked_at AS linkedAt FROM discord_alert_state WHERE discord_user_id=?").bind(link.discordUserId).first();
      if (!state) {
        await env.BOT_DB.prepare("INSERT INTO discord_alert_state(discord_user_id,linked_at) VALUES(?,?)").bind(link.discordUserId, new Date().toISOString()).run();
        continue;
      }
      const response = await dashboardFetch(env, "/api/me/alerts?limit=50", { headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const data = await response.json(), events = Array.isArray(data.events) ? data.events : [];
      const pending = events.filter(event => typeof event.eventId === "string" && typeof event.createdAt === "string" && event.createdAt > state.linkedAt).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const event of pending) {
        const prior = await env.BOT_DB.prepare("SELECT status,attempts FROM discord_alert_deliveries WHERE discord_user_id=? AND event_id=?").bind(link.discordUserId, event.eventId).first();
        if (prior?.status === "delivered" || Number(prior?.attempts || 0) >= 3) continue;
        const severity = String(event.severity || "info").toUpperCase();
        const title = String(event.title || "Dashboard alert").slice(0, 150);
        const message = String(event.message || "").replace(/\s+/g, " ").slice(0, 900);
        const company = event.companyName ? String(event.companyName).slice(0, 100) : event.companyId ? "Company ID " + String(event.companyId) : "Your company";
        const content = "🔔 Naughty Company Dashboard alert\n[" + severity + "] " + title + "\n" + message + "\nCompany: " + company + "\n" + String(event.createdAt);
        let delivered = false;
        try { delivered = await sendPrivateDiscordMessage(env, link.discordUserId, content); } catch {}
        const attempts = Number(prior?.attempts || 0) + 1, status = delivered ? "delivered" : "failed";
        await env.BOT_DB.prepare("INSERT INTO discord_alert_deliveries(discord_user_id,event_id,status,attempts,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(discord_user_id,event_id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,updated_at=excluded.updated_at").bind(link.discordUserId, event.eventId, status, attempts, new Date().toISOString()).run();
      }
    } catch {}
  }
}

function snapshotAgeLabel(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "age unavailable";
  const hours = Math.max(0, Math.floor((Date.now() - timestamp) / 3600000));
  if (hours < 1) return "under 1 hour old";
  if (hours < 48) return hours + " hour(s) old";
  return Math.floor(hours / 24) + " day(s) old";
}
function requestedCompanyId(interaction) {
  const options = Array.isArray(interaction?.data?.options) ? interaction.data.options : [];
  const option = options.find(item => item && item.name === "company_id");
  return option && typeof option.value === "string" ? option.value : null;
}
async function replyFor(i, env) {
  const name = i.data?.name, user = i.member?.user?.id || i.user?.id;
  if (i.type === 1) return { type: 1 };
  if (i.type === 5 && i.data?.custom_id === "link_code_submit") {
    const findValue = (items) => { for (const item of items || []) { if (item?.custom_id === "link_code" && typeof item.value === "string") return item.value; const nested = findValue([...(Array.isArray(item?.components) ? item.components : []), ...(item?.component ? [item.component] : [])]); if (nested !== undefined) return nested; } return undefined; };
    const code = String(findValue(i.data.components || []) || "").trim().toLowerCase();
    if (!user) return privateReply("Unable to identify your Discord account.");
    if (!/^[a-f0-9]{48}$/.test(code)) return privateReply("Enter the 48-character code generated in your dashboard.");
    try {
      const response = await dashboardFetch(env, "/api/discord/link/redeem", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ code, discordUserId: user }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) { const result = await response.json().catch(() => ({})); return privateReply(String(result.error || "The dashboard link code is invalid or expired. Generate a new one and try again.")); }
      const result = await response.json();
      if (typeof result.token !== "string" || !result.playerId) return privateReply("Dashboard linking could not be completed. Generate a new code and try again.");
      await storeBotLink(user, String(result.playerId), result.token, env);
      return privateReply("Dashboard account linked securely. Your code can no longer be used. To receive private alert DMs, enable Discord alerts in the dashboard.");
    } catch { return privateReply("Dashboard linking is temporarily unavailable. Generate a new code and try again."); }
  }
  if (i.type === 5 && i.data?.custom_id === "link_submit") {
    const findInputValue = (items) => {
      for (const item of items || []) {
        if (item?.custom_id === "api_key" && typeof item.value === "string") return item.value;
        const nested = findInputValue([
          ...(Array.isArray(item?.components) ? item.components : []),
          ...(item?.component ? [item.component] : [])
        ]);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    const apiKey = findInputValue(i.data.components || [])?.trim();
    if (!apiKey || apiKey.length > 256) return privateReply("Enter a valid limited-access Torn API key and try again.");
    try {
      if (!env.DASHBOARD_API) return privateReply("Dashboard connection is not configured for staging. Please contact an administrator.");
      const response = await env.DASHBOARD_API.fetch(new Request("https://naughty-company-api/api/auth/sign-in", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ apiKey }) }));
      if (!response.ok) {
        const requestId = response.headers.get("cf-ray") || response.headers.get("x-request-id") || null;
        const contentType = response.headers.get("content-type") || null;
        const server = response.headers.get("server") || null;
        let responseUrl = null;
        try {
          const resolved = new URL(response.url);
          responseUrl = resolved.origin + resolved.pathname;
        } catch {}
        console.warn(JSON.stringify({
          event: "dashboard_sign_in_failed",
          endpoint: "/api/auth/sign-in",
          status: response.status,
          requestId,
          contentType,
          server,
          redirected: response.redirected,
          responseUrl
        }));
        const diagnostic = requestId ? ` Request ID: ${requestId}.` : "";
        return privateReply(`Dashboard sign-in failed (HTTP ${response.status}).${diagnostic} No credentials or response details are exposed. Share only the status and request ID for staging diagnosis.`);
      }
      const session = await response.json(); if (typeof session.token !== "string" || !session.player) return privateReply("Linking failed. Please try again later.");
      const playerId = String(session.player.id || session.player.player_id || "");
      if (!playerId) return privateReply("Linking failed because the dashboard did not return a player ID.");
      const registered = await dashboardFetch(env, "/api/me/discord-link", { method: "POST", headers: { authorization: "Bearer " + session.token, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ discordUserId: user }), signal: AbortSignal.timeout(8000) });
      if (!registered.ok && registered.status !== 404) return privateReply("The dashboard could not confirm this Discord link yet. Please try again later; no alert details were shared.");
      await storeBotLink(user, playerId, session.token, env);
      return privateReply("Dashboard account linked securely. Your Torn API key was not stored. Use /status to check your link. Enable Discord alerts in the dashboard to receive private alert DMs.");
    } catch { return privateReply("Linking is temporarily unavailable. Please try again later."); }
  }
  if (i.type !== 2) return privateReply("Unsupported interaction.");
  if (name === "ping") return privateReply("Pong! Naughty Company Bot is responding.");
  if (name === "help") return privateReply("**Naughty Company Bot**\n/link: link with a limited-access Torn API key\n/link-code: finish linking with a code from the dashboard\n/status: check your link\n/unlink: remove your link\n/company: list saved companies\n/overview: show income, profit, stars, employees and stock\n/employees: view your latest company roster\n/trends: summarize the latest 30-day company trend\n/rankings: view the top global companies by weekly income\n/alerts: view recent dashboard alerts\n/ping: test bot response\n\nReplies are private. Enter your key only in the /link form.");
  if (!user) return privateReply("Unable to identify your Discord account.");
  if (name === "link") return { type: 9, data: { custom_id: "link_submit", title: "Link dashboard account", components: [{ type: 18, label: "Limited-access Torn API key", component: { type: 4, custom_id: "api_key", style: 1, min_length: 8, max_length: 256, required: true, placeholder: "Paste your limited-access API key here" } }] } };
  if (name === "link-code") return { type: 9, data: { custom_id: "link_code_submit", title: "Link from dashboard", components: [{ type: 18, label: "Dashboard link code", component: { type: 4, custom_id: "link_code", style: 1, min_length: 48, max_length: 48, required: true, placeholder: "Paste the one-time dashboard code" } }] } };
  if (name === "status") { const row = await env.BOT_DB.prepare("SELECT dashboard_player_id,updated_at FROM discord_links WHERE discord_user_id=?1").bind(user).first(); return privateReply(row ? "Your dashboard account is linked. Player ID: " + row.dashboard_player_id + ". Last linked: " + row.updated_at + "." : "No dashboard account is linked. Run /link to connect one."); }
  if (name === "unlink") {
    const linked = await env.BOT_DB.prepare("SELECT encrypted_session_token AS cipher,token_iv AS iv FROM discord_links WHERE discord_user_id=?").bind(user).first();
    if (linked) { try { const token = await unseal(linked.cipher, linked.iv, env); await dashboardFetch(env, "/api/me/discord-link", { method: "DELETE", headers: { authorization: "Bearer " + token } }); } catch {} }
    await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run();
    await env.BOT_DB.prepare("DELETE FROM discord_alert_state WHERE discord_user_id=?").bind(user).run();
    await env.BOT_DB.prepare("DELETE FROM discord_alert_deliveries WHERE discord_user_id=?").bind(user).run();
    return privateReply("Your dashboard link and private alert delivery link have been removed.");
  }
  if (name === "company") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token,token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first(); if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env), res = await dashboardFetch(env, "/api/me/companies", { headers: { authorization: "Bearer " + token, accept: "application/json" } });
      if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!res.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
      const data = await res.json(), companies = Array.isArray(data.companies) ? data.companies : [];
      if (!companies.length) return privateReply("No saved company data is available yet. Open the dashboard and refresh company data.");
      return privateReply("**Your saved companies**\n" + companies.slice(0,8).map(c => "- **" + String(c.company_name || "Company").slice(0,100) + "** (" + String(c.company_type || "type unknown").slice(0,40) + ")  |  ID " + String(c.company_id || "n/a")).join("\n"));
    } catch { return privateReply("Company data is temporarily unavailable. Please try again later."); }
  }
  if (name === "overview") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const companiesRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
      if (companiesRes.status === 401 || companiesRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!companiesRes.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
      const companiesData = await companiesRes.json();
      const companies = Array.isArray(companiesData.companies) ? companiesData.companies : [];
      if (!companies.length) return privateReply("No saved companies are available yet. Open the dashboard and refresh company data.");
      const selectedCompanyId = requestedCompanyId(i);
      const company = selectedCompanyId ? companies.find(item => String(item.company_id) === selectedCompanyId) : companies[0];
      if (!company) return privateReply("That company ID is not in your saved company list. Run /company and copy one of the listed IDs.");
      const detailRes = await dashboardFetch(env, "/api/me/companies/" + encodeURIComponent(company.company_id), { headers, signal: AbortSignal.timeout(8000) });
      if (detailRes.status === 401 || detailRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (detailRes.status === 404) return privateReply("No saved snapshot exists for " + String(company.company_name || "this company") + " yet. Refresh it in the dashboard first.");
      if (!detailRes.ok) return privateReply("Company overview is temporarily unavailable. Please try again later.");
      const data = await detailRes.json();
      const profile = data.profile && typeof data.profile === "object" ? data.profile : {};
      const root = profile.company && typeof profile.company === "object" ? profile.company : profile.profile && typeof profile.profile === "object" ? profile.profile : profile;
      const income = root.income && typeof root.income === "object" ? root.income : {};
      const money = value => typeof value === "number" && Number.isFinite(value) ? "$" + Math.round(value).toLocaleString("en-US") : "Not available";
      const numeric = (...values) => values.find(value => typeof value === "number" && Number.isFinite(value));
      const findNumber = (obj, keys, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 5) return null;
        for (const key of keys) if (typeof obj[key] === "number" && Number.isFinite(obj[key])) return obj[key];
        for (const value of Object.values(obj)) { const found = findNumber(value, keys, depth + 1); if (found !== null) return found; }
        return null;
      };
      const rating = numeric(root.company_rating, root.star_rating, root.rating, root.stars);
      const employeeRoot = data.employees && typeof data.employees === "object" ? data.employees : {};
      const employeeList = Array.isArray(data.employees) ? data.employees : Array.isArray(employeeRoot.employees) ? employeeRoot.employees : Array.isArray(employeeRoot.company_employees) ? employeeRoot.company_employees : [];
      const totalWages = employeeList.reduce((sum, employee) => {
        const wage = numeric(employee.wage, employee.salary, employee.wages);
        return sum + (wage == null ? 0 : wage);
      }, 0);
      const hasWages = employeeList.length > 0 && employeeList.some(employee => numeric(employee.wage, employee.salary, employee.wages) != null);
      const adBudget = findNumber(root, ["advertisement_budget", "advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"]);
      const stockRoot = Array.isArray(data.stock) ? data.stock : data.stock && Array.isArray(data.stock.stock) ? data.stock.stock : data.stock && typeof data.stock === "object" ? Object.values(data.stock).filter(value => value && typeof value === "object") : [];
      const stockQuantity = stockRoot.reduce((sum, item) => sum + (numeric(item.in_stock, item.quantity, item.amount) || 0), 0);
      const stockValue = stockRoot.reduce((sum, item) => {
        const quantity = numeric(item.in_stock, item.quantity, item.amount);
        const price = numeric(item.price, item.sell_price, item.selling_price, item.price_per_unit, item.cost, item.unit_cost, item.cost_per_unit);
        return sum + (quantity != null && price != null ? quantity * price : 0);
      }, 0);
      const pricedStockCount = stockRoot.filter(item => numeric(item.in_stock, item.quantity, item.amount) != null && numeric(item.price, item.sell_price, item.selling_price, item.price_per_unit, item.cost, item.unit_cost, item.cost_per_unit) != null).length;
      const performance = root.company_performance && typeof root.company_performance === "object" ? root.company_performance : root.performance && typeof root.performance === "object" ? root.performance : root;
      const popularity = findNumber(performance, ["popularity", "company_popularity"]);
      const efficiency = findNumber(performance, ["efficiency", "company_efficiency"]);
      const environment = findNumber(performance, ["environment", "company_environment"]);
      const safeName = String(data.companyName || company.company_name || "Your company").replace(/@/g, "@\u200b").slice(0, 90);
      const dailyIncome = numeric(income.daily);
      const weeklyIncome = numeric(income.weekly);
      const dailyExpensesKnown = adBudget != null && hasWages && pricedStockCount === stockRoot.length && stockRoot.length > 0;
      const dailyExpenses = (adBudget || 0) + (hasWages ? totalWages : 0) + stockValue;
      const dailyProfit = dailyExpensesKnown && dailyIncome != null ? dailyIncome - dailyExpenses : null;
      const weeklyProfit = dailyExpensesKnown && weeklyIncome != null ? weeklyIncome - (dailyExpenses * 7) : null;
      const lines = [
        "**Company overview | " + safeName + "**",
        "Type: " + String(data.companyType || company.company_type || "Not available").slice(0, 60),
        "Daily income: " + money(dailyIncome),
        "Weekly income: " + money(weeklyIncome),
        "Daily profit (income − ad budget − wages − stock costs): " + money(dailyProfit),
        "Weekly profit (weekly income − 7× daily expenses): " + money(weeklyProfit),
        "Advertisement budget: " + money(adBudget),
        "Total employee wages: " + (hasWages ? money(totalWages) : "Not available"),
        "Company Performance | Popularity: " + (popularity == null ? "Not available" : String(popularity)) + " · Efficiency: " + (efficiency == null ? "Not available" : String(efficiency)) + " · Environment: " + (environment == null ? "Not available" : String(environment)),
        "Star rating: " + (rating == null ? "Not available" : String(rating)),
        "Employees in latest payload: " + (employeeList.length || "Not reported"),
        "Stock items: " + (stockRoot.length || "Not reported"),
        "Stock quantity: " + (stockRoot.length ? stockQuantity.toLocaleString("en-US") : "Not available"),
        "Stock change vs previous day: Not available (no saved daily stock baseline)",
        "Stock unit price: " + (stockRoot.length === 1 ? money(numeric(stockRoot[0].price, stockRoot[0].sell_price, stockRoot[0].selling_price, stockRoot[0].price_per_unit, stockRoot[0].cost, stockRoot[0].unit_cost, stockRoot[0].cost_per_unit)) : "See item-level stock data in dashboard"),
        "Stock total value: " + (stockRoot.length && pricedStockCount === stockRoot.length ? money(stockValue) : "Not available (stock price data incomplete)"),
        "Snapshot updated: " + String(data.fetchedAt || company.fetched_at || "Not available"),
        "Snapshot age: " + snapshotAgeLabel(data.fetchedAt || company.fetched_at)
      ];
      const snapshotMs = Date.parse(data.fetchedAt || company.fetched_at || "");
      if (Number.isFinite(snapshotMs) && Date.now() - snapshotMs > 36 * 3600000) lines.push("⚠️ This company snapshot may be stale. Refresh it in the dashboard.");
      return privateReply(lines.join("\n"));
    } catch { return privateReply("Company overview is temporarily unavailable. Please try again later."); }
  }
  if (name === "employees") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const companiesRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
      if (companiesRes.status === 401 || companiesRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!companiesRes.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
      const companiesData = await companiesRes.json(), companies = Array.isArray(companiesData.companies) ? companiesData.companies : [];
      const selectedCompanyId = requestedCompanyId(i);
      const company = selectedCompanyId ? companies.find(item => String(item.company_id) === selectedCompanyId) : companies[0];
      if (!company) return privateReply(selectedCompanyId ? "That company ID is not in your saved company list. Run /company and copy one of the listed IDs." : "No saved company data is available yet. Refresh company data in the dashboard first.");
      const res = await dashboardFetch(env, "/api/me/member-insights?companyId=" + encodeURIComponent(company.company_id), { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!res.ok) return privateReply("Employee data is temporarily unavailable. Please try again later.");
      const data = await res.json(), roster = Array.isArray(data.roster) ? data.roster : [];
      const summary = data.summary && typeof data.summary === "object" ? data.summary : {};
      if (!roster.length) return privateReply(String(data.message || "No employee roster is available yet."));
      const lines = roster.map((e, n) => {
        const label = String(e.name || e.employeeName || e.employee_name || ("Employee " + (n + 1))).slice(0, 70);
        const position = String(e.positionName || e.position_name || e.position?.name || e.position || "Position not reported").slice(0, 60);
        const wage = e.wage ?? e.salary ?? e.wages;
        return "- **" + label + "**  |  " + position + (wage == null ? "" : "  |  Wage: $" + Number(wage).toLocaleString("en-US"));
      });
      const companyLabel = String(company.name || company.company_name || company.company_id).slice(0, 80);
      const chunks = [];
      let current = "**Employee roster: " + companyLabel + "**\n";
      for (const line of lines) {
        if ((current + line + "\n").length > 1750 && current.trim()) {
          chunks.push(current.trimEnd());
          current = "**Employee roster: " + companyLabel + " (continued)**\n";
        }
        current += line + "\n";
      }
      if (summary.employeeCount == null) current = current.trimEnd();
      else current += "\nEmployees: " + summary.employeeCount;
      if (current.trim()) chunks.push(current.trimEnd());
      const response = privateReply(chunks[0] || "No employee roster is available yet.");
      if (chunks.length > 1) response.followups = chunks.slice(1);
      return response;
    } catch { return privateReply("Employee data is temporarily unavailable. Please try again later."); }
  }
  if (name === "trends") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const companiesRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
      if (companiesRes.status === 401 || companiesRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!companiesRes.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
      const companiesData = await companiesRes.json(), companies = Array.isArray(companiesData.companies) ? companiesData.companies : [];
      const selectedCompanyId = requestedCompanyId(i);
      const company = selectedCompanyId ? companies.find(item => String(item.company_id) === selectedCompanyId) : companies[0];
      if (!company) return privateReply(selectedCompanyId ? "That company ID is not in your saved company list. Run /company and copy one of the listed IDs." : "No saved company data is available yet. Refresh company data in the dashboard first.");
      const historyRes = await dashboardFetch(env, "/api/me/companies/" + encodeURIComponent(company.company_id) + "/history?days=30", { headers, signal: AbortSignal.timeout(8000) });
      if (historyRes.status === 401 || historyRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!historyRes.ok) return privateReply("Trend data is temporarily unavailable. Please try again later.");
      const data = await historyRes.json(), s = data.summary || {}, history = Array.isArray(data.history) ? data.history : [], latest = history.slice(-1)[0] || {}, first = history[0] || {};
      const firstMs = Date.parse(first.fetchedAt || ""), latestMs = Date.parse(latest.fetchedAt || "");
      const coverageDays = Number.isFinite(firstMs) && Number.isFinite(latestMs) ? Math.max(0, (latestMs - firstMs) / 86400000) : 0;
      const coverageNote = history.length < 7 || coverageDays < 20 ? "Coverage note: Limited history; these snapshots may not represent the full 30 days." : "Coverage: " + String(first.fetchedAt || "earliest snapshot unavailable") + " to " + String(latest.fetchedAt || "latest snapshot unavailable");
      const money = v => typeof v === "number" && Number.isFinite(v) ? "$" + Math.round(v).toLocaleString("en-US") : "Not available";
      const change = v => typeof v === "number" && Number.isFinite(v) ? (v > 0 ? "+" : "") + money(v) : "Not available";
      return privateReply("**30-day trend  |  " + String(company.company_name || "Your company").slice(0, 90) + "**\nSnapshots: " + Number(s.snapshotCount || 0) + "\nDaily income change: " + change(s.dailyIncomeChange) + (s.dailyIncomeChangePercent == null ? "" : " (" + Number(s.dailyIncomeChangePercent).toFixed(1) + "%)") + "\nWeekly income change: " + change(s.weeklyIncomeChange) + "\nLatest employee count: " + (latest.employeeCount == null ? "Not available" : latest.employeeCount) + "\nLatest snapshot: " + String(latest.fetchedAt || s.latestSnapshotAt || "Not available"));
    } catch { return privateReply("Trend data is temporarily unavailable. Please try again later."); }
  }
  if (name === "rankings") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const res = await dashboardFetch(env, "/api/rankings?scope=global", { headers: { authorization: "Bearer " + token, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!res.ok) return privateReply("Company rankings are temporarily unavailable. Please try again later.");
      const data = await res.json();
      const companies = Array.isArray(data.companies) ? data.companies : [];
      if (!companies.length) return privateReply("No global company ranking snapshot is available yet. Try again after the dashboard ranking cache refreshes.");
      const money = value => typeof value === "number" && Number.isFinite(value) ? "$" + Math.round(value).toLocaleString("en-US") : "Not available";
      const lines = companies.slice(0, 5).map((company, index) => {
        const name = String(company.companyName || "Company").replace(/@/g, "@\u200b").slice(0, 75);
        const type = String(company.companyType || "Unknown type").slice(0, 40);
        const rating = typeof company.starRating === "number" && Number.isFinite(company.starRating) ? String(company.starRating) + " stars" : "rating n/a";
        return (index + 1) + ". **" + name + "** (" + type + ")\n   Weekly income: " + money(company.weeklyIncome) + " | " + rating;
      });
      const generatedAt = data.generatedAt || "";
      const rankingAge = snapshotAgeLabel(generatedAt);
      const rankingMs = Date.parse(generatedAt);
      const freshnessNote = Number.isFinite(rankingMs) && Date.now() - rankingMs > 36 * 3600000 ? "\n⚠️ Ranking snapshot may be stale; compare its timestamp before relying on it." : "";
      return privateReply("**Global company rankings**\nTop 5 by weekly income\n" + lines.join("\n") + "\nSnapshot: " + String(generatedAt || "timestamp unavailable") + "\nSnapshot age: " + rankingAge + "\nCompany income source updates daily at 18:10 UTC; this ranking timestamp is shown separately." + freshnessNote);
    } catch { return privateReply("Company rankings are temporarily unavailable. Please try again later."); }
  }
  if (name === "alerts") {
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const res = await dashboardFetch(env, "/api/me/alerts?limit=10", { headers: { authorization: "Bearer " + token, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!res.ok) return privateReply("Alerts are temporarily unavailable. Please try again later.");
      const data = await res.json(), events = Array.isArray(data.events) ? data.events : [];
      if (!events.length) return privateReply("No dashboard alerts were found. Unread alerts: " + Number(data.unreadCount || 0) + ".");
      const lines = events.slice(0, 6).map(e => {
        const severity = String(e.severity || "info").toUpperCase();
        const title = String(e.title || e.ruleType || "Dashboard alert").slice(0, 100);
        const message = String(e.message || "").replace(/\s+/g, " ").slice(0, 180);
        return "- **[" + severity + "] " + title + "**" + (message ? "\n  " + message : "") + (e.createdAt ? "\n  " + String(e.createdAt) : "");
      });
      return privateReply("**Recent dashboard alerts**  |  " + Number(data.unreadCount || 0) + " unread\n" + lines.join("\n"));
    } catch { return privateReply("Alerts are temporarily unavailable. Please try again later."); }
  }
  return privateReply("That command isn't enabled yet. Use /help to see available commands.");
}
export default {
  async scheduled(_controller, env, ctx) { ctx.waitUntil(pollPrivateAlerts(env)); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "naughty-company-bot-staging", database: !!env.BOT_DB, encryption: !!env.BOT_ENCRYPTION_KEY, discordConfigured: !!env.DISCORD_TOKEN, dashboardBinding: !!env.DASHBOARD_API, privateAlertDelivery: true });
    if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);
    if (!await signed(req, env)) return json({ ok: false, error: "invalid_request_signature" }, 401);
    let interaction; try { interaction = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    try {
      await ensureBotSchema(env);
      const reply = await replyFor(interaction, env);
      const followups = Array.isArray(reply.followups) ? reply.followups : [];
      delete reply.followups;
      if (followups.length && interaction.application_id && interaction.token && ctx?.waitUntil) {
        ctx.waitUntil((async () => {
          await new Promise(resolve => setTimeout(resolve, 800));
          const endpoint = "https://discord.com/api/v10/webhooks/" + encodeURIComponent(interaction.application_id) + "/" + encodeURIComponent(interaction.token);
          for (const content of followups) {
            try {
              const sent = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, flags: 64, allowed_mentions: { parse: [] } }) });
              if (!sent.ok) break;
            } catch { break; }
          }
        })());
      }
      return json(reply);
    } catch { return json({ type: 4, data: { content: "The request could not be completed. Please try again later.", flags: 64 } }); }
  }
};
