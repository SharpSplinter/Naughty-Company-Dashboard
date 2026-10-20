import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { commands } from "./command-schema.mjs";
import { parseCommandRoute } from "./command-routing.mjs";
import worker from "./production-worker.js";

const encoder = new TextEncoder();
const encryptionKeyHex = "0".repeat(64);
const uuid = "11111111-1111-4111-8111-111111111111";
const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: "Ed25519" }, true, ["sign", "verify"]
);
const publicKeyHex = [...new Uint8Array(await webcrypto.subtle.exportKey("raw", publicKey))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const hexBytes = value => Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));

async function encryptedSession(token) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey("raw", hexBytes(encryptionKeyHex), "AES-GCM", false, ["encrypt"]);
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token));
  const cipherHex = hex(cipher), ivHex = hex(iv);
  return {
    encrypted_session_token: cipherHex,
    token_iv: ivHex,
    cipher: cipherHex,
    iv: ivHex,
    dashboard_player_id: "player-test",
    updated_at: "2026-10-20T00:00:00.000Z"
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function dashboardFixture(request) {
  const path = request.url.pathname;
  if (path === "/health") return jsonResponse({ ok: true, checkedAt: "2026-10-20T00:00:00.000Z" });
  if (path === "/api/me/companies") {
    return jsonResponse({ companies: [{
      company_id: "company-123",
      company_name: "Dispatch Test Company",
      company_type: "Retail",
      fetched_at: "2026-10-20T00:00:00.000Z"
    }] });
  }
  if (path === "/api/me/companies/company-123/history") {
    return jsonResponse({ history: [], points: [], summary: { snapshotCount: 0 }, latest: {} });
  }
  if (path === "/api/me/companies/company-123") {
    return jsonResponse({
      fetchedAt: "2026-10-20T00:00:00.000Z",
      profile: { company: {
        company_id: "company-123",
        name: "Dispatch Test Company",
        company_rating: 4,
        star_rating: 4,
        income: { daily: 1000, weekly: 7000 },
        profit: { daily: 500, weekly: 3500 },
        employees: 2
      } },
      stock: []
    });
  }
  if (path === "/api/me/member-insights") {
    return jsonResponse({ summary: { knownWageCount: 0, totalKnownWages: 0 }, roster: [] });
  }
  if (path === "/api/me/discord-link") {
    return jsonResponse({ linked: true, alertsEnabled: true, enabled: true });
  }
  if (path === "/api/me/automation-preferences") {
    return jsonResponse({ preferences: { quietHoursEnabled: false, minimumSeverity: "info" } });
  }
  if (path === "/api/me/automation-webhook/deliveries") {
    return jsonResponse({ deliveries: [] });
  }
  if (path.startsWith("/api/me/automation-webhook/retry/")) {
    return jsonResponse({ delivery: { attempted: false, delivered: false } });
  }
  if (path === "/api/me/automation-webhook") {
    return jsonResponse({ configured: false, enabled: false, delivery: null });
  }
  if (path === "/api/me/alerts") {
    return jsonResponse({
      events: [], unreadCount: 0, summary: { companyCount: 1, snapshotCount: 0, staleCompanies: 0 },
      companies: [], latestRun: { status: "success", startedAt: "2026-10-20T00:00:00.000Z", companiesChecked: 1 }
    });
  }
  if (path === "/api/rankings") {
    return jsonResponse({
      generatedAt: "2026-10-20T00:00:00.000Z",
      companies: [{
        companyId: "company-123", company_id: "company-123",
        companyName: "Dispatch Test Company", companyType: "Retail", typeId: 1,
        weeklyIncome: 7000, dailyIncome: 1000, starRating: 4
      }]
    });
  }
  if (path === "/api/faction/directors") return jsonResponse({ directors: [] });
  return jsonResponse({});
}

function fakeDatabase(linkedRow) {
  const runs = [];
  const firstCalls = [];
  return {
    runs, firstCalls,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          runs.push({ sql, values: [...values] });
          return { success: true };
        },
        async first() {
          firstCalls.push({ sql, values: [...values] });
          if (linkedRow && /FROM discord_links/.test(sql)) return linkedRow;
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };
}

async function signRequest(interaction) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(interaction);
  const signature = await webcrypto.subtle.sign(
    { name: "Ed25519" }, privateKey, encoder.encode(timestamp + body)
  );
  return new Request("https://worker.example/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": hex(signature),
      "x-signature-timestamp": timestamp
    },
    body
  });
}

async function invoke(interaction, { linkedRow = null, dashboardHandler = dashboardFixture } = {}) {
  const oldFetch = globalThis.fetch;
  const discordRequests = [];
  const dashboardRequests = [];
  const db = fakeDatabase(linkedRow);
  globalThis.fetch = async (input, init = {}) => {
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    discordRequests.push({ url: String(input), method: init.method || "GET", body });
    return new Response(null, { status: 204 });
  };
  const env = {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    BOT_ENCRYPTION_KEY: encryptionKeyHex,
    DISCORD_TOKEN: "mock-discord-token",
    BOT_DB: db,
    DASHBOARD_API: {
      async fetch(request) {
        const record = { url: new URL(request.url), method: request.method, headers: request.headers, body: null };
        if (request.method !== "GET" && request.method !== "HEAD") {
          try { record.body = await request.clone().json(); } catch {}
        }
        dashboardRequests.push(record);
        return dashboardHandler(record);
      }
    }
  };
  const pending = [];
  try {
    const request = await signRequest(interaction);
    const response = await worker.fetch(request, env, { waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
    const payload = await response.json();
    await Promise.all(pending);
    return { status: response.status, payload, db, discordRequests, dashboardRequests };
  } finally {
    globalThis.fetch = oldFetch;
  }
}

function sampleValue(option) {
  if (option.type === 3) {
    if (Array.isArray(option.choices) && option.choices.length) return option.choices[0].value;
    if (option.autocomplete) return uuid;
    return "test-value";
  }
  if (option.type === 4) return Number.isInteger(option.min_value) ? option.min_value : 1;
  if (option.type === 10) return Number.isFinite(option.min_value) ? option.min_value : 1;
  if (option.type === 5) return true;
  if (option.type === 6) return "123456789012345678";
  if (option.type === 7) return "123456789012345678";
  if (option.type === 8) return "123456789012345678";
  if (option.type === 9) return "123456789012345678";
  if (option.type === 11) return "https://example.test/file.png";
  throw new Error("No sample option value for " + option.name + " type " + option.type);
}

function requiredOptionValues(options = []) {
  return options.filter(option => option.required === true).map(option => ({
    type: option.type, name: option.name, value: sampleValue(option)
  }));
}

function canonicalLeafRoutes() {
  const routes = [];
  for (const command of commands) {
    const options = command.options || [];
    if (!options.length) {
      routes.push({ label: "/" + command.name, data: { name: command.name } });
      continue;
    }
    for (const option of options) {
      if (option.type === 1) {
        routes.push({
          label: "/" + command.name + " " + option.name,
          data: { name: command.name, options: [{ type: 1, name: option.name, options: requiredOptionValues(option.options || []) }] }
        });
      } else if (option.type === 2) {
        for (const child of option.options || []) {
          routes.push({
            label: "/" + command.name + " " + option.name + " " + child.name,
            data: { name: command.name, options: [{ type: 2, name: option.name, options: [
              { type: 1, name: child.name, options: requiredOptionValues(child.options || []) }
            ] }] }
          });
        }
      } else {
        routes.push({
          label: "/" + command.name,
          data: { name: command.name, options: requiredOptionValues(options) }
        });
      }
    }
  }
  return routes;
}

function finalReplyText(result) {
  if (result.payload.type === 4) return result.payload.data?.content || "";
  if (result.payload.type === 9) return "";
  const edit = result.discordRequests.find(request =>
    request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  return edit?.body?.content || "";
}

test("every canonical slash-command leaf reaches a concrete private handler", async () => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const routes = canonicalLeafRoutes();
  assert.ok(routes.length >= 30, "route matrix should expand the full slash-command tree, not only root commands");
  const missing = [];

  for (const route of routes) {
    const result = await invoke({
      type: 2,
      application_id: "application-test",
      token: "dispatch-" + route.label.replace(/[^a-z0-9]/gi, "-"),
      data: route.data,
      user: { id: "discord-user-test" }
    }, { linkedRow });

    assert.equal(result.status, 200, route.label + " should return an HTTP success callback");
    if (route.label === "/link-code") {
      assert.equal(result.payload.type, 9, route.label + " should open the link-code modal immediately");
      assert.equal(result.payload.data.custom_id, "link_code_submit");
      continue;
    }
    const content = finalReplyText(result);
    assert.ok(content.length > 0, route.label + " should complete with a user-facing reply");
    if (/^That command isn't enabled yet\./i.test(content) || /^Choose \/(?:company|automation|bot)\b/i.test(content) ||
        /^Choose a valid \/automation\b/i.test(content)) {
      missing.push(route.label + " -> " + content.slice(0, 120));
    }
    assert.notEqual(result.payload.type, 8, route.label + " is a command, not an autocomplete interaction");
  }

  assert.deepEqual(missing, [], "canonical routes missing a dedicated dispatch handler: " + missing.join("; "));
});

test("unknown nested subcommands are rejected before link lookup or dashboard API calls", async t => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const badRoutes = [
    {
      label: "company alerts unknown",
      data: { name: "company", options: [{ type: 2, name: "alerts", options: [{ type: 1, name: "unknown" }] }] },
      expected: /Choose \/company alerts/
    },
    {
      label: "company rankings unknown",
      data: { name: "company", options: [{ type: 2, name: "rankings", options: [{ type: 1, name: "unknown" }] }] },
      expected: /Choose \/company rankings/
    },
    {
      label: "automation webhook unknown",
      data: { name: "automation", options: [{ type: 2, name: "webhook", options: [{ type: 1, name: "unknown" }] }] },
      expected: /Choose \/automation webhook/
    },
    {
      label: "automation notifications unknown",
      data: { name: "automation", options: [{ type: 2, name: "notifications", options: [{ type: 1, name: "unknown" }] }] },
      expected: /Choose \/automation notifications/
    }
  ];

  for (const route of badRoutes) {
    await t.test(route.label, async () => {
      const result = await invoke({
        type: 2, application_id: "application-test", token: "invalid-route-token",
        data: route.data, user: { id: "discord-user-test" }
      }, { linkedRow });
      assert.deepEqual(result.payload, { type: 5, data: { flags: 64 } });
      const content = finalReplyText(result);
      assert.match(content, route.expected);
      assert.equal(result.db.firstCalls.length, 0, "an unknown route must not read the invoking account's link");
      assert.equal(result.dashboardRequests.length, 0, "an unknown route must not call the dashboard API");
    });
  }
});

test("autocomplete dispatch returns bounded empty choices for known selectors and unsupported focus targets", async t => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const focusCases = [
    {
      label: "company alert selector",
      data: { name: "company", options: [{ type: 2, name: "alerts", options: [
        { type: 1, name: "acknowledge", options: [{ type: 3, name: "alert", value: "alert", focused: true }] }
      ] }] },
      expectedDashboardPath: "/api/me/alerts"
    },
    {
      label: "automation failed-delivery selector",
      data: { name: "automation", options: [{ type: 2, name: "webhook", options: [
        { type: 1, name: "retry", options: [{ type: 3, name: "delivery", value: "failed", focused: true }] }
      ] }] },
      expectedDashboardPath: "/api/me/automation-webhook/deliveries"
    },
    {
      label: "exhausted private alert selector",
      data: { name: "automation", options: [{ type: 2, name: "notifications", options: [
        { type: 1, name: "retry", options: [{ type: 3, name: "event", value: "failed", focused: true }] }
      ] }] },
      expectedDashboardPath: null
    },
    {
      label: "unsupported selector",
      data: { name: "company", options: [{ type: 1, name: "list", options: [
        { type: 3, name: "not_registered_for_autocomplete", value: "x", focused: true }
      ] }] },
      expectedDashboardPath: null
    }
  ];

  for (const item of focusCases) {
    await t.test(item.label, async () => {
      const result = await invoke({
        type: 4, application_id: "application-test", token: "autocomplete-test-token",
        data: item.data, user: { id: "discord-user-test" }
      }, { linkedRow });
      assert.deepEqual(result.payload, { type: 8, data: { choices: [] } });
      assert.equal(result.db.runs.length, 0, "autocomplete must not initialize the D1 schema");
      if (item.expectedDashboardPath) {
        assert.ok(result.dashboardRequests.some(request => request.url.pathname === item.expectedDashboardPath),
          "known autocomplete selector should query its owner-scoped data");
      } else {
        assert.equal(result.dashboardRequests.length, 0, "unsupported autocomplete fields should not query dashboard data");
      }
      for (const request of result.dashboardRequests) {
        assert.ok(request.url.pathname.startsWith("/api/me/"), "autocomplete calls must stay within account-scoped APIs");
        assert.equal(request.headers.get("authorization"), "Bearer dashboard-session-test");
      }
    });
  }
});

test("command route parser safely ignores malformed route payload shapes", () => {
  const empty = { group: null, subcommand: null, options: [] };
  for (const input of [null, undefined, [], "not-an-interaction", {}, { data: null }, { data: { options: "bad" } }]) {
    assert.deepEqual(parseCommandRoute(input), empty, "malformed payload should not throw or leak malformed options");
  }
  assert.deepEqual(parseCommandRoute({ data: { name: "company", options: [null, 1, "bad"] } }), empty);
  assert.deepEqual(parseCommandRoute({ data: { options: [{ type: 2, name: "alerts", options: [] }] } }),
    { group: "alerts", subcommand: null, options: [] }, "an empty group must be represented as an incomplete route");
  assert.deepEqual(parseCommandRoute({ data: { options: [{ type: 1, name: "list", options: [null, { type: 3, name: "q", value: "test" }] }] } }),
    { group: null, subcommand: "list", options: [{ type: 3, name: "q", value: "test" }] });
});

console.log("PASS Discord command dispatch: canonical route matrix, invalid-route short circuit, autocomplete safety, and malformed parser inputs.");
