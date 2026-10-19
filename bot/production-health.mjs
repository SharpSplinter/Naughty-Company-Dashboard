const REQUIRED_FLAGS = [
  "database",
  "encryption",
  "discordConfigured",
  "dashboardBinding",
  "privateAlertDelivery"
];

export function assertProductionHealth({ status, contentType, payload }) {
  if (status !== 200) {
    throw new Error("Production health endpoint did not return HTTP 200.");
  }
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
    throw new Error("Production health endpoint did not return JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Production health endpoint returned an invalid JSON shape.");
  }
  if (payload.ok !== true || payload.service !== "naughty-company-bot") {
    throw new Error("Production health endpoint identity or status did not match the expected Worker.");
  }
  for (const flag of REQUIRED_FLAGS) {
    if (payload[flag] !== true) {
      throw new Error("Production health check failed required configuration flag: " + flag + ".");
    }
  }
  return true;
}
