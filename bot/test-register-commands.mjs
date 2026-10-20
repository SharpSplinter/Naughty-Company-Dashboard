import assert from "node:assert/strict";
import { commands } from "./command-schema.mjs";
import { registerCommands } from "./register-commands.mjs";

const base = "https://discord.com/api/v10/applications/test-app/guilds/test-guild/commands";
const response = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json", ...headers }
});

function makeHarness({ rateLimitFirstPatch = false, alwaysRateLimit = false, initialCommands } = {}) {
  const initial = structuredClone(initialCommands || [
    { id: "owned-link", type: 1, ...commands.find(command => command.name === "link") },
    { id: "legacy-overview", type: 1, name: "overview", description: "Old flat command" },
    { id: "legacy-bot-status", type: 1, name: "bot-status", description: "Old flat command" },
    { id: "legacy-ranking-global", type: 1, name: "company-rankings-global", description: "Old flat command" },
    { id: "legacy-webhook-delete", type: 1, name: "automation-webhook-delete", description: "Old flat command" },
    { id: "foreign-weather", type: 1, name: "weather", description: "Owned by another integration" },
    // Discord permits a context-menu command to share a name with a slash command.
    { id: "foreign-overview-context", type: 2, name: "overview" }
  ]);
  let registered = structuredClone(initial);
  const calls = [];
  const sleeps = [];
  const warnings = [];
  const logs = [];
  let getCount = 0;
  let idCounter = 0;
  let limitedFirstPatch = false;

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const call = { url: String(url), method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);

    if (method === "GET" && String(url) === base) {
      getCount += 1;
      return response(getCount === 1 ? initial : registered);
    }

    const isPatch = method === "PATCH";
    const shouldLimit = isPatch && (alwaysRateLimit || (rateLimitFirstPatch && !limitedFirstPatch));
    if (shouldLimit) {
      limitedFirstPatch = true;
      return response({ message: "rate limited", retry_after: 1.5 }, 429, { "retry-after": "1.5" });
    }

    if (method === "PATCH") {
      const id = String(url).split("/").at(-1);
      const index = registered.findIndex(command => command.id === id);
      if (index < 0) return response({ message: "unknown command" }, 404);
      registered[index] = { ...call.body, id, type: call.body.type ?? 1 };
      return response(registered[index]);
    }

    if (method === "POST" && String(url) === base) {
      const created = { ...call.body, id: "created-" + (++idCounter), type: call.body.type ?? 1 };
      registered.push(created);
      return response(created, 201);
    }

    if (method === "DELETE") {
      const id = String(url).split("/").at(-1);
      const index = registered.findIndex(command => command.id === id);
      if (index < 0) return response({ message: "unknown command" }, 404);
      const [deleted] = registered.splice(index, 1);
      return response(deleted);
    }

    return response({ message: "unexpected mock request" }, 500);
  };

  return {
    initial,
    calls,
    sleeps,
    warnings,
    logs,
    get registered() { return registered; },
    fetchImpl,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
    warn: message => warnings.push(message),
    log: message => logs.push(message)
  };
}

const scenario = makeHarness({ rateLimitFirstPatch: true });
const result = await registerCommands({
  token: "  Bot test-token  ",
  appId: "test-app",
  guildId: "test-guild",
  fetchImpl: scenario.fetchImpl,
  sleep: scenario.sleep,
  warn: scenario.warn,
  log: scenario.log
});

assert.deepEqual(result, { checkToken: false, registeredCount: commands.length },
  "a successful sync returns the canonical command count");
assert.equal(scenario.calls[0].method, "GET", "registration must inspect the initial guild command set first");
assert.equal(scenario.calls[0].headers.authorization, "Bot test-token", "the Discord token is normalized into a Bot authorization header");
assert.deepEqual(scenario.sleeps, [1750], "a 429 must use retry_after plus the existing 250ms safety margin");
assert.equal(scenario.warnings.length, 1, "a transient rate limit must be reported once");
assert.equal(scenario.calls.filter(call => call.method === "PATCH" && call.url.endsWith("/owned-link")).length, 2,
  "the rate-limited patch must retry and succeed");
assert.equal(scenario.calls.filter(call => call.method === "POST").length, commands.length - 1,
  "every missing canonical command must be created once");

const deletedIds = scenario.calls.filter(call => call.method === "DELETE").map(call => call.url.split("/").at(-1));
assert.deepEqual(new Set(deletedIds), new Set([
  "legacy-overview",
  "legacy-bot-status",
  "legacy-ranking-global",
  "legacy-webhook-delete"
]), "cleanup must delete only known obsolete chat-input command aliases");
assert.equal(scenario.registered.some(command => command.id === "foreign-weather"), true,
  "an unrelated slash command must be preserved");
assert.equal(scenario.registered.some(command => command.id === "foreign-overview-context"), true,
  "an unrelated context-menu command sharing a deprecated alias name must be preserved");
assert.equal(scenario.registered.some(command => command.id === "legacy-overview"), false,
  "the deprecated chat-input alias must be removed");
assert.equal(scenario.registered.filter(command => command.name === "overview").length, 1,
  "only the unrelated context-menu root named overview should remain");
const registeredCompany = scenario.registered.find(command => command.name === "company" && command.type === 1);
assert.ok(registeredCompany?.options?.some(option => option.name === "overview" && option.type === 1),
  "the canonical /company overview subcommand must remain registered");
assert.equal(scenario.calls.filter(call => call.method === "DELETE").every(call => call.url.startsWith(base + "/")),
  true, "cleanup requests must target only the configured guild command endpoint");
assert.ok(scenario.logs.some(line => line.includes("unrelated commands were preserved")),
  "successful sync must report that unrelated commands were kept");

const checkToken = makeHarness();
const tokenResult = await registerCommands({
  token: "test-token",
  appId: "test-app",
  guildId: "test-guild",
  fetchImpl: checkToken.fetchImpl,
  sleep: checkToken.sleep,
  warn: checkToken.warn,
  log: checkToken.log,
  checkToken: true
});
assert.equal(tokenResult.checkToken, true, "--check-token must stop after confirming the GET endpoint");
assert.equal(checkToken.calls.length, 1, "--check-token must perform no command creates, updates, or deletes");
assert.equal(checkToken.calls[0].method, "GET", "--check-token must remain read-only");

const exhausted = makeHarness({ alwaysRateLimit: true });
await assert.rejects(registerCommands({
  token: "test-token",
  appId: "test-app",
  guildId: "test-guild",
  fetchImpl: exhausted.fetchImpl,
  sleep: exhausted.sleep,
  warn: exhausted.warn,
  log: exhausted.log
}), /Discord API PATCH 429/, "persistent 429 responses must fail instead of hanging indefinitely");
assert.equal(exhausted.calls.filter(call => call.method === "PATCH").length, 9,
  "the rate-limit retry policy must make at most one initial attempt and eight retries");
assert.equal(exhausted.sleeps.length, 8, "the bounded retry path must sleep only between attempts");
assert.equal(exhausted.calls.filter(call => call.method === "POST" || call.method === "DELETE").length, 0,
  "persistent rate limiting must stop before any create or cleanup operations");

await assert.rejects(registerCommands({
  token: "",
  appId: "test-app",
  guildId: "test-guild",
  fetchImpl: async () => { throw new Error("network should not be called"); }
}), /Missing DISCORD_TOKEN/, "missing credentials must fail before making an API request");

console.log("PASS Discord command registration API tests: bounded 429 retry, command creation/update, scoped legacy cleanup, unrelated command preservation, and read-only token check.");
