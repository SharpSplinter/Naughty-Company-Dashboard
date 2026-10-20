import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { commands } from "./command-schema.mjs";
import { commandSchemaDifferences } from "./command-schema-contract.mjs";

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

/**
 * Synchronize the owned guild commands against Discord.
 *
 * Dependencies are injectable so this exact orchestration can be covered by
 * deterministic mocked-API tests without credentials, network calls, or sleeps.
 */
export async function registerCommands({
  token = process.env.DISCORD_TOKEN || "",
  appId = APP_ID,
  guildId = GUILD_ID,
  fetchImpl = globalThis.fetch,
  sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)),
  log = message => console.log(message),
  warn = message => console.warn(message),
  checkToken = false
} = {}) {
  const normalizedToken = String(token).trim().replace(/^Bot\s+/i, "").trim();
  if (!normalizedToken) {
    throw new Error("Missing DISCORD_TOKEN in GitHub Actions secrets. Add it as a repository Actions secret; the Cloudflare Worker secret is not automatically available to GitHub Actions.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  const base = "https://discord.com/api/v10/applications/" + appId + "/guilds/" + guildId + "/commands";
  const headers = {
    authorization: "Bot " + normalizedToken,
    "content-type": "application/json",
    "user-agent": "NaughtyCompanyDashboardCommandSync/1.0"
  };

  async function request(url, method, body) {
    // Discord applies per-route limits to guild command updates. Retry explicit
    // 429 responses using Discord's retry_after value so a longer command set can sync
    // without leaving registration half-complete after a temporary rate limit.
    const maxRateLimitRetries = 8;
    for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
      const response = await fetchImpl(url, {
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
        warn("Discord rate limited guild command sync; retrying after " + (delayMs / 1000).toFixed(2) + " seconds.");
        await sleep(delayMs);
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

  if (checkToken) {
    log("Discord token is valid for application " + appId + " and guild " + guildId + "; command-registration endpoint is accessible.");
    return { checkToken: true, registeredCount: existing.length };
  }

  for (const command of commands) {
    const current = existing.find(item => item.name === command.name && (item.type === undefined || item.type === 1));
    if (current && current.id) {
      await request(base + "/" + current.id, "PATCH", command);
      log("Updated guild command /" + command.name);
    } else {
      await request(base, "POST", command);
      log("Created guild command /" + command.name);
    }
  }

  // Remove only known legacy aliases and flattened forms of nested bot commands.
  // Other guild commands, including context-menu commands with the same name, stay untouched.
  for (const stale of existing) {
    if ((!DEPRECATED_ROOT_ALIASES.has(stale.name) && !isLegacyFlatRootName(stale.name)) ||
        (stale.type !== undefined && stale.type !== 1) || !stale.id) continue;
    await request(base + "/" + stale.id, "DELETE");
    log("Removed obsolete guild command /" + stale.name);
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
    const schemaDifferences = commandSchemaDifferences(command, registeredCommand);
    if (schemaDifferences.length) {
      const shown = schemaDifferences.slice(0, 5).join(", ");
      const remainder = schemaDifferences.length > 5 ? ", +" + (schemaDifferences.length - 5) + " more" : "";
      missingOrMismatched.push("/" + command.name + " (schema differs: " + shown + remainder + ")");
    }
  }
  if (missingOrMismatched.length) {
    throw new Error("Discord command-tree verification failed: " + missingOrMismatched.join(", "));
  }
  const remainingFlatRoots = registeredAfterSync.filter(item =>
    (item.type === undefined || item.type === 1) &&
    (DEPRECATED_ROOT_ALIASES.has(item.name) || isLegacyFlatRootName(item.name)));
  if (remainingFlatRoots.length) {
    throw new Error("Obsolete flat command roots remain registered: " + remainingFlatRoots.map(item => "/" + item.name).join(", "));
  }
  log("Verified nested command trees for all " + commands.length + " canonical roots, including /company and /automation.");
  log("Verified no obsolete flat aliases remain; unrelated commands were preserved.");
  return { checkToken: false, registeredCount: commands.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    await registerCommands({ checkToken: process.argv.includes("--check-token") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Command registration failed.");
    process.exitCode = 1;
  }
}
