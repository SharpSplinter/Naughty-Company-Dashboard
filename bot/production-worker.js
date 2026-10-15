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
      const prefsResponse = await dashboardFetch(env, "/api/me/automation-preferences", { headers, signal: AbortSignal.timeout(8000) });
      if (!prefsResponse.ok) continue;
      const prefsPayload = await prefsResponse.json();
      const preferences = prefsPayload && typeof prefsPayload.preferences === "object" ? prefsPayload.preferences : {};
      if (isDuringQuietHours(preferences)) continue;
      const minimumSeverity = severityRank(preferences.minimumSeverity || "info");
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
        if (prior?.status === "delivered" || prior?.status === "filtered" || Number(prior?.attempts || 0) >= 3) continue;
        if (severityRank(event.severity) < minimumSeverity) {
          await env.BOT_DB.prepare("INSERT INTO discord_alert_deliveries(discord_user_id,event_id,status,attempts,updated_at) VALUES(?,?,'filtered',0,?) ON CONFLICT(discord_user_id,event_id) DO UPDATE SET status='filtered',updated_at=excluded.updated_at").bind(link.discordUserId, event.eventId, new Date().toISOString()).run();
          continue;
        }
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
function commandOptions(interaction) {
  const top = Array.isArray(interaction?.data?.options) ? interaction.data.options : [];
  const subcommand = top.find(item => item && (item.type === 1 || Array.isArray(item.options)));
  return { subcommand: subcommand?.name || null, options: subcommand ? (Array.isArray(subcommand.options) ? subcommand.options : []) : top };
}
function optionValue(interaction, name) {
  const options = commandOptions(interaction).options;
  const option = options.find(item => item && item.name === name);
  return option && Object.prototype.hasOwnProperty.call(option, "value") ? option.value : undefined;
}
function requestedCompanyId(interaction) {
  const value = optionValue(interaction, "company_id");
  return value === undefined || value === null || String(value).trim() === "" ? null : String(value);
}
function safeText(value, max = 90) {
  return String(value ?? "").replace(/@/g, "@" + String.fromCharCode(8203)).replace(/\s+/g, " ").slice(0, max);
}
function money(value) {
  return typeof value === "number" && Number.isFinite(value) ? "$" + Math.round(value).toLocaleString("en-US") : "Not available";
}
function numberLabel(value) {
  return typeof value === "number" && Number.isFinite(value) ? (value > 0 ? "+" : "") + value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "Not reported";
}
function chunkedPrivateReply(title, lines, maxLength = 1750) {
  const chunks = [];
  let current = title + "\n";
  for (const item of lines) {
    const line = String(item).slice(0, 1600);
    if (current.length + line.length + 1 > maxLength && current.trim() !== title) {
      chunks.push(current.trimEnd());
      current = title + " (continued)\n";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trimEnd());
  const reply = privateReply(chunks[0] || title);
  if (chunks.length > 1) reply.followups = chunks.slice(1);
  return reply;
}

function severityRank(value) {
  const severity = String(value || "info").toLowerCase();
  if (["critical", "high", "error", "fatal"].includes(severity)) return 3;
  if (["warning", "medium", "warn"].includes(severity)) return 2;
  return 1;
}
function isDuringQuietHours(preferences) {
  if (!(preferences?.quietHoursEnabled === true || Number(preferences?.quietHoursEnabled) === 1)) return false;
  const timezone = typeof preferences.timezone === "string" && preferences.timezone ? preferences.timezone : "UTC";
  const startText = typeof preferences.quietHoursStart === "string" ? preferences.quietHoursStart : "22:00";
  const endText = typeof preferences.quietHoursEnd === "string" ? preferences.quietHoursEnd : "08:00";
  const minutes = value => {
    const match = String(value).match(/^(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = minutes(startText), end = minutes(endText);
  if (start === null || end === null || start === end) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":");
    const now = Number(parts[0]) * 60 + Number(parts[1]);
    return start < end ? now >= start && now < end : now >= start || now < end;
  } catch { return false; }
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
      if (!env.DASHBOARD_API) return privateReply("Dashboard connection is not configured for production. Please contact an administrator.");
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
        return privateReply(`Dashboard sign-in failed (HTTP ${response.status}).${diagnostic} No credentials or response details are exposed. Share only the status and request ID for production diagnosis.`);
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
  if (name === "help") return privateReply("**Naughty Company Bot**\n/link: link with a limited-access Torn API key\n/link-code: finish linking with a code from the dashboard\n/status: check your link\n/unlink: remove your link\n/company: list saved companies\n/overview: show income, profit, stars, employees and stock\n/employees brief|full: view employee roster details\n/trends: summarize the latest 30-day company trend\n/rankings global|faction: company rankings and star-income comparisons\n/alerts enable|disable|configure|status: control private alerts\n/ping: test bot response\n\nReplies are private. Enter your key only in the /link form.");
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
      const profit = root.profit && typeof root.profit === "object" ? root.profit : {};
      const money = value => typeof value === "number" && Number.isFinite(value) ? "$" + Math.round(value).toLocaleString("en-US") : "Not available";
      const dailyProfit = [profit.daily, root.daily_profit, root.dailyProfit, root.profit_daily].find(value => typeof value === "number" && Number.isFinite(value));
      const rating = [root.company_rating, root.star_rating, root.rating, root.stars].find(value => typeof value === "number" && Number.isFinite(value));
      const employeeRoot = data.employees && typeof data.employees === "object" ? data.employees : {};
      const employeeList = Array.isArray(data.employees) ? data.employees : Array.isArray(employeeRoot.employees) ? employeeRoot.employees : Array.isArray(employeeRoot.company_employees) ? employeeRoot.company_employees : [];
      const stockRoot = Array.isArray(data.stock) ? data.stock : data.stock && Array.isArray(data.stock.stock) ? data.stock.stock : data.stock && typeof data.stock === "object" ? Object.values(data.stock).filter(value => value && typeof value === "object") : [];
      const stockQuantity = stockRoot.reduce((sum, item) => { const value = [item.in_stock, item.quantity, item.amount].find(n => typeof n === "number" && Number.isFinite(n)); return sum + (value || 0); }, 0);
      const safeName = String(data.companyName || company.company_name || "Your company").replace(/@/g, "@\u200b").slice(0, 90);
      const lines = [
        "**Company overview | " + safeName + "**",
        "Type: " + String(data.companyType || company.company_type || "Not available").slice(0, 60),
        "Daily income: " + money(income.daily),
        "Weekly income: " + money(income.weekly),
        "Daily profit: " + money(dailyProfit),
        "Star rating: " + (rating == null ? "Not available" : String(rating)),
        "Employees in latest payload: " + (employeeList.length || "Not reported"),
        "Stock items: " + (stockRoot.length || "Not reported") + " | Total quantity: " + (stockRoot.length ? stockQuantity.toLocaleString("en-US") : "Not available"),
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
      const full = commandOptions(i).subcommand === "full";
      const lines = roster.map((e, n) => {
        const label = safeText(e.name || e.employeeName || e.employee_name || ("Employee " + (n + 1)), 70) || ("Employee " + (n + 1));
        const position = safeText(e.positionName || e.position_name || e.position?.name || e.position || "Position not reported", 60);
        const wage = e.wage ?? e.salary ?? e.wages;
        const base = "- **" + label + "**  |  " + position + (wage == null ? "" : "  |  Wage: " + money(Number(wage)));
        if (!full) return base;
        const status = safeText(e.status || "Not reported", 60) || "Not reported";
        const lastSeen = safeText(e.lastAction || e.lastSeenOnline || e.last_seen_online || "Not reported", 60) || "Not reported";
        return base + "\n  Addiction effectiveness: " + numberLabel(e.addictionEffectiveness) +
          "  |  Inactivity effectiveness: " + numberLabel(e.inactivityEffectiveness) +
          "\n  Status: " + status + "  |  Last seen / online: " + lastSeen;
      });
      const companyLabel = safeText(company.company_name || company.name || company.company_id, 80);
      const title = "**" + (full ? "Full employee roster: " : "Employee roster: ") + companyLabel + "**";
      if (summary.employeeCount != null) lines.push("\nEmployees in snapshot: " + summary.employeeCount);
      return chunkedPrivateReply(title, lines);
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
    const subcommand = commandOptions(i).subcommand;
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      if (subcommand === "faction") {
        const res = await dashboardFetch(env, "/api/faction/directors", { headers, signal: AbortSignal.timeout(12000) });
        if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
        if (!res.ok) return privateReply("Faction director data is temporarily unavailable. Please try again later.");
        const data = await res.json();
        const directors = (Array.isArray(data.directors) ? data.directors : []).slice().sort((a,b) => {
          const av = typeof a.weeklyIncome === "number" ? a.weeklyIncome : -Infinity;
          const bv = typeof b.weeklyIncome === "number" ? b.weeklyIncome : -Infinity;
          return bv - av;
        });
        if (!directors.length) return privateReply("No faction director companies are in the cached directory yet. Refresh the faction directory in the dashboard first.");
        const lines = directors.map((company, index) => {
          const name = safeText(company.companyName || ("Company #" + (company.companyId || "unknown")), 80);
          const type = safeText(company.companyType || "Type not reported", 45);
          const director = safeText(company.directorName || ("Player #" + (company.playerId || "unknown")), 60);
          const weekly = typeof company.weeklyIncome === "number" && Number.isFinite(company.weeklyIncome) ? company.weeklyIncome : null;
          const daily = typeof company.dailyIncome === "number" && Number.isFinite(company.dailyIncome) ? company.dailyIncome : null;
          const averageDaily = weekly === null ? null : weekly / 7;
          const stars = typeof company.starRating === "number" && Number.isFinite(company.starRating) ? String(company.starRating) : "Not reported";
          return (index + 1) + ". **" + name + "** (" + type + ")\n   Director: " + director +
            "  |  Weekly: " + money(weekly) + "  |  Daily: " + money(daily) +
            "  |  Avg/day (weekly / 7): " + money(averageDaily) + "  |  Stars: " + stars;
        });
        const sourceAt = data.generatedAt || directors.map(d => d.fetchedAt).filter(Boolean).sort().at(-1) || "timestamp unavailable";
        return chunkedPrivateReply("**Faction company rankings by weekly income**\nCompanies: " + directors.length + "  |  Snapshot: " + sourceAt, lines);
      }
      if (subcommand !== "global") return privateReply("Choose /rankings global or /rankings faction.");
      const ownRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
      if (ownRes.status === 401 || ownRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!ownRes.ok) return privateReply("Your company data is temporarily unavailable. Please try again later.");
      const ownData = await ownRes.json(), ownCompanies = Array.isArray(ownData.companies) ? ownData.companies : [];
      const own = ownCompanies[0];
      if (!own) return privateReply("No saved company is available. Open the dashboard and refresh company data first.");
      const ownDetailRes = await dashboardFetch(env, "/api/me/companies/" + encodeURIComponent(own.company_id), { headers, signal: AbortSignal.timeout(8000) });
      let ownProfile = {}, ownRoot = {}, ownIncomeRoot = {}, ownTypeRoot = {};
      if (ownDetailRes.ok) {
        const detail = await ownDetailRes.json();
        ownProfile = detail.profile && typeof detail.profile === "object" ? detail.profile : {};
        ownRoot = ownProfile.company && typeof ownProfile.company === "object" ? ownProfile.company :
          ownProfile.profile && typeof ownProfile.profile === "object" ? ownProfile.profile : ownProfile;
        ownIncomeRoot = ownRoot.income && typeof ownRoot.income === "object" ? ownRoot.income : {};
        ownTypeRoot = ownRoot.type && typeof ownRoot.type === "object" ? ownRoot.type : {};
      }
      const globalRes = await dashboardFetch(env, "/api/rankings?scope=global", { headers, signal: AbortSignal.timeout(15000) });
      if (globalRes.status === 401 || globalRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!globalRes.ok) return privateReply("Company rankings are temporarily unavailable. Please try again later.");
      const data = await globalRes.json();
      const companies = (Array.isArray(data.companies) ? data.companies : []).slice().sort((a,b) => {
        const av = typeof a.weeklyIncome === "number" && Number.isFinite(a.weeklyIncome) ? a.weeklyIncome : -Infinity;
        const bv = typeof b.weeklyIncome === "number" && Number.isFinite(b.weeklyIncome) ? b.weeklyIncome : -Infinity;
        return bv - av;
      });
      if (!companies.length) return privateReply("No global company ranking snapshot is available yet. Try again after the dashboard ranking cache refreshes.");
      // Resolve the linked company's identity from all known dashboard profile shapes.
      // The dashboard's player ID is not necessarily its company ID, so never use it
      // as a company identifier unless the company endpoint explicitly supplies it.
      const ownIdCandidates = [
        own.company_id, own.companyId, own.id,
        ownRoot.company_id, ownRoot.companyId, ownRoot.id,
        ownProfile.company_id, ownProfile.companyId
      ].filter(v => v !== null && v !== undefined && String(v).trim() !== "").map(String);
      const ownId = ownIdCandidates[0] || "";
      const ownName = safeText(ownRoot.name || ownRoot.company_name || ownRoot.companyName ||
        own.company_name || own.companyName || ownProfile.company_name || ownProfile.companyName || "Your company", 90);
      const ownNameKey = ownName.trim().toLocaleLowerCase();
      let ownRankIndex = companies.findIndex(c => {
        const id = c.companyId ?? c.company_id ?? c.id;
        return id !== null && id !== undefined && ownIdCandidates.includes(String(id));
      });
      if (ownRankIndex < 0 && ownNameKey !== "your company") {
        ownRankIndex = companies.findIndex(c => {
          const name = safeText(c.companyName || c.company_name || c.name || "", 90).trim().toLocaleLowerCase();
          const typeMatches = !ownTypeRoot.id || c.companyTypeId == null || String(c.companyTypeId) === String(ownTypeRoot.id);
          return name === ownNameKey && typeMatches;
        });
      }
      let ownIncome = ownRankIndex >= 0 && typeof companies[ownRankIndex].weeklyIncome === "number" ? companies[ownRankIndex].weeklyIncome :
        (typeof ownIncomeRoot.weekly === "number" ? ownIncomeRoot.weekly : typeof own.weekly_income === "number" ? own.weekly_income : null);
      let ownRating = ownRankIndex >= 0 && typeof companies[ownRankIndex].starRating === "number" ? companies[ownRankIndex].starRating :
        (typeof ownRoot.rating === "number" ? ownRoot.rating : typeof ownRoot.star_rating === "number" ? ownRoot.star_rating : null);
      let ownTypeId = ownRankIndex >= 0 ? companies[ownRankIndex].companyTypeId : (ownTypeRoot.id ?? null);
      let ownType = ownRankIndex >= 0 ? companies[ownRankIndex].companyType : (own.company_type || ownTypeRoot.name || "Unknown");
      if (ownRankIndex < 0) {
        const virtual = { companyId: ownId, companyName: ownName, companyType: ownType, companyTypeId: ownTypeId, starRating: ownRating, weeklyIncome: ownIncome, dailyIncome: typeof ownIncomeRoot.daily === "number" ? ownIncomeRoot.daily : null, _ownOnly: true };
        const insertion = typeof ownIncome === "number" ? companies.findIndex(c => !(typeof c.weeklyIncome === "number") || c.weeklyIncome < ownIncome) : -1;
        ownRankIndex = insertion >= 0 ? insertion : companies.length;
        if (insertion >= 0) companies.splice(insertion, 0, virtual); else companies.push(virtual);
      }
      const aroundStart = Math.max(0, ownRankIndex - 6);
      const aroundEnd = Math.min(companies.length, ownRankIndex + 1 + 4);
      const nearby = companies.slice(aroundStart, aroundEnd);
      const lines = nearby.map((company, index) => {
        const rank = aroundStart + index + 1;
        const isOwn = String(company.companyId ?? company.company_id ?? "") === ownId;
        const stars = typeof company.starRating === "number" && Number.isFinite(company.starRating) ? company.starRating + " stars" : "stars not reported";
        const name = safeText(company.companyName || company.company_name || "Company", 80);
        return (isOwn ? "➡️ " : "") + "**#" + rank + " " + name + "** (" + safeText(company.companyType || "Unknown type", 40) + ")  |  " + stars + "\n   Weekly income: " + money(company.weeklyIncome) + (isOwn ? "  ← your company" : "");
      });
      const currentIncome = typeof ownIncome === "number" ? ownIncome : null;
      const currentStars = typeof ownRating === "number" ? ownRating : null;
      const sameType = companies.filter(c => {
        if (ownTypeId !== null && ownTypeId !== undefined && c.companyTypeId !== null && c.companyTypeId !== undefined) return String(c.companyTypeId) === String(ownTypeId);
        return String(c.companyType || "").trim().toLocaleLowerCase() === String(ownType || "").trim().toLocaleLowerCase();
      }).filter(c => typeof c.weeklyIncome === "number" && Number.isFinite(c.weeklyIncome) && typeof c.starRating === "number" && Number.isFinite(c.starRating) && !c._ownOnly);
      const benchmarks = [];
      if (currentStars !== null && currentIncome !== null) {
        const above = sameType.filter(c => c.starRating > currentStars).sort((a,b) => a.starRating-b.starRating || a.weeklyIncome-b.weeklyIncome);
        const lower = sameType.filter(c => c.starRating < currentStars).sort((a,b) => b.starRating-a.starRating || b.weeklyIncome-a.weeklyIncome);
        if (above.length) {
          const nextLevel = above[0].starRating;
          const target = above.filter(c => c.starRating === nextLevel).sort((a,b) => a.weeklyIncome-b.weeklyIncome)[0];
          const gap = target.weeklyIncome - currentIncome;
          benchmarks.push("Gain to observed next-star level (" + nextLevel + "★ companies): " + (gap > 0 ? money(gap) + "/week more to match the lowest-income company currently seen at " + nextLevel + "★ (" + money(target.weeklyIncome) + "/week)." : "your current income is already at or above the lowest observed " + nextLevel + "★ benchmark (" + money(target.weeklyIncome) + "/week)."));
        } else benchmarks.push("Gain to next-star level: not enough same-type higher-star data in this snapshot.");
        if (lower.length) {
          const previousLevel = lower[0].starRating;
          const target = lower.filter(c => c.starRating === previousLevel).sort((a,b) => b.weeklyIncome-a.weeklyIncome)[0];
          const buffer = currentIncome - target.weeklyIncome;
          benchmarks.push("Buffer above observed previous-star level (" + previousLevel + "★ companies): " + (buffer > 0 ? money(buffer) + "/week above the highest-income company currently seen at " + previousLevel + "★ (" + money(target.weeklyIncome) + "/week)." : "current income is at or below the highest observed " + previousLevel + "★ benchmark (" + money(target.weeklyIncome) + "/week)."));
        } else benchmarks.push("Previous-star income buffer: not enough same-type lower-star data in this snapshot.");
      } else {
        benchmarks.push("Star-level income comparisons are unavailable because your current weekly income or star rating was not reported.");
      }
      const generatedAt = data.generatedAt || "timestamp unavailable";
      const rankLabel = companies[ownRankIndex]?._ownOnly ? "estimated slot among " + companies.length + " companies" : "rank #" + (ownRankIndex + 1) + " of " + companies.length;
      return chunkedPrivateReply("**Global company rankings**\nYour company: " + ownName + "  |  " + rankLabel + "  |  Weekly income: " + money(currentIncome) +
        "\nSnapshot: " + generatedAt + " (" + snapshotAgeLabel(generatedAt) + ")\nNearby ranks: 6 above and 4 below, where available.", [
          ...lines,
          "\n**Observed same-type star-income benchmarks**",
          ...benchmarks,
          "Note: these compare companies in the latest global snapshot; they are not guaranteed official Torn star thresholds."
        ]);
    } catch { return privateReply("Company rankings are temporarily unavailable. Please try again later."); }
  }
  if (name === "alerts") {
    const subcommand = commandOptions(i).subcommand;
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const linkPath = "/api/me/discord-link";
      if (subcommand === "enable" || subcommand === "disable") {
        const enabled = subcommand === "enable";
        const res = await dashboardFetch(env, linkPath, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ alertsEnabled: enabled }), signal: AbortSignal.timeout(8000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return privateReply(String(data.error || "Discord alert settings could not be updated."));
        return privateReply(enabled ? "✅ Private Discord alerts are enabled. New alerts will be sent by DM, respecting minimum-severity and quiet-hours settings." : "🔕 Private Discord alerts are disabled. Your dashboard link remains connected.");
      }
      const prefsRes = await dashboardFetch(env, "/api/me/automation-preferences", { headers, signal: AbortSignal.timeout(8000) });
      const prefsData = prefsRes.ok ? await prefsRes.json() : {};
      const prefs = prefsData && typeof prefsData.preferences === "object" ? prefsData.preferences : {};
      if (subcommand === "configure") {
        const minSeverity = optionValue(i, "minimum_severity");
        const quietEnabled = optionValue(i, "quiet_hours_enabled");
        const quietStart = optionValue(i, "quiet_hours_start");
        const quietEnd = optionValue(i, "quiet_hours_end");
        const timezone = optionValue(i, "timezone");
        const body = {};
        if (typeof minSeverity === "string") body.minimumSeverity = minSeverity;
        if (typeof quietEnabled === "boolean") body.quietHoursEnabled = quietEnabled;
        if (typeof quietStart === "string") body.quietHoursStart = quietStart;
        if (typeof quietEnd === "string") body.quietHoursEnd = quietEnd;
        if (typeof timezone === "string") body.timezone = timezone;
        if (!Object.keys(body).length) {
          return privateReply("Current config: minimum severity **" + String(prefs.minimumSeverity || "info") + "**; quiet hours **" +
            ((prefs.quietHoursEnabled === true || Number(prefs.quietHoursEnabled) === 1) ? "on" : "off") + "** (" +
            String(prefs.quietHoursStart || "22:00") + "–" + String(prefs.quietHoursEnd || "08:00") + ", " + String(prefs.timezone || "UTC") + ").\nUse optional settings to change values. Quiet hours use the selected time zone.");
        }
        const saveRes = await dashboardFetch(env, "/api/me/automation-preferences", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) return privateReply(String(saveData.error || "Alert configuration could not be saved."));
        const saved = saveData.preferences || {};
        return privateReply("✅ Alert configuration saved. Minimum severity: **" + String(saved.minimumSeverity || "info") +
          "**; quiet hours: **" + ((saved.quietHoursEnabled === true || Number(saved.quietHoursEnabled) === 1) ? "on" : "off") +
          "** (" + String(saved.quietHoursStart || "22:00") + "–" + String(saved.quietHoursEnd || "08:00") + ", " + String(saved.timezone || "UTC") +
          "). Discord DMs are sent immediately when enabled and outside quiet hours.");
      }
      if (subcommand !== "status") return privateReply("Choose /alerts enable, /alerts disable, /alerts configure, or /alerts status.");
      const [linkRes, rulesRes] = await Promise.all([
        dashboardFetch(env, linkPath, { headers, signal: AbortSignal.timeout(8000) }),
        dashboardFetch(env, "/api/me/alert-rules", { headers, signal: AbortSignal.timeout(8000) })
      ]);
      const linkData = linkRes.ok ? await linkRes.json() : {};
      const rulesData = rulesRes.ok ? await rulesRes.json() : {};
      const rules = Array.isArray(rulesData.rules) ? rulesData.rules : [];
      const enabledRules = rules.filter(rule => rule.enabled === true || Number(rule.enabled) === 1).length;
      const last = await env.BOT_DB.prepare("SELECT status, attempts, updated_at AS updatedAt FROM discord_alert_deliveries WHERE discord_user_id=? ORDER BY updated_at DESC LIMIT 1").bind(user).first();
      const lines = [
        "Dashboard link: **" + (linkData.linked ? "connected" : "not confirmed") + "**",
        "Private Discord DMs: **" + (linkData.alertsEnabled ? "enabled" : "disabled") + "**",
        "Minimum severity: **" + String(prefs.minimumSeverity || "info") + "**",
        "Quiet hours: **" + ((prefs.quietHoursEnabled === true || Number(prefs.quietHoursEnabled) === 1) ? "on" : "off") + "** (" +
          String(prefs.quietHoursStart || "22:00") + "–" + String(prefs.quietHoursEnd || "08:00") + ", " + String(prefs.timezone || "UTC") + ")",
        "Dashboard alert rules enabled: **" + enabledRules + " / " + rules.length + "**",
        "Most recent private delivery: **" + (last ? String(last.status) + " (attempts " + String(last.attempts) + ", " + String(last.updatedAt) + ")" : "no delivery records") + "**"
      ];
      return privateReply("**Private alert status**\n" + lines.join("\n") + "\nDiscord DMs are immediate when enabled, subject to minimum severity and quiet hours.");
    } catch { return privateReply("Alert settings are temporarily unavailable. Please try again later."); }
  }
    return privateReply("That command isn't enabled yet. Use /help to see available commands.");
}
export default {
  async scheduled(_controller, env, ctx) { ctx.waitUntil(pollPrivateAlerts(env)); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "naughty-company-bot", database: !!env.BOT_DB, encryption: !!env.BOT_ENCRYPTION_KEY, discordConfigured: !!env.DISCORD_TOKEN, dashboardBinding: !!env.DASHBOARD_API, privateAlertDelivery: true });
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
