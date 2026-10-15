const APPLICATION_ID = process.env.DISCORD_APP_ID || "1558700958983389254";
const INTERACTIONS_ENDPOINT = process.env.DISCORD_INTERACTIONS_ENDPOINT || "https://naughty-company-bot.kboone801.workers.dev";
const TOKEN = (process.env.DISCORD_TOKEN || "").replace(/^Bot\s+/i, "").trim();

if (!TOKEN) {
  throw new Error("Missing DISCORD_TOKEN. Add it as a repository Actions secret.");
}
if (!/^https:\/\//i.test(INTERACTIONS_ENDPOINT)) {
  throw new Error("DISCORD_INTERACTIONS_ENDPOINT must be an HTTPS URL.");
}

const headers = {
  authorization: "Bot " + TOKEN,
  "content-type": "application/json",
  "user-agent": "NaughtyCompanyDashboardEndpointSync/1.0"
};

async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    throw new Error("Discord API " + method + " " + response.status + ": " + JSON.stringify(data).slice(0, 1000));
  }
  return data;
}

const api = "https://discord.com/api/v10";
const current = await request("GET", api + "/applications/@me");
if (String(current?.id || "") !== APPLICATION_ID) {
  throw new Error("Discord token belongs to application " + String(current?.id || "unknown") + ", expected " + APPLICATION_ID + ".");
}

const previousEndpoint = current.interactions_endpoint_url || null;
if (previousEndpoint === INTERACTIONS_ENDPOINT) {
  console.log("Discord interactions endpoint already targets the production Worker: " + INTERACTIONS_ENDPOINT);
} else {
  console.log("Updating Discord interactions endpoint from " + String(previousEndpoint || "(not set)") + " to the production Worker.");
  const updated = await request("PATCH", api + "/applications/@me", {
    interactions_endpoint_url: INTERACTIONS_ENDPOINT
  });
  if (updated.interactions_endpoint_url !== INTERACTIONS_ENDPOINT) {
    throw new Error("Discord did not confirm the expected production interactions endpoint.");
  }
  console.log("Discord interactions endpoint now targets production: " + updated.interactions_endpoint_url);
}
