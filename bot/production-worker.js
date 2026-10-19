import { money, numberLabel, countChangeLabel } from "./formatting.mjs";
import { parseCommandRoute } from "./command-routing.mjs";
import { buildCostBreakdown, estimateDailyProfit, estimateWeeklyProfit, findAdvertisingBudget, knownWageSummary, stockOrderExpenses, summarizeMonthToDate } from "./financials.mjs";

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
  // Keep a newly provisioned production database usable without a separate manual bootstrap.
  await env.BOT_DB.prepare("CREATE TABLE IF NOT EXISTS discord_links (discord_user_id TEXT PRIMARY KEY, dashboard_player_id TEXT NOT NULL, encrypted_session_token TEXT NOT NULL, token_iv TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await env.BOT_DB.prepare("CREATE TABLE IF NOT EXISTS alert_preferences (discord_user_id TEXT PRIMARY KEY REFERENCES discord_links(discord_user_id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1, severities TEXT NOT NULL DEFAULT '[\"critical\",\"warning\"]', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await env.BOT_DB.prepare("CREATE TABLE IF NOT EXISTS alert_deliveries (delivery_key TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
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
  return parseCommandRoute(interaction);
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
    // Reject stale API-key modal submissions; the supported flow uses a short-lived dashboard code.
    return privateReply("Direct API-key entry in Discord is disabled. Open the dashboard, generate a one-time Discord link code, then use /link-code.");
  }
  if (i.type === 4) {
    const route = commandOptions(i);
    const focused = route.options.find(option => option && option.focused === true);
    if (!focused || !user) return { type: 8, data: { choices: [] } };
    const query = String(focused.value || "").trim().toLocaleLowerCase();
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return { type: 8, data: { choices: [] } };
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      if (name === "company" && route.group === "alerts" && route.subcommand === "acknowledge" && focused.name === "alert") {
        const response = await dashboardFetch(env, "/api/me/alerts?limit=100", { headers, signal: AbortSignal.timeout(1800) });
        if (!response.ok) return { type: 8, data: { choices: [] } };
        const data = await response.json();
        const events = Array.isArray(data.events) ? data.events : [];
        const choices = events
          .filter(event => String(event.status || "").toLowerCase() === "unread" &&
            typeof event.eventId === "string" && /^[a-f0-9-]{36}$/i.test(event.eventId))
          .map(event => {
            const severity = safeText(String(event.severity || "info").toUpperCase(), 10);
            const title = safeText(event.title || event.ruleType || "Dashboard alert", 36);
            const company = safeText(event.companyName || event.companyId || "Company", 22);
            const created = safeText(event.createdAt || "time unavailable", 16);
            const label = ("[" + severity + "] " + title + " | " + company + " | " + created).slice(0, 100);
            const searchable = [event.severity, event.title, event.ruleType, event.companyName, event.companyId, event.createdAt]
              .map(value => String(value || "")).join(" ").toLocaleLowerCase();
            return { name: label, value: event.eventId, searchable };
          })
          .filter(choice => !query || choice.searchable.includes(query) || choice.name.toLocaleLowerCase().includes(query))
          .slice(0, 25).map(({ name, value }) => ({ name, value }));
        return { type: 8, data: { choices } };
      }
      if (name !== "automation") return { type: 8, data: { choices: [] } };
      if (route.group === "webhook" && route.subcommand === "retry" && focused.name === "delivery") {
        const response = await dashboardFetch(env, "/api/me/automation-webhook/deliveries?limit=50", { headers, signal: AbortSignal.timeout(1800) });
        if (!response.ok) return { type: 8, data: { choices: [] } };
        const data = await response.json();
        const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
        const seen = new Set();
        const choices = deliveries.filter(delivery => String(delivery.status || "").toLowerCase() === "failed" &&
          typeof delivery.eventId === "string" && /^[a-f0-9-]{36}$/i.test(delivery.eventId))
          .filter(delivery => {
            if (seen.has(delivery.eventId)) return false;
            seen.add(delivery.eventId);
            return true;
          }).map(delivery => {
            const detail = safeText(delivery.detail || "Delivery failed", 48);
            const created = safeText(delivery.createdAt || "time unavailable", 28);
            return { name: ("Failed · " + detail + " · " + created).slice(0, 100), value: delivery.eventId, searchable: (detail + " " + created).toLocaleLowerCase() };
          }).filter(choice => !query || choice.searchable.includes(query) || choice.name.toLocaleLowerCase().includes(query))
          .slice(0, 25).map(({ name, value }) => ({ name, value }));
        return { type: 8, data: { choices } };
      }
      return { type: 8, data: { choices: [] } };
    } catch { return { type: 8, data: { choices: [] } }; }
  }
  if (i.type !== 2) return privateReply("Unsupported interaction.");
  if (name === "ping") return privateReply("Pong! Naughty Company Bot is responding.");
  if (name === "help") {
    const helpLines = [
      "**Naughty Company Bot**",
      "",
      "**Account linking**",
      "- `/link`  Get secure dashboard-linking instructions.",
      "- `/link-code`  Redeem a one-time dashboard code (expires in five minutes).",
      "- `/status`  Check your account link.",
      "- `/unlink`  Disconnect this Discord account.",
      "",
      "**Dashboard**",
      "- `/dashboard health`  Check API, database, and company freshness.",
      "- `/dashboard summary`  View coverage, scheduled runs, and recent alerts.",
      "",
      "**Company data**",
      "- `/company list`  List connected companies.",
      "- `/company overview`, `/company income`, `/company profit`, `/company stars`, `/company ads`, `/company stock`, `/company employees`, `/company wages`, `/company trends`  View company metrics. Employees supports brief/full detail.",
      "",
      "**Company alerts**",
      "- `/company alerts recent`, `/company alerts status`  Review recent alerts and private Discord delivery.",
      "- `/company alerts enable`, `/company alerts disable`, `/company alerts acknowledge`  Manage private DMs and acknowledge alerts.",
      "",
      "**Company rankings**",
      "- `/company rankings companies`, `/company rankings company`, `/company rankings compare`, `/company rankings global`, `/company rankings faction`  Browse company rankings.",
      "",
      "**Automation**",
      "- Alert rules and notification preferences are managed in the dashboard.",
      "- `/automation notifications status`  Inspect severity, quiet hours, and webhook digest preferences.",
      "- `/automation webhook status`, `/automation webhook deliveries`, `/automation webhook retry`, `/automation webhook delete`  Manage the external webhook.",
      "",
      "**Bot**",
      "- `/bot status`  Check bot and dashboard availability.",
      "- `/ping`  Test the bot response.",
      "- `/help`  Show this guide.",
      "",
      "Account-specific replies are private by default. The bot never needs your Torn API key in Discord."
    ];
    return privateReply(helpLines.join("\n"));
  }
  if (!user) return privateReply("Unable to identify your Discord account.");
  if (name === "bot") {
    if (commandOptions(i).subcommand !== "status") return privateReply("Choose /bot status.");
    try {
      const response = await dashboardFetch(env, "/health", { signal: AbortSignal.timeout(5000) });
      const health = await response.json().catch(() => ({}));
      return privateReply("**Naughty Company Bot status**\nInteraction endpoint: responding\nDashboard API: " + (response.ok && health?.ok ? "healthy" : "unavailable") + "\nDashboard health checked: " + String(health?.checkedAt || "timestamp not provided") + "\nNo account data or credentials are included in this status response.");
    } catch { return privateReply("The bot is responding, but dashboard API health could not be checked."); }
  }
  if (name === "link") return privateReply("**Secure dashboard linking**\n1. Open https://naughty-company-dashboard.pages.dev and sign in.\n2. Open the Automation Center’s Discord linking section and generate a one-time link code. It expires after five minutes.\n3. Run /link-code and submit that code in the private form.\n\nNever post a Torn API key in a Discord channel. This bot uses the dashboard’s one-time code flow.");
  if (name === "link-code") return { type: 9, data: { custom_id: "link_code_submit", title: "Link from dashboard", components: [{ type: 18, label: "Dashboard link code", component: { type: 4, custom_id: "link_code", style: 1, min_length: 48, max_length: 48, required: true, placeholder: "Paste the one-time dashboard code" } }] } };
  if (name === "status") { const row = await env.BOT_DB.prepare("SELECT dashboard_player_id,updated_at FROM discord_links WHERE discord_user_id=?1").bind(user).first(); return privateReply(row ? "Your dashboard account is linked. Player ID: " + row.dashboard_player_id + ". Last linked: " + row.updated_at + "." : "No dashboard account is linked. Run /link to connect one."); }
  if (name === "unlink") {
    const linked = await env.BOT_DB.prepare("SELECT encrypted_session_token AS cipher,token_iv AS iv FROM discord_links WHERE discord_user_id=?").bind(user).first();
    if (linked) { try { const token = await unseal(linked.cipher, linked.iv, env); await dashboardFetch(env, "/api/me/discord-link", { method: "DELETE", headers: { authorization: "Bearer " + token } }); } catch {} }
    await env.BOT_DB.prepare("DELETE FROM alert_preferences WHERE discord_user_id=?").bind(user).run();
    await env.BOT_DB.prepare("DELETE FROM alert_deliveries WHERE discord_user_id=?").bind(user).run();
    await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run();
    await env.BOT_DB.prepare("DELETE FROM discord_alert_state WHERE discord_user_id=?").bind(user).run();
    await env.BOT_DB.prepare("DELETE FROM discord_alert_deliveries WHERE discord_user_id=?").bind(user).run();
    return privateReply("Your dashboard link and private alert delivery link have been removed.");
  }
  if (name === "company" && commandOptions(i).subcommand === "list") {
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
  if (name === "company" && ["income","profit","stars","ads","stock","wages"].includes(commandOptions(i).subcommand)) {
    const subcommand = commandOptions(i).subcommand;
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const companiesRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
      if (companiesRes.status === 401 || companiesRes.status === 403) {
        await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run();
        return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      }
      if (!companiesRes.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
      const companiesData = await companiesRes.json();
      const companies = Array.isArray(companiesData.companies) ? companiesData.companies : [];
      const requestedId = requestedCompanyId(i);
      const company = requestedId ? companies.find(item => String(item.company_id) === requestedId) : companies[0];
      if (!company) return privateReply(requestedId ? "That company ID is not connected to your dashboard account." : "No connected company is available. Connect a company in the dashboard first.");
      const companyId = String(company.company_id);
      const companyName = safeText(company.company_name || "Your company", 90);
      const moneyValue = value => typeof value === "number" && Number.isFinite(value) ? "$" + Math.round(value).toLocaleString("en-US") : "Not available";
      const firstNumber = (...values) => values.find(value => typeof value === "number" && Number.isFinite(value));
      const periodValue = String(optionValue(i, "period") || "30");
      const days = ["7", "30", "90", "365", "all"].includes(periodValue) ? periodValue : "30";

      if (subcommand === "wages") {
        const wagesRes = await dashboardFetch(env, "/api/me/member-insights?companyId=" + encodeURIComponent(companyId), { headers, signal: AbortSignal.timeout(8000) });
        if (wagesRes.status === 401 || wagesRes.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
        if (!wagesRes.ok) return privateReply("Employee wage data is temporarily unavailable. Please try again later.");
        const wagesData = await wagesRes.json();
        const summary = wagesData.summary && typeof wagesData.summary === "object" ? wagesData.summary : {};
        const roster = Array.isArray(wagesData.roster) ? wagesData.roster : [];
        const knownCount = Number(summary.knownWageCount || 0);
        const total = typeof summary.totalKnownWages === "number" && Number.isFinite(summary.totalKnownWages) ? summary.totalKnownWages : null;
        return privateReply("**Known employee wages | " + companyName + "**\nKnown wage total: " + moneyValue(total) + "\nEmployees with reported wages: " + knownCount + "\nRoster entries returned: " + roster.length + "\nMissing wage values remain unknown and are not counted as zero. Data is from the saved dashboard record.");
      }

      const detailRes = await dashboardFetch(env, "/api/me/companies/" + encodeURIComponent(companyId), { headers, signal: AbortSignal.timeout(8000) });
      if (detailRes.status === 401 || detailRes.status === 403) {
        await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run();
        return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      }
      if (detailRes.status === 404) return privateReply("No saved company snapshot exists for " + companyName + " yet. Refresh it in the dashboard first.");
      if (!detailRes.ok) return privateReply("Saved company data is temporarily unavailable. Please try again later.");
      const data = await detailRes.json();
      const profile = data.profile && typeof data.profile === "object" ? data.profile : {};
      const root = profile.company && typeof profile.company === "object" ? profile.company : profile.profile && typeof profile.profile === "object" ? profile.profile : profile;
      const income = root.income && typeof root.income === "object" ? root.income : {};
      const profit = root.profit && typeof root.profit === "object" ? root.profit : {};
      const expenses = root.expenses && typeof root.expenses === "object" ? root.expenses : root.costs && typeof root.costs === "object" ? root.costs : {};
      const fetchedAt = String(data.fetchedAt || company.fetched_at || "Not available");
      const numeric = (...values) => firstNumber(...values);
      const dailyIncome = numeric(income.daily, root.daily_income, root.dailyIncome);
      const weeklyIncome = numeric(income.weekly, root.weekly_income, root.weeklyIncome);
      const dailyProfit = numeric(profit.daily, root.daily_profit, root.dailyProfit, root.profit_daily, typeof root.profit === "number" ? root.profit : undefined);
      const weeklyProfit = numeric(profit.weekly, root.weekly_profit, root.weeklyProfit, root.profit_weekly);
      const rating = numeric(root.company_rating, root.star_rating, root.starRating, root.rating, root.stars);
      const advertisingBudget = findAdvertisingBudget(profile);
      const stockOrderSummary = stockOrderExpenses(data.stock);
      const stockRows = Array.isArray(data.stock) ? data.stock : Array.isArray(data.stock?.stock) ? data.stock.stock :
        data.stock && typeof data.stock === "object" ? Object.values(data.stock).filter(value => value && typeof value === "object") : [];
      const stockQuantity = stockRows.reduce((sum, item) => {
        if (!item || typeof item !== "object") return sum;
        const quantity = firstNumber(item.in_stock, item.quantity, item.amount);
        return sum + (quantity ?? 0);
      }, 0);
      const hasStockQuantity = stockRows.some(item => item && typeof item === "object" && firstNumber(item.in_stock, item.quantity, item.amount) !== undefined);
      let historyData = null;
      if (["income", "profit", "stars", "stock"].includes(subcommand)) {
        const historyRes = await dashboardFetch(env, "/api/me/companies/" + encodeURIComponent(companyId) + "/history?days=" + encodeURIComponent(subcommand === "profit" ? "all" : days), { headers, signal: AbortSignal.timeout(8000) });
        if (historyRes.ok) historyData = await historyRes.json();
        else if (historyRes.status === 401 || historyRes.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      }
      const history = historyData && Array.isArray(historyData.history) ? historyData.history : [];
      const summary = historyData && historyData.summary && typeof historyData.summary === "object" ? historyData.summary : {};
      const periodLabel = days === "all" ? "all saved history" : days + " days";
      if (subcommand === "income") {
        return privateReply("**Income | " + companyName + "**\nDaily income: " + moneyValue(dailyIncome) + "\nWeekly income: " + moneyValue(weeklyIncome) +
          "\nDaily income change over " + periodLabel + ": " + moneyValue(summary.dailyIncomeChange) +
          (typeof summary.dailyIncomeChangePercent === "number" ? " (" + summary.dailyIncomeChangePercent.toFixed(1) + "%)" : "") +
          "\nWeekly income change: " + moneyValue(summary.weeklyIncomeChange) + "\nSnapshot: " + fetchedAt);
      }
      if (subcommand === "profit") {
        const wagesRes = await dashboardFetch(env, "/api/me/member-insights?companyId=" + encodeURIComponent(companyId), { headers, signal: AbortSignal.timeout(8000) });
        if (wagesRes.status === 401 || wagesRes.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
        let wageInfo = knownWageSummary(null);
        if (wagesRes.ok) {
          const wagesData = await wagesRes.json();
          wageInfo = knownWageSummary(wagesData.summary);
        }
        const costBreakdown = buildCostBreakdown({
          advertisingBudget,
          wages: wageInfo.available ? wageInfo.total : null,
          stockSummary: stockOrderSummary
        });
        const estimatedDaily = estimateDailyProfit(dailyIncome, costBreakdown);
        const estimatedWeekly = estimateWeeklyProfit(weeklyIncome, costBreakdown);
        const monthToDate = summarizeMonthToDate(history);
        const dailyProfitText = dailyProfit !== undefined
          ? moneyValue(dailyProfit) + " (reported)"
          : estimatedDaily === null ? "Not available" : moneyValue(estimatedDaily);
        const weeklyProfitText = weeklyProfit !== undefined
          ? moneyValue(weeklyProfit) + " (reported)"
          : estimatedWeekly === null ? "Not available" : moneyValue(estimatedWeekly);
        const reportedCostLines = Object.entries(expenses).filter(([key, value]) => /cost|wage|advert|expense/i.test(key) && typeof value === "number" && Number.isFinite(value))
          .slice(0, 6).map(([key, value]) => safeText(key, 50) + ": " + moneyValue(value));
        return privateReply("**Company profit | " + companyName + "**\nDaily income: " + moneyValue(dailyIncome) +
          "\nDaily profit: " + dailyProfitText + "\nWeekly income: " + moneyValue(weeklyIncome) + "\nWeekly profit: " + weeklyProfitText +
          "\nMonthly income (month to date): " + moneyValue(monthToDate.monthlyIncome) +
          "\nMonthly profit (month to date): " + moneyValue(monthToDate.monthlyProfit) +
          "\nMonth-to-date snapshot coverage: " + monthToDate.snapshotDays + "/" + monthToDate.expectedDays + " days" +
          "\nMonth-to-date cost coverage: " + monthToDate.costDays + "/" + monthToDate.expectedDays + " days" +
          "\n\n**Cost breakdown**\nAdvertising budget: " + moneyValue(costBreakdown.adBudget) +
          "\nTotal employee wages: " + moneyValue(costBreakdown.wages) +
          "\nStock order expense (unit cost × on_order): " + moneyValue(costBreakdown.stockCosts) +
          "\nTotal cost breakdown: " + moneyValue(costBreakdown.total) +
          (reportedCostLines.length ? "\nReported cost fields:\n" + reportedCostLines.join("\n") : "") +
          "\nSnapshot: " + fetchedAt);
      }
      if (subcommand === "stars") {
        return privateReply("**Company stars | " + companyName + "**\nCurrent rating: " + (rating === undefined ? "Not available" : String(rating)) +
          "\nRating change over " + periodLabel + ": " + (typeof summary.ratingChange === "number" ? (summary.ratingChange > 0 ? "+" : "") + summary.ratingChange : "Not available") +
          "\nSnapshot: " + fetchedAt);
      }
      if (subcommand === "ads") {
        return privateReply("**Advertising budget | " + companyName + "**\nReported advertising budget: " + moneyValue(advertisingBudget) +
          "\nSnapshot: " + fetchedAt + "\nIf this is unavailable, the current saved company profile does not contain a recognized advertising-budget field. The bot does not substitute zero.");
      }
      if (subcommand === "stock") {
        const stockHistory = history.filter(point => typeof point.stockQuantity === "number" && Number.isFinite(point.stockQuantity));
        const stockDelta = stockHistory.length > 1 ? stockHistory[stockHistory.length - 1].stockQuantity - stockHistory[stockHistory.length - 2].stockQuantity : null;
        const lines = stockRows.slice(0, 8).map(item => {
          const label = safeText(item.name || item.item_name || item.itemName || item.id || "Stock item", 70);
          const quantity = firstNumber(item.in_stock, item.quantity, item.amount);
          return "- " + label + ": " + (quantity === undefined ? "Not available" : quantity.toLocaleString("en-US"));
        });
        return privateReply("**Stock | " + companyName + "**\nReported stock items: " + (stockRows.length || "Not available") +
          "\nTotal quantity: " + (hasStockQuantity ? stockQuantity.toLocaleString("en-US") : "Not available") +
          "\nChange between last two saved history points (" + periodLabel + "): " + (typeof stockDelta === "number" ? (stockDelta > 0 ? "+" : "") + stockDelta.toLocaleString("en-US") : "Not available") +
          "\nSnapshot: " + fetchedAt + (lines.length ? "\n" + lines.join("\n") : "\nStock item detail not available in the saved record."));
      }
    } catch { return privateReply("Company data is temporarily unavailable. Please try again later."); }
  }
  if (name === "company" && commandOptions(i).subcommand === "overview") {
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
      const reportedDailyProfit = [profit.daily, root.daily_profit, root.dailyProfit, root.profit_daily, typeof root.profit === "number" ? root.profit : undefined].find(value => typeof value === "number" && Number.isFinite(value));
      const reportedWeeklyProfit = [profit.weekly, root.weekly_profit, root.weeklyProfit, root.profit_weekly].find(value => typeof value === "number" && Number.isFinite(value));
      const dailyIncome = [income.daily, root.daily_income, root.dailyIncome].find(value => typeof value === "number" && Number.isFinite(value));
      const weeklyIncome = [income.weekly, root.weekly_income, root.weeklyIncome].find(value => typeof value === "number" && Number.isFinite(value));
      const rating = [root.company_rating, root.star_rating, root.rating, root.stars].find(value => typeof value === "number" && Number.isFinite(value));
      const employeeRoot = data.employees && typeof data.employees === "object" ? data.employees : {};
      const employeeList = Array.isArray(data.employees) ? data.employees : Array.isArray(employeeRoot.employees) ? employeeRoot.employees : Array.isArray(employeeRoot.company_employees) ? employeeRoot.company_employees : [];
      const stockRoot = Array.isArray(data.stock) ? data.stock : data.stock && Array.isArray(data.stock.stock) ? data.stock.stock : data.stock && typeof data.stock === "object" ? Object.values(data.stock).filter(value => value && typeof value === "object") : [];
      const stockQuantity = stockRoot.reduce((sum, item) => { const value = [item.in_stock, item.quantity, item.amount].find(n => typeof n === "number" && Number.isFinite(n)); return sum + (value || 0); }, 0);
      const advertisingBudget = findAdvertisingBudget(profile);
      const stockOrderSummary = stockOrderExpenses(data.stock);
      const wagesRes = await dashboardFetch(env, "/api/me/member-insights?companyId=" + encodeURIComponent(company.company_id), { headers, signal: AbortSignal.timeout(8000) });
      if (wagesRes.status === 401 || wagesRes.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      let wageInfo = knownWageSummary(null);
      if (wagesRes.ok) {
        const wagesData = await wagesRes.json();
        wageInfo = knownWageSummary(wagesData.summary);
      }
      const costBreakdown = buildCostBreakdown({ advertisingBudget, wages: wageInfo.available ? wageInfo.total : null, stockSummary: stockOrderSummary });
      const estimatedDaily = estimateDailyProfit(dailyIncome, costBreakdown);
      const estimatedWeekly = estimateWeeklyProfit(weeklyIncome, costBreakdown);
      const dailyProfit = reportedDailyProfit !== undefined ? money(reportedDailyProfit) + " (reported)" : estimatedDaily === null ? "Not available" : money(estimatedDaily);
      const weeklyProfit = reportedWeeklyProfit !== undefined ? money(reportedWeeklyProfit) + " (reported)" : estimatedWeekly === null ? "Not available" : money(estimatedWeekly);
      const safeName = String(data.companyName || company.company_name || "Your company").replace(/@/g, "@\u200b").slice(0, 90);
      const lines = [
        "**Company overview | " + safeName + "**",
        "Type: " + String(data.companyType || company.company_type || "Not available").slice(0, 60),
        "Daily income: " + money(dailyIncome),
        "Weekly income: " + money(weeklyIncome),
        "Daily profit: " + dailyProfit,
        "Weekly profit: " + weeklyProfit,
        "Stock items: " + (stockRoot.length || "Not reported") + " | Total quantity: " + (stockRoot.length ? stockQuantity.toLocaleString("en-US") : "Not available"),
        "Snapshot updated: " + String(data.fetchedAt || company.fetched_at || "Not available"),
        "Snapshot age: " + snapshotAgeLabel(data.fetchedAt || company.fetched_at)
      ];
      const snapshotMs = Date.parse(data.fetchedAt || company.fetched_at || "");
      if (Number.isFinite(snapshotMs) && Date.now() - snapshotMs > 36 * 3600000) lines.push("⚠️ This company snapshot may be stale. Refresh it in the dashboard.");
      return privateReply(lines.join("\n"));
    } catch { return privateReply("Company overview is temporarily unavailable. Please try again later."); }
  }
  if (name === "company" && commandOptions(i).subcommand === "employees") {
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
      const full = optionValue(i, "detail") === "full";
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
    if (name === "company" && commandOptions(i).subcommand === "trends") {
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
      const requestedPeriod = String(optionValue(i, "period") || "30");
      const days = ["7", "30", "90", "365", "all"].includes(requestedPeriod) ? requestedPeriod : "30";
      const requestedMetric = String(optionValue(i, "metric") || "overview");
      const historyRes = await dashboardFetch(env, "/api/me/companies/" + encodeURIComponent(company.company_id) + "/history?days=" + encodeURIComponent(days), { headers, signal: AbortSignal.timeout(8000) });
      if (historyRes.status === 401 || historyRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!historyRes.ok) return privateReply("Trend data is temporarily unavailable. Please try again later.");
      const data = await historyRes.json(), s = data.summary || {}, history = Array.isArray(data.history) ? data.history : [], latest = history.slice(-1)[0] || {}, first = history[0] || {};
      const firstMs = Date.parse(first.fetchedAt || ""), latestMs = Date.parse(latest.fetchedAt || "");
      const coverageDays = Number.isFinite(firstMs) && Number.isFinite(latestMs) ? Math.max(0, (latestMs - firstMs) / 86400000) : 0;
      const coverageNote = history.length < 7 || coverageDays < 20 ? "Coverage note: Limited history; these snapshots may not represent the full 30 days." : "Coverage: " + String(first.fetchedAt || "earliest snapshot unavailable") + " to " + String(latest.fetchedAt || "latest snapshot unavailable");
      const change = v => typeof v === "number" && Number.isFinite(v) ? (v > 0 ? "+" : "") + money(v) : "Not available";
      const title = "**" + (days === "all" ? "All-history" : days + "-day") + " trend  |  " + String(company.company_name || "Your company").slice(0, 90) + "**";
      const summaryLines = ["Snapshots: " + Number(s.snapshotCount || 0)];
      if (requestedMetric === "overview" || requestedMetric === "income") {
        summaryLines.push("Daily income change: " + change(s.dailyIncomeChange) + (s.dailyIncomeChangePercent == null ? "" : " (" + Number(s.dailyIncomeChangePercent).toFixed(1) + "%)"));
        summaryLines.push("Weekly income change: " + change(s.weeklyIncomeChange));
      }
      if (requestedMetric === "overview" || requestedMetric === "stars") summaryLines.push("Star-rating change: " + countChangeLabel(s.ratingChange, "star", "stars"));
      if (requestedMetric === "overview" || requestedMetric === "employees") summaryLines.push("Employee-count change: " + countChangeLabel(s.employeeCountChange, "employee", "employees") + " | latest: " + (latest.employeeCount == null ? "Not available" : latest.employeeCount));
      if (requestedMetric === "overview" || requestedMetric === "stock") {
        const stockHistory = history.filter(point => typeof point.stockQuantity === "number");
        const stockDelta = stockHistory.length > 1 ? stockHistory[stockHistory.length - 1].stockQuantity - stockHistory[stockHistory.length - 2].stockQuantity : null;
        summaryLines.push("Latest stock quantity: " + (typeof latest.stockQuantity === "number" ? latest.stockQuantity.toLocaleString("en-US") : "Not available"));
        summaryLines.push("Stock change vs prior saved point: " + (typeof stockDelta === "number" ? (stockDelta > 0 ? "+" : "") + stockDelta.toLocaleString("en-US") : "Not available"));
      }
      summaryLines.push("Latest snapshot: " + String(latest.fetchedAt || s.latestSnapshotAt || "Not available"));
      if (history.length < 7 || coverageDays < 20) summaryLines.push("Coverage note: Limited history; the selected window may be incomplete.");
      return privateReply(title + "\n" + summaryLines.join("\n"));
    } catch { return privateReply("Trend data is temporarily unavailable. Please try again later."); }
  }
  if (name === "company" && commandOptions(i).group === "rankings") {
    const subcommand = commandOptions(i).subcommand;
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      if (subcommand === "companies") {
        const typeId = optionValue(i, "company_type_id");
        if (!Number.isInteger(typeId) || typeId <= 0) return privateReply("Choose a valid positive company type ID.");
        const page = Math.max(1, Number(optionValue(i, "page") || 1));
        const sort = String(optionValue(i, "sort") || "weekly_income");
        const res = await dashboardFetch(env, "/api/rankings?scope=global&typeId=" + encodeURIComponent(String(typeId)), { headers, signal: AbortSignal.timeout(12000) });
        if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
        if (!res.ok) return privateReply("Global company rankings are temporarily unavailable. Please try again later.");
        const data = await res.json();
        const companies = (Array.isArray(data.companies) ? data.companies : []).slice();
        if (!companies.length) return privateReply("No cached global companies were found for type ID " + typeId + ". The dashboard ranking cache may not include that type yet.");
        const valueOf = company => sort === "stars" ? company.starRating : sort === "daily_income" ? company.dailyIncome : company.weeklyIncome;
        companies.sort((a, b) => {
          const av = valueOf(a), bv = valueOf(b);
          if (typeof av !== "number" || !Number.isFinite(av)) return typeof bv === "number" && Number.isFinite(bv) ? 1 : 0;
          if (typeof bv !== "number" || !Number.isFinite(bv)) return -1;
          return bv - av;
        });
        const pageSize = 10, start = (page - 1) * pageSize, visible = companies.slice(start, start + pageSize);
        if (!visible.length) return privateReply("That page is beyond the " + companies.length + " cached companies for type ID " + typeId + ".");
        const sortLabel = sort === "stars" ? "star rating" : sort === "daily_income" ? "daily income" : "weekly income";
        const lines = visible.map((company, index) => {
          const companyName = safeText(company.companyName || company.company_name || company.name || "Company", 90);
          const stars = typeof company.starRating === "number" ? String(company.starRating) + "★" : "stars not reported";
          return "#" + (start + index + 1) + " **" + companyName + "** | " + stars + " | Daily: " + money(company.dailyIncome) + " | Weekly: " + money(company.weeklyIncome);
        });
        return chunkedPrivateReply("**Global company rankings | type ID " + typeId + "**\nSorted by " + sortLabel + " | Page " + page + " of " + Math.max(1, Math.ceil(companies.length / pageSize)) + "\nSource: " + String(data.source || "daily global ranking cache") + "\nSnapshot: " + String(data.generatedAt || "timestamp unavailable") + "\nTotal cached companies: " + companies.length, lines);
      }
      if (subcommand === "faction") {
        const res = await dashboardFetch(env, "/api/faction/directors", { headers, signal: AbortSignal.timeout(12000) });
        if (res.status === 401 || res.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
        if (!res.ok) return privateReply("Faction director data is temporarily unavailable. Please try again later.");
        const data = await res.json();
        const allDirectors = (Array.isArray(data.directors) ? data.directors : []).slice();
        const sort = String(optionValue(i, "sort") || "weekly_income");
        const rankValue = company => sort === "stars" ? company.starRating : sort === "daily_income" ? company.dailyIncome : company.weeklyIncome;
        allDirectors.sort((a,b) => {
          const av = rankValue(a), bv = rankValue(b);
          if (typeof av !== "number" || !Number.isFinite(av)) return typeof bv === "number" && Number.isFinite(bv) ? 1 : 0;
          if (typeof bv !== "number" || !Number.isFinite(bv)) return -1;
          return bv - av;
        });
        if (!allDirectors.length) return privateReply("No faction director companies are in the cached directory yet. Refresh the faction directory in the dashboard first.");
        const page = Math.max(1, Number(optionValue(i, "page") || 1)), pageSize = 10, start = (page - 1) * pageSize;
        const directors = allDirectors.slice(start, start + pageSize);
        if (!directors.length) return privateReply("That page is beyond the " + allDirectors.length + " cached faction companies.");
        const lines = directors.map((company, index) => {
          const name = safeText(company.companyName || ("Company #" + (company.companyId || "unknown")), 80);
          const type = safeText(company.companyType || "Type not reported", 45);
          const director = safeText(company.directorName || ("Player #" + (company.playerId || "unknown")), 60);
          const weekly = typeof company.weeklyIncome === "number" && Number.isFinite(company.weeklyIncome) ? company.weeklyIncome : null;
          const daily = typeof company.dailyIncome === "number" && Number.isFinite(company.dailyIncome) ? company.dailyIncome : null;
          const averageDaily = weekly === null ? null : weekly / 7;
          const stars = typeof company.starRating === "number" && Number.isFinite(company.starRating) ? String(company.starRating) : "Not reported";
          return "#" + (start + index + 1) + ". **" + name + "** (" + type + ")\n   Director: " + director +
            "  |  Weekly: " + money(weekly) + "  |  Daily: " + money(daily) +
            "  |  Avg/day (weekly / 7): " + money(averageDaily) + "  |  Stars: " + stars;
        });
        const sourceAt = data.generatedAt || directors.map(d => d.fetchedAt).filter(Boolean).sort().at(-1) || "timestamp unavailable";
        return chunkedPrivateReply("**Faction company rankings**\nSorted by " + (sort === "stars" ? "star rating" : sort === "daily_income" ? "daily income" : "weekly income") + " | Page " + page + " of " + Math.max(1, Math.ceil(allDirectors.length / pageSize)) + "\nCompanies: " + allDirectors.length + "  |  Snapshot: " + sourceAt, lines);
      }
      if (!["global", "company", "compare"].includes(subcommand)) return privateReply("Choose /company rankings companies, /company rankings company, /company rankings compare, or /company rankings faction.");
      const ownRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
      if (ownRes.status === 401 || ownRes.status === 403) { await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run(); return privateReply("Your dashboard session expired or access changed. Run /link to reconnect."); }
      if (!ownRes.ok) return privateReply("Your company data is temporarily unavailable. Please try again later.");
      const ownData = await ownRes.json(), ownCompanies = Array.isArray(ownData.companies) ? ownData.companies : [];
      const requestedOwnId = requestedCompanyId(i);
      const own = requestedOwnId ? ownCompanies.find(company => String(company.company_id) === requestedOwnId) : ownCompanies[0];
      if (!own) return privateReply(requestedOwnId ? "That company ID is not connected to your dashboard account." : "No saved company is available. Open the dashboard and refresh company data first.");
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
      // The linked company's current profile is authoritative for its income.
      // The global ranking snapshot can lag behind the live company payload.
      const liveWeeklyIncome = typeof ownIncomeRoot.weekly === "number" && Number.isFinite(ownIncomeRoot.weekly)
        ? ownIncomeRoot.weekly
        : typeof own.weekly_income === "number" && Number.isFinite(own.weekly_income) ? own.weekly_income : null;
      let ownIncome = liveWeeklyIncome !== null ? liveWeeklyIncome :
        (ownRankIndex >= 0 && typeof companies[ownRankIndex].weeklyIncome === "number" && Number.isFinite(companies[ownRankIndex].weeklyIncome)
          ? companies[ownRankIndex].weeklyIncome : null);
      let ownRating = ownRankIndex >= 0 && typeof companies[ownRankIndex].starRating === "number" ? companies[ownRankIndex].starRating :
        (typeof ownRoot.rating === "number" ? ownRoot.rating : typeof ownRoot.star_rating === "number" ? ownRoot.star_rating : null);
      let ownTypeId = ownRankIndex >= 0 ? (companies[ownRankIndex].companyTypeId ?? companies[ownRankIndex].company_type_id ?? companies[ownRankIndex].type_id ?? companies[ownRankIndex].typeId ?? null) : (ownTypeRoot.id ?? ownTypeRoot.type_id ?? ownTypeRoot.typeId ?? null);
      let ownType = ownRankIndex >= 0 ? companies[ownRankIndex].companyType : (own.company_type || ownTypeRoot.name || "Unknown");
      if (ownRankIndex >= 0 && ownIncome !== null) {
        // Re-rank against snapshot peers using the live income, and label the slot as estimated.
        companies[ownRankIndex] = { ...companies[ownRankIndex], weeklyIncome: ownIncome, _liveOwnIncome: true };
        companies.sort((a,b) => {
          const av = typeof a.weeklyIncome === "number" && Number.isFinite(a.weeklyIncome) ? a.weeklyIncome : -Infinity;
          const bv = typeof b.weeklyIncome === "number" && Number.isFinite(b.weeklyIncome) ? b.weeklyIncome : -Infinity;
          return bv - av;
        });
        ownRankIndex = companies.findIndex(c => {
          const id = c.companyId ?? c.company_id ?? c.id;
          return id !== null && id !== undefined && ownIdCandidates.includes(String(id));
        });
        if (ownRankIndex < 0 && ownNameKey !== "your company") {
          ownRankIndex = companies.findIndex(c => safeText(c.companyName || c.company_name || c.name || "", 90).trim().toLocaleLowerCase() === ownNameKey);
        }
      }
      // Global ranking output is scoped to the exact company type ID when available.
      // This keeps ranks and nearby companies comparable, instead of mixing unrelated company types.
      const typeIdOf = c => c.companyTypeId ?? c.company_type_id ?? c.type_id ?? c.typeId ?? null;
      const typeNameKey = String(ownType || "").trim().toLocaleLowerCase();
      const rankingCompanies = companies.filter(c => {
        const rowTypeId = typeIdOf(c);
        if (ownTypeId !== null && ownTypeId !== undefined) return rowTypeId !== null && rowTypeId !== undefined && String(rowTypeId) === String(ownTypeId);
        return String(c.companyType || c.company_type || "").trim().toLocaleLowerCase() === typeNameKey;
      });
      ownRankIndex = rankingCompanies.findIndex(c => {
        const id = c.companyId ?? c.company_id ?? c.id;
        return id !== null && id !== undefined && ownIdCandidates.includes(String(id));
      });
      if (ownRankIndex < 0 && ownNameKey !== "your company") {
        ownRankIndex = rankingCompanies.findIndex(c => safeText(c.companyName || c.company_name || c.name || "", 90).trim().toLocaleLowerCase() === ownNameKey);
      }
      if (ownRankIndex < 0) {
        const virtual = { companyId: ownId, companyName: ownName, companyType: ownType, companyTypeId: ownTypeId, starRating: ownRating, weeklyIncome: ownIncome, dailyIncome: typeof ownIncomeRoot.daily === "number" ? ownIncomeRoot.daily : null, _ownOnly: true };
        const insertion = typeof ownIncome === "number" ? rankingCompanies.findIndex(c => !(typeof c.weeklyIncome === "number") || c.weeklyIncome < ownIncome) : -1;
        ownRankIndex = insertion >= 0 ? insertion : rankingCompanies.length;
        if (insertion >= 0) rankingCompanies.splice(insertion, 0, virtual); else rankingCompanies.push(virtual);
      }
      const aroundStart = Math.max(0, ownRankIndex - 6);
      const aroundEnd = Math.min(rankingCompanies.length, ownRankIndex + 1 + 4);
      const nearby = rankingCompanies.slice(aroundStart, aroundEnd);
      const lines = nearby.map((company, index) => {
        const rank = aroundStart + index + 1;
        const isOwn = (company.companyId ?? company.company_id ?? company.id) !== null &&
          (company.companyId ?? company.company_id ?? company.id) !== undefined
          ? ownIdCandidates.includes(String(company.companyId ?? company.company_id ?? company.id))
          : safeText(company.companyName || company.company_name || company.name || "", 90).trim().toLocaleLowerCase() === ownNameKey;
        const stars = typeof company.starRating === "number" && Number.isFinite(company.starRating) ? company.starRating + " stars" : "stars not reported";
        const name = safeText(company.companyName || company.company_name || company.name || "Company", 80);
        return (isOwn ? "➡️ " : "") + "**#" + rank + " " + name + "** (" + safeText(company.companyType || ownType || "Unknown type", 40) + ")  |  " + stars + "\n   Weekly income: " + money(company.weeklyIncome) + (isOwn ? "  ← your company" : "");
      });
      const currentIncome = typeof ownIncome === "number" ? ownIncome : null;
      const currentStars = typeof ownRating === "number" ? ownRating : null;
      const sameType = rankingCompanies.filter(c => typeof c.weeklyIncome === "number" && Number.isFinite(c.weeklyIncome) && typeof c.starRating === "number" && Number.isFinite(c.starRating) && !c._ownOnly);
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
      const rankLabel = rankingCompanies[ownRankIndex]?._ownOnly ? "estimated slot among " + rankingCompanies.length + " Type #" + String(ownTypeId ?? ownType) + " companies" : "rank #" + (ownRankIndex + 1) + " of " + rankingCompanies.length + " Type #" + String(ownTypeId ?? ownType) + " companies";
      const incomeFreshnessNote = liveWeeklyIncome !== null
        ? "\nYour income uses the latest company profile; other companies use the global snapshot, so your same-type position is estimated against that snapshot."
        : "\nYour position is based on the saved global snapshot, filtered to your company type.";
      const snapshotTime = Date.parse(generatedAt);
      const staleSnapshotNote = Number.isFinite(snapshotTime) && Date.now() - snapshotTime > 36 * 3600000
        ? "\n⚠️ This ranking snapshot is over 36 hours old. The dashboard refreshes its shared ranking cache on its normal schedule/on-demand stale-cache path; no extra historical snapshot was created by this command."
        : "";
      return chunkedPrivateReply("**Global company rankings by company type**\nYour company: " + ownName + "  |  " + rankLabel + "  |  Weekly income: " + money(currentIncome) +
        "\nSnapshot: " + generatedAt + " (" + snapshotAgeLabel(generatedAt) + ")\nNearby ranks: 6 above and 4 below, within your company type." + incomeFreshnessNote + staleSnapshotNote, [
          ...lines,
          "\n**Observed same-type star-income benchmarks**",
          ...benchmarks,
          "Note: these compare companies in the latest global snapshot; they are not guaranteed official Torn star thresholds."
        ]);
    } catch { return privateReply("Company rankings are temporarily unavailable. Please try again later."); }
  }
  if (name === "company" && commandOptions(i).group === "alerts") {
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
      if (subcommand === "recent") {
        const requestedLimit = Number(optionValue(i, "limit") || 8);
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(10, requestedLimit)) : 8;
        const requestedId = requestedCompanyId(i);
        let selectedCompanyName = "";
        if (requestedId) {
          const companiesRes = await dashboardFetch(env, "/api/me/companies", { headers, signal: AbortSignal.timeout(8000) });
          if (companiesRes.status === 401 || companiesRes.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
          if (!companiesRes.ok) return privateReply("Company data is temporarily unavailable. Please try again later.");
          const companiesData = await companiesRes.json();
          const companies = Array.isArray(companiesData.companies) ? companiesData.companies : [];
          const selected = companies.find(company => String(company.company_id) === requestedId);
          if (!selected) return privateReply("That company ID is not connected to your dashboard account.");
          selectedCompanyName = safeText(selected.company_name || "Selected company", 90);
        }
        const res = await dashboardFetch(env, "/api/me/alerts?limit=100", { headers, signal: AbortSignal.timeout(8000) });
        if (res.status === 401 || res.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
        if (!res.ok) return privateReply("Recent alerts are temporarily unavailable. Please try again later.");
        const data = await res.json();
        const allEvents = Array.isArray(data.events) ? data.events : [];
        const events = allEvents.filter(event => !requestedId || String(event.companyId || "") === requestedId).slice(0, limit);
        if (!events.length) return privateReply("No recent dashboard alerts were found" + (selectedCompanyName ? " for " + selectedCompanyName : " for your account") + ".");
        const lines = events.map(event =>
          "- [" + safeText(String(event.severity || "info").toUpperCase(), 10) + "] **" + safeText(event.title || "Dashboard alert", 120) + "**" +
          " (" + safeText(event.status || "unread", 20) + ")\n  " + safeText(event.message || "No details supplied", 220) +
          "\n  Company: " + safeText(event.companyName || event.companyId || "Not specified", 70) +
          "\n  " + safeText(event.createdAt || "Time unavailable", 50));
        return chunkedPrivateReply("**Recent dashboard alerts" + (selectedCompanyName ? " | " + selectedCompanyName : "") + "** | Showing " + events.length + " event(s)\nUse /company alerts acknowledge and select an active alert from the autocomplete suggestions. The selector shows severity, title, company, and time; acknowledged alerts are excluded.", lines);
      }
      if (subcommand === "acknowledge") {
        const eventId = String(optionValue(i, "alert") || "").trim();
        if (!/^[a-f0-9-]{36}$/i.test(eventId)) return privateReply("Choose an active alert from the autocomplete suggestions. Only unacknowledged alerts are selectable.");
        const response = await dashboardFetch(env, "/api/me/alerts/" + encodeURIComponent(eventId) + "/acknowledge", {
          method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
          signal: AbortSignal.timeout(8000)
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
        if (!response.ok) return privateReply(String(result.error || "The selected alert could not be acknowledged. It may already be acknowledged; refresh recent alerts and choose it again."));
        return privateReply("✅ Alert acknowledged. Only the linked dashboard account’s own alert record was changed.");
      }
      if (subcommand !== "status") return privateReply("Choose /company alerts recent, enable, disable, status, or acknowledge.");
      const linkRes = await dashboardFetch(env, linkPath, { headers, signal: AbortSignal.timeout(8000) });
      if (linkRes.status === 401 || linkRes.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      const linkData = linkRes.ok ? await linkRes.json() : {};
      const last = await env.BOT_DB.prepare("SELECT status, attempts, updated_at AS updatedAt FROM discord_alert_deliveries WHERE discord_user_id=? ORDER BY updated_at DESC LIMIT 1").bind(user).first();
      const lines = [
        "Dashboard link: **" + (linkData.linked ? "connected" : "not confirmed") + "**",
        "Private Discord DMs: **" + (linkData.alertsEnabled ? "enabled" : "disabled") + "**",
        "Most recent private delivery: **" + (last ? String(last.status) + " (attempts " + String(last.attempts) + ", " + String(last.updatedAt) + ")" : "no delivery records") + "**"
      ];
      return privateReply("**Private Discord delivery status**\n" + lines.join("\n") + "\nUse /automation notifications status to inspect severity and quiet hours; manage alert rules and notification preferences in the dashboard.");
    } catch { return privateReply("Alert settings are temporarily unavailable. Please try again later."); }
  }
  if (name === "automation" && ["notifications", "webhook"].includes(commandOptions(i).group)) {
    const route = commandOptions(i);
    const groupName = route.group;
    const subcommand = route.subcommand;
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const jsonHeaders = { ...headers, "content-type": "application/json" };
      const apiError = async response => {
        const body = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) return "Your dashboard session expired or access changed. Run /link to reconnect.";
        return String(body.error || "The automation request could not be completed. Please try again later.");
      };
      const getPreferences = async () => {
        const response = await dashboardFetch(env, "/api/me/automation-preferences", { headers, signal: AbortSignal.timeout(8000) });
        if (!response.ok) return { response, preferences: {} };
        const data = await response.json();
        return { response, preferences: data && typeof data.preferences === "object" ? data.preferences : {} };
      };
      if (groupName === "notifications") {
        if (subcommand !== "status") {
          return privateReply("Alert rules and notification preferences are managed in the dashboard. Use /automation notifications status to inspect current preferences.");
        }
        const { response, preferences: prefs } = await getPreferences();
        if (!response.ok) return privateReply(await apiError(response));
        const webhookRes = await dashboardFetch(env, "/api/me/automation-webhook", { headers, signal: AbortSignal.timeout(8000) });
        const webhook = webhookRes.ok ? await webhookRes.json() : {};
        const quiet = prefs.quietHoursEnabled === true || Number(prefs.quietHoursEnabled) === 1;
        const lines = [
          "Minimum severity: **" + String(prefs.minimumSeverity || "info") + "**",
          "Quiet hours: **" + (quiet ? "on" : "off") + "** · " + String(prefs.quietHoursStart || "22:00") + "–" + String(prefs.quietHoursEnd || "08:00") + " · " + String(prefs.timezone || "UTC"),
          "External webhook: **" + (webhook.configured ? "configured" : "not configured") + "**",
          "External webhook digest mode: **" + String(prefs.digestMode || "instant") + "**"
        ];
        return privateReply("**Your automation notification preferences**\n" + lines.join("\n") + "\nEdit alert rules and notification preferences in the dashboard. Manage private Discord DM enablement and delivery status under /company alerts.");
      }
      if (groupName === "webhook") {
        if (subcommand === "delete") {
          const response = await dashboardFetch(env, "/api/me/automation-webhook", { method: "DELETE", headers, signal: AbortSignal.timeout(8000) });
          if (!response.ok) return privateReply(await apiError(response));
          const preferenceResponse = await dashboardFetch(env, "/api/me/automation-preferences", {
            method: "POST", headers: jsonHeaders, body: JSON.stringify({ digestMode: "off" }), signal: AbortSignal.timeout(8000)
          });
          if (!preferenceResponse.ok) {
            return privateReply("✅ External webhook endpoint removed. Private Discord DMs are unchanged. The webhook digest preference could not be changed, so set it to off in the dashboard automation settings.");
          }
          return privateReply("✅ **External webhook removed.** Its saved endpoint was deleted and external webhook digest mode is now off. Private Discord DMs are separate and were not changed.");
        }
        if (subcommand === "status") {
          const response = await dashboardFetch(env, "/api/me/automation-webhook", { headers, signal: AbortSignal.timeout(8000) });
          if (!response.ok) return privateReply(await apiError(response));
          const data = await response.json(), hook = data.webhook && typeof data.webhook === "object" ? data.webhook : null;
          const lines = [
            "Configured: **" + (data.configured ? "yes" : "no") + "**",
            "Delivery: **" + (hook?.enabled ? "enabled" : data.configured ? "disabled" : "not configured") + "**",
            "Last delivered: **" + String(hook?.lastDeliveredAt || "not yet") + "**"
          ];
          if (hook?.lastError) lines.push("Last error: " + safeText(hook.lastError, 220));
          return privateReply("**External webhook status**\\n" + lines.join("\\n") + "\\nThis is separate from private Discord DMs. The encrypted endpoint URL is never shown in Discord. Use /automation webhook delete to remove this endpoint and turn webhook digests off.");
        }
        if (subcommand === "deliveries") {
          const response = await dashboardFetch(env, "/api/me/automation-webhook/deliveries?limit=10", { headers, signal: AbortSignal.timeout(8000) });
          if (!response.ok) return privateReply(await apiError(response));
          const data = await response.json(), deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
          if (!deliveries.length) return privateReply("No webhook delivery attempts are recorded yet.");
          const lines = deliveries.map(delivery =>
            "- **" + safeText(String(delivery.status || "unknown").toUpperCase(), 15) + "** · " +
            safeText(delivery.createdAt || "time unavailable", 40) + " · HTTP " + String(delivery.statusCode ?? "—") +
            "\n  " + safeText(delivery.detail || "No delivery detail recorded.", 180));
          return chunkedPrivateReply("**Recent webhook deliveries** | " + deliveries.length + " attempt(s)\nUse /automation webhook retry and select a failed attempt to retry it.", lines);
        }
        if (subcommand === "retry") {
          const eventId = String(optionValue(i, "delivery") || "").trim();
          if (!/^[a-f0-9-]{36}$/i.test(eventId)) return privateReply("Choose a failed webhook attempt from the autocomplete selector. The event ID is handled automatically.");
          const response = await dashboardFetch(env, "/api/me/automation-webhook/retry/" + encodeURIComponent(eventId), { method: "POST", headers: jsonHeaders, body: "{}", signal: AbortSignal.timeout(12000) });
          const data = await response.json().catch(() => ({}));
          if (!response.ok && !data.delivery) {
            if (response.status === 401 || response.status === 403) return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
            return privateReply(String(data.error || "The webhook delivery could not be retried."));
          }
          const delivery = data.delivery || {};
          const resultLine = delivery.delivered ? "✅ Webhook delivery succeeded." :
            delivery.attempted ? "⚠️ Webhook retry failed." : "ℹ️ No request was sent.";
          return privateReply(resultLine + (delivery.statusCode ? " HTTP " + delivery.statusCode + "." : "") +
            (delivery.detail ? " " + safeText(delivery.detail, 300) : ""));
        }
        return privateReply("Choose /automation webhook status, deliveries, retry, or delete.");
      }
      return privateReply("Choose a valid /automation command group and subcommand.");
    } catch {
      return privateReply("Automation settings are temporarily unavailable. Please try again later.");
    }
  }
    if (name === "dashboard" && ["health", "summary"].includes(commandOptions(i).subcommand)) {
    const subcommand = commandOptions(i).subcommand;
    const row = await env.BOT_DB.prepare("SELECT encrypted_session_token, token_iv FROM discord_links WHERE discord_user_id=?1").bind(user).first();
    if (!row) return privateReply("Link your dashboard first with /link.");
    try {
      const token = await unseal(row.encrypted_session_token, row.token_iv, env);
      const headers = { authorization: "Bearer " + token, accept: "application/json" };
      const healthRes = await dashboardFetch(env, "/api/me/health", { headers, signal: AbortSignal.timeout(8000) });
      if (healthRes.status === 401 || healthRes.status === 403) {
        await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run();
        return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      }
      if (!healthRes.ok) return privateReply("Dashboard health data is temporarily unavailable. Please try again later.");
      const health = await healthRes.json();
      const summary = health.summary && typeof health.summary === "object" ? health.summary : {};
      const workerStatus = health.worker && typeof health.worker.status === "string" ? health.worker.status : "unknown";
      const databaseStatus = health.database && typeof health.database.status === "string" ? health.database.status : "unknown";
      const latency = value => typeof value === "number" && Number.isFinite(value) ? value + " ms" : "not reported";
      const snapshotTime = value => typeof value === "string" && value ? value : "not available";
      const companyRows = Array.isArray(health.companies) ? health.companies : [];
      const freshnessLabel = value => ({ fresh: "fresh", stale: "stale", never: "never synced", unknown: "unknown" }[String(value || "").toLowerCase()] || "unknown");
      if (subcommand === "health") {
        const lines = [
          "Dashboard Worker: **" + safeText(workerStatus, 30) + "** (latency " + latency(health.worker?.latencyMs) + ")",
          "Database: **" + safeText(databaseStatus, 30) + "** (latency " + latency(health.database?.latencyMs) + ")",
          "Connected companies: **" + Number(summary.companyCount || 0) + "**",
          "Saved snapshots: **" + Number(summary.snapshotCount || 0).toLocaleString("en-US") + "**",
          "Stale or never-synced companies: **" + Number(summary.staleCompanies || 0) + "**",
          "Latest saved snapshot: " + snapshotTime(summary.latestSnapshotAt),
          "Checked at: " + snapshotTime(health.checkedAt)
        ];
        for (const company of companyRows.slice(0, 10)) {
          const age = typeof company.ageHours === "number" && Number.isFinite(company.ageHours)
            ? " · " + (company.ageHours < 1 ? "under 1 hour" : Math.floor(company.ageHours) + "h old")
            : "";
          lines.push("- **" + safeText(company.companyName || "Company", 70) + "**: " + freshnessLabel(company.freshness) +
            age + " · " + Number(company.snapshotCount || 0) + " snapshot(s)");
        }
        if (companyRows.length > 10) lines.push("Showing 10 of " + companyRows.length + " companies returned by the health endpoint.");
        if (health.error) lines.push("Health note: " + safeText(health.error, 180));
        return chunkedPrivateReply("**Dashboard health & data freshness**", lines);
      }

      const alertsRes = await dashboardFetch(env, "/api/me/alerts?limit=10", { headers, signal: AbortSignal.timeout(8000) });
      if (alertsRes.status === 401 || alertsRes.status === 403) {
        await env.BOT_DB.prepare("DELETE FROM discord_links WHERE discord_user_id=?1").bind(user).run();
        return privateReply("Your dashboard session expired or access changed. Run /link to reconnect.");
      }
      if (!alertsRes.ok) return privateReply("Dashboard summary is partially unavailable because recent alert data could not be loaded.");
      const alertData = await alertsRes.json();
      const events = Array.isArray(alertData.events) ? alertData.events : [];
      const unreadCount = typeof alertData.unreadCount === "number" && Number.isFinite(alertData.unreadCount)
        ? alertData.unreadCount
        : events.filter(event => String(event.status || "").toLowerCase() === "unread").length;
      const latestRun = alertData.latestRun && typeof alertData.latestRun === "object" ? alertData.latestRun : {};
      const summaryTime = value => {
        const timestamp = Date.parse(value || "");
        if (!Number.isFinite(timestamp)) return "time unavailable";
        return new Intl.DateTimeFormat("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          hour12: false, timeZone: "UTC"
        }).format(new Date(timestamp)) + " UTC";
      };
      const lines = [];
      if (latestRun.status) {
        lines.push("Latest scheduled run (all dashboard users): **" + safeText(latestRun.status, 30) + "**" +
          (latestRun.finishedAt || latestRun.startedAt ? " · " + summaryTime(latestRun.finishedAt || latestRun.startedAt) : ""));
        if (typeof latestRun.companiesChecked === "number") {
          lines.push("Run results (all dashboard users): " + latestRun.companiesChecked + " companies checked · failures: " +
            Number(latestRun.companiesFailed || 0) + " · alerts created: " + Number(latestRun.alertsCreated || 0));
        }
      } else {
        lines.push("Latest scheduled run (all dashboard users): not recorded yet");
      }
      lines.push("Unread dashboard alerts (your account): **" + unreadCount + "**");
      const staleCount = Number(summary.staleCompanies || 0);
      const companyCount = Number(summary.companyCount || 0);
      const snapshotCount = Number(summary.snapshotCount || 0);
      lines.push("Snapshot coverage (your account): " + companyCount + " connected " + (companyCount === 1 ? "company" : "companies") +
        " · " + snapshotCount.toLocaleString("en-US") + " saved snapshots · " + staleCount + " stale/unsynced");
      const staleNames = companyRows.filter(company => ["stale", "never"].includes(String(company.freshness || "").toLowerCase()))
        .slice(0, 5).map(company => safeText(company.companyName || "Company", 70));
      if (staleNames.length) lines.push("Needs attention (your companies): " + staleNames.join(", "));
      if (health.error) lines.push("Health note: " + safeText(health.error, 180));
      return chunkedPrivateReply("**Dashboard executive summary**", lines);
    } catch { return privateReply("Dashboard status is temporarily unavailable. Please try again later."); }
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
    } catch {
      if (interaction?.type === 4) return json({ type: 8, data: { choices: [] } });
      return json({ type: 4, data: { content: "The request could not be completed. Please try again later.", flags: 64 } });
    }
  }
};
