import { commands } from "./command-schema.mjs";

const APP_ID = process.env.DISCORD_APP_ID || "1558700958983389254";
const GUILD_ID = process.env.DISCORD_GUILD_ID || "1525623497999515770";
const DEPRECATED_ROOT_ALIASES = new Set(["overview", "employees", "trends", "alerts", "rankings"]);
// Flat aliases from earlier command layouts must be removed after nested roots are synced.
const LEGACY_FLAT_ROOT_ALIASES = new Set([
  "bot-status",
  "dashboard-health",
  "dashboard-summary",
  "automation-rules-list",
  "automation-rules-create",
  "automation-rules-enable",
  "automation-rules-disable",
  "automation-rules-delete",
  "automation-notifications-status",
  "automation-notifications-configure",
  "automation-webhook-status",
  "automation-webhook-deliveries",
  "automation-webhook-retry",
  "automation-webhook-delete",
  "company-list",
  "company-overview",
  "company-income",
  "company-profit",
  "company-stars",
  "company-ads",
  "company-stock",
  "company-employees",
  "company-wages",
  "company-trends",
  "company-alerts",
  "company-alerts-recent",
  "company-alerts-enable",
  "company-alerts-disable",
  "company-alerts-configure",
  "company-alerts-status",
  "company-alerts-settings",
  "company-alerts-acknowledge",
  "company-alerts-rules",
  "company-rankings",
  "company-rankings-companies",
  "company-rankings-company",
  "company-rankings-compare",
  "company-rankings-global",
  "company-rankings-faction"
]);
function isLegacyFlatRootName(name) {
  return typeof name === "string" &&
    (LEGACY_FLAT_ROOT_ALIASES.has(name) || /^(?:company|automation|dashboard|bot)[-_]/.test(name));
}
function optionTreeShape(options) {
  return (Array.isArray(options) ? options : []).map(option => {
    const shaped = { name: option.name, type: option.type };
    const children = optionTreeShape(option.options);
    if (children.length) shaped.options = children;
    return shaped;
  });
}
const TOKEN = (process.env.DISCORD_TOKEN || "").replace(/^Bot\s+/i, "").trim();

if (!TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in GitHub Actions secrets. Add it as a repository Actions secret; the Cloudflare Worker secret is not automatically available to GitHub Actions.");
}

const base = "https://discord.com/api/v10/applications/" + APP_ID + "/guilds/" + GUILD_ID + "/commands";
const headers = {
  authorization: "Bot " + TOKEN,
  "content-type": "application/json",
  "user-agent": "NaughtyCompanyDashboardCommandSync/1.0"
};

async function request(url, method, body) {
  // Discord applies per-route limits to guild command updates. Retry explicit 429
  // responses using Discord's retry_after value so a longer command set can sync
  // without leaving registration half-complete after a temporary rate limit.
  const maxRateLimitRetries = 8;
  for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const responseText = await response.text();
    let data;
    try { data = responseText ? JSON.parse(responseText) : null; } catch { data = responseText; }
    if (response.status === 429 && attempt < maxRateLimitRetries) {
      const retryAfter = Number(data && typeof data === "object" ? data.retry_after : undefined) ||
        Number(response.headers.get("retry-after")) || 1;
      const delayMs = Math.max(250, Math.ceil((retryAfter + 0.25) * 1000));
      console.warn("Discord rate limited guild command sync; retrying after " + (delayMs / 1000).toFixed(2) + " seconds.");
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) {
      throw new Error("Discord API " + method + " " + response.status + ": " + JSON.stringify(data).slice(0, 1000));
    }
    return data;
  }
  throw new Error("Discord guild command sync exceeded its rate-limit retry budget.");
}

const existing = await request(base, "GET");
if (!Array.isArray(existing)) throw new Error("Discord returned an unexpected guild-command list.");

if (process.argv.includes("--check-token")) {
  console.log("Discord token is valid for application " + APP_ID + " and guild " + GUILD_ID + "; command-registration endpoint is accessible.");
  process.exit(0);
}

for (const command of commands) {
  const current = existing.find(item => item.name === command.name && (item.type === undefined || item.type === 1));
  if (current && current.id) {
    await request(base + "/" + current.id, "PATCH", command);
    console.log("Updated guild command /" + command.name);
  } else {
    await request(base, "POST", command);
    console.log("Created guild command /" + command.name);
  }
}

// Remove only known legacy aliases and flattened forms of nested bot commands. Other guild commands are left untouched.
for (const stale of existing) {
  if ((!DEPRECATED_ROOT_ALIASES.has(stale.name) && !isLegacyFlatRootName(stale.name)) ||
      (stale.type !== undefined && stale.type !== 1) || !stale.id) continue;
  await request(base + "/" + stale.id, "DELETE");
  console.log("Removed obsolete guild command /" + stale.name);
}
const registeredAfterSync = await request(base, "GET");
if (!Array.isArray(registeredAfterSync)) throw new Error("Discord returned an unexpected command list after registration.");
const missingOrMismatched = [];
for (const command of commands) {
  const registeredCommand = registeredAfterSync.find(item =>
    item.name === command.name && (item.type === undefined || item.type === 1));
  if (!registeredCommand) {
    missingOrMismatched.push("/" + command.name + " (missing)");
    continue;
  }
  const expectedTree = JSON.stringify(optionTreeShape(command.options));
  const actualTree = JSON.stringify(optionTreeShape(registeredCommand.options));
  if (actualTree !== expectedTree) missingOrMismatched.push("/" + command.name + " (option tree differs)");
}
if (missingOrMismatched.length) {
  throw new Error("Discord command-tree verification failed: " + missingOrMismatched.join(", "));
}
const remainingFlatRoots = registeredAfterSync.filter(item =>
  DEPRECATED_ROOT_ALIASES.has(item.name) || isLegacyFlatRootName(item.name));
if (remainingFlatRoots.length) {
  throw new Error("Obsolete flat command roots remain registered: " + remainingFlatRoots.map(item => "/" + item.name).join(", "));
}
console.log("Verified nested command trees for all " + commands.length + " canonical roots, including /company and /automation.");
console.log("Verified no obsolete flat aliases remain; unrelated commands were preserved.");

