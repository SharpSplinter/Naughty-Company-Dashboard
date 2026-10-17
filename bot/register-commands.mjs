import { commands } from "./command-schema.mjs";

const APP_ID = process.env.DISCORD_APP_ID || "1558700958983389254";
const GUILD_ID = process.env.DISCORD_GUILD_ID || "1525623497999515770";
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
console.log("Synchronized " + commands.length + " guild commands for application " + APP_ID + " in guild " + GUILD_ID + "; unrelated commands were preserved.");
