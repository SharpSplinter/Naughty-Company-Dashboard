import { assertProductionHealth } from "./production-health.mjs";

const defaultEndpoint = "https://naughty-company-bot.kboone801.workers.dev";
const configuredEndpoint = process.env.DISCORD_INTERACTIONS_ENDPOINT || defaultEndpoint;
let healthUrl;
try {
  healthUrl = new URL("/health", configuredEndpoint);
} catch {
  throw new Error("DISCORD_INTERACTIONS_ENDPOINT must be a valid HTTPS URL.");
}
if (healthUrl.protocol !== "https:") {
  throw new Error("DISCORD_INTERACTIONS_ENDPOINT must be a valid HTTPS URL.");
}

let response;
try {
  response = await fetch(healthUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000)
  });
} catch {
  throw new Error("Production health endpoint could not be reached within five seconds.");
}

let payload;
try {
  payload = await response.json();
} catch {
  throw new Error("Production health endpoint did not return valid JSON.");
}

assertProductionHealth({
  status: response.status,
  contentType: response.headers.get("content-type"),
  payload
});

console.log("PASS production Worker smoke check: HTTP 200, expected service identity, and all required configuration flags verified.");
