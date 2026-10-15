const APP_ID = process.env.DISCORD_APP_ID || "1558700958983389254";
const GUILD_ID = process.env.DISCORD_GUILD_ID || "1525623497999515770";
const TOKEN = (process.env.DISCORD_TOKEN || "").replace(/^Bot\s+/i, "").trim();

const commands = [
  {
    name: "rankings",
    description: "Show global or Naughty Souls faction company rankings",
    options: [
      { type: 1, name: "global", description: "Show your global rank and nearby companies" },
      { type: 1, name: "faction", description: "List faction company directors by weekly income" }
    ]
  },
  {
    name: "employees",
    description: "View the latest employee roster",
    options: [
      {
        type: 1,
        name: "brief",
        description: "Show the compact employee roster",
        options: [{ type: 3, name: "company_id", description: "Optional connected company ID", required: false, max_length: 20 }]
      },
      {
        type: 1,
        name: "full",
        description: "Include addiction, inactivity and last-seen status",
        options: [{ type: 3, name: "company_id", description: "Optional connected company ID", required: false, max_length: 20 }]
      }
    ]
  },
  {
    name: "alerts",
    description: "Enable, disable, configure or inspect private alert DMs",
    options: [
      { type: 1, name: "enable", description: "Enable private Discord alert DMs" },
      { type: 1, name: "disable", description: "Disable private Discord alert DMs" },
      {
        type: 1,
        name: "configure",
        description: "Set minimum severity and quiet hours",
        options: [
          { type: 3, name: "minimum_severity", description: "Lowest severity sent by DM", required: false, choices: [
            { name: "Info and above", value: "info" },
            { name: "Warning and critical only", value: "warning" },
            { name: "Critical only", value: "critical" }
          ]},
          { type: 5, name: "quiet_hours_enabled", description: "Enable or disable quiet hours", required: false },
          { type: 3, name: "quiet_hours_start", description: "Quiet-hours start in 24-hour HH:MM", required: false, min_length: 5, max_length: 5 },
          { type: 3, name: "quiet_hours_end", description: "Quiet-hours end in 24-hour HH:MM", required: false, min_length: 5, max_length: 5 },
          { type: 3, name: "timezone", description: "IANA time zone, e.g. America/New_York", required: false, max_length: 80 }
        ]
      },
      { type: 1, name: "status", description: "Show alert, rule and recent delivery status" }
    ]
  }
];

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
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const responseText = await response.text();
  let data;
  try { data = responseText ? JSON.parse(responseText) : null; } catch { data = responseText; }
  if (!response.ok) {
    throw new Error("Discord API " + method + " " + response.status + ": " + JSON.stringify(data).slice(0, 1000));
  }
  return data;
}

const existing = await request(base, "GET");
if (!Array.isArray(existing)) throw new Error("Discord returned an unexpected guild-command list.");

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
