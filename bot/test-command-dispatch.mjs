import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { commands } from "./command-schema.mjs";
import { parseCommandRoute } from "./command-routing.mjs";
import { previousReportingDay, reportingDayAt } from "./daily-summary.mjs";
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
  if (path === "/api/me/health") return jsonResponse({
    checkedAt: "2026-10-20T00:00:00.000Z",
    worker: { status: "healthy", latencyMs: 1 },
    database: { status: "healthy", latencyMs: 1 },
    summary: { companyCount: 1, snapshotCount: 1, staleCompanies: 0, latestSnapshotAt: "2026-10-20T00:00:00.000Z" },
    companies: []
  });
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

function fakeDatabase(linkedRow, { alertDeliveries = [], pollState = null } = {}) {
  const runs = [];
  const firstCalls = [];
  const storedDeliveries = structuredClone(alertDeliveries);
  const now = "2026-10-20T00:00:00.000Z";
  return {
    runs, firstCalls, storedDeliveries,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          runs.push({ sql, values: [...values] });
          if (sql.startsWith("UPDATE discord_alert_deliveries SET status='failed',attempts=0")) {
            const [updatedAt, userId, eventId] = values;
            const delivery = storedDeliveries.find(item => item.eventId === eventId && item.status === "failed" && Number(item.attempts) >= 3);
            const changed = userId === "discord-user-test" && Boolean(delivery);
            if (changed) {
              delivery.attempts = 0;
              delivery.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: changed ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE discord_alert_deliveries SET status='failed',updated_at=?")) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          firstCalls.push({ sql, values: [...values] });
          if (linkedRow && /FROM discord_links/.test(sql)) return linkedRow;
          if (sql.includes("FROM discord_alert_poll_state")) return pollState;
          if (sql.includes("COUNT(*) AS count") && sql.includes("status='failed'") && sql.includes("attempts>=3")) {
            return { count: storedDeliveries.filter(item => item.status === "failed" && Number(item.attempts) >= 3).length };
          }
          if (sql.includes("COUNT(*) AS count") && sql.includes("status='processing'")) return { count: 0 };
          return null;
        },
        async all() {
          if (sql.includes("FROM discord_alert_deliveries WHERE discord_user_id=?")) {
            return { results: storedDeliveries.filter(item => item.status === "failed" || item.status === "processing").slice(0, 25).map(item => ({
              eventId: item.eventId, status: item.status, attempts: item.attempts, updatedAt: item.updatedAt
            })) };
          }
          return { results: [] };
        }
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

async function invoke(interaction, { linkedRow = null, dashboardHandler = dashboardFixture, dbOptions = {}, dashboardPanelEnabled = true } = {}) {
  const oldFetch = globalThis.fetch;
  const discordRequests = [];
  const dashboardRequests = [];
  const db = fakeDatabase(linkedRow, dbOptions);
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
    DASHBOARD_PANEL_ENABLED: dashboardPanelEnabled ? "true" : "false",
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

test("company overview reports complete financials and only exact consecutive-day stock deltas", async () => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const currentDay = reportingDayAt();
  const priorDay = previousReportingDay(currentDay);
  const dashboardHandler = record => {
    const path = record.url.pathname;
    if (path === "/api/me/companies/company-123") {
      return jsonResponse({
        companyName: "Dispatch Test Company",
        companyType: "Retail",
        fetchedAt: currentDay + "T18:10:00.000Z",
        profile: { company: {
          name: "Dispatch Test Company",
          company_rating: 4,
          income: { daily: 1000, weekly: 7000 },
          profit: { daily: 500, weekly: 3500 },
          advertising_budget: 100,
          company_performance: { popularity: 70, efficiency: 80, environment: 90 }
        } },
        stock: {
          Widget: { name: "Widget", cost: 2, in_stock: 5, on_order: 2, price: 10, rrp: 12 },
          Gadget: { name: "Gadget", cost: 3, in_stock: 3, on_order: 0, price: 20, rrp: 25 }
        }
      });
    }
    if (path === "/api/me/companies/company-123/history") {
      return jsonResponse({ history: [
        { day: priorDay, stockQuantity: 6, fetchedAt: priorDay + "T18:10:00.000Z" },
        { day: currentDay, stockQuantity: 8, fetchedAt: currentDay + "T18:10:00.000Z" }
      ] });
    }
    if (path === "/api/me/member-insights") {
      return jsonResponse({ summary: { rosterCount: 2, knownWageCount: 2, totalKnownWages: 300 }, roster: [] });
    }
    return dashboardFixture(record);
  };
  const result = await invoke({
    type: 2, application_id: "application-test", token: "overview-test-token",
    data: { name: "company", options: [{ type: 1, name: "overview" }] },
    user: { id: "discord-user-test" }
  }, { linkedRow, dashboardHandler });
  const content = finalReplyText(result);
  assert.match(content, /Company rating: 4/);
  assert.match(content, /Daily profit: \$500/);
  assert.match(content, /Advertising budget: \$100/);
  assert.match(content, /Total employee wages: \$300/);
  assert.match(content, /Performance: Popularity 70 \| Efficiency 80 \| Environment 90/);
  assert.match(content, /Total quantity: 8/);
  assert.match(content, /Stock change vs previous reporting day .*: \+2/);
  assert.match(content, /On-hand stock value at listed prices: \$110/);
  assert.match(content, /Widget: 5 x \$10 = \$50/);
  const historyRequest = result.dashboardRequests.find(request => request.url.pathname.endsWith("/history"));
  assert.ok(historyRequest, "overview must use the authenticated history endpoint");
  assert.equal(historyRequest.url.searchParams.get("days"), "7");
  assert.equal(historyRequest.headers.get("authorization"), "Bearer dashboard-session-test");
  assert.ok(result.dashboardRequests.every(request => request.method === "GET"), "overview remains read-only");
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

test("private notification status and exhausted-delivery recovery stay account-scoped", async () => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const pollState = {
    lastStartedAt: "2026-10-20T00:00:00.000Z",
    lastCompletedAt: "2026-10-20T00:00:01.000Z",
    lastSuccessAt: "2026-10-20T00:00:01.000Z",
    lastStatus: "error",
    lastErrorCode: "dashboard_alerts_http_503",
    lastErrorAt: "2026-10-20T00:00:01.000Z",
    consecutiveFailures: 3,
    lastPageCount: 1,
    lastEventsSeen: 100,
    lastDelivered: 0,
    lastFiltered: 0,
    lastFailed: 0,
    lastExhausted: 0,
    lastStaleRecovered: 0
  };
  const eventId = "11111111-1111-4111-8111-111111111111";
  const dbOptions = {
    pollState,
    alertDeliveries: [{ eventId, status: "failed", attempts: 3, updatedAt: "2026-10-20T00:00:01.000Z" }]
  };
  const statusResult = await invoke({
    type: 2, application_id: "application-test", token: "alert-poll-status-token",
    data: { name: "automation", options: [{ type: 2, name: "notifications", options: [{ type: 1, name: "status" }] }] },
    user: { id: "discord-user-test" }
  }, { linkedRow, dbOptions });
  const statusText = finalReplyText(statusResult);
  assert.match(statusText, /dashboard_alerts_http_503/, "status must display a safe, diagnostic error code");
  assert.match(statusText, /Consecutive poll failures: \*\*3\*\*/, "status must make repeated failures visible");
  assert.match(statusText, /Exhausted deliveries needing manual retry: \*\*1\*\*/, "status must surface exhausted delivery count");
  assert.ok(statusResult.db.firstCalls.some(call => call.sql.includes("WHERE discord_user_id=?") && call.values[0] === "discord-user-test"),
    "delivery counts must be scoped to the invoking Discord account");

  const retryResult = await invoke({
    type: 2, application_id: "application-test", token: "alert-poll-retry-token",
    data: { name: "automation", options: [{ type: 2, name: "notifications", options: [
      { type: 1, name: "retry", options: [{ type: 3, name: "event", value: eventId }] }
    ] }] },
    user: { id: "discord-user-test" }
  }, { linkedRow, dbOptions });
  assert.match(finalReplyText(retryResult), /Private alert retry queued/);
  assert.equal(retryResult.db.storedDeliveries[0].attempts, 0, "manual retry should safely reset the exhausted attempt budget");
});

test("private notification retry autocomplete returns only exhausted failed deliveries for the invoking account", async () => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const eventId = "22222222-2222-4222-8222-222222222222";
  const result = await invoke({
    type: 4, application_id: "application-test", token: "alert-poll-autocomplete-token",
    data: { name: "automation", options: [{ type: 2, name: "notifications", options: [
      { type: 1, name: "retry", options: [{ type: 3, name: "event", value: "", focused: true }] }
    ] }] },
    user: { id: "discord-user-test" }
  }, { linkedRow, dbOptions: { alertDeliveries: [{ eventId, status: "failed", attempts: 3, updatedAt: "2026-10-20T00:00:01.000Z" }] } });
  assert.deepEqual(result.payload, { type: 8, data: { choices: [{ name: "Exhausted · 3 attempts · 2026-10-20T00:00:01.000Z", value: eventId }] } });
  assert.equal(result.dashboardRequests.length, 0, "private alert retry autocomplete must not call dashboard APIs");
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

test("private dashboard panel exposes owner-bound navigation and component clicks update the selected read-only view", async () => {
  const linkedRow = await encryptedSession("dashboard-session-test");
  const opened = await invoke({
    type: 2,
    application_id: "application-test",
    token: "dashboard-panel-open-token",
    data: { name: "dashboard", options: [{ type: 1, name: "panel" }] },
    user: { id: "discord-user-test" }
  }, { linkedRow });

  assert.deepEqual(opened.payload, { type: 5, data: { flags: 64 } });
  const original = opened.discordRequests.find(request =>
    request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(original, "the initial panel should replace its private deferred response");
  const rows = original.body.components;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.type === 1 && row.components.length <= 5));
  const buttons = rows.flatMap(row => row.components);
  assert.deepEqual(buttons.map(button => button.label), ["Home", "Company", "Rankings", "Automation", "Alerts", "Trends", "Refresh"]);
  assert.ok(buttons.every(button => button.custom_id.includes("discord-user-test")),
    "every navigation control must bind to the invoking Discord user");
  assert.ok(opened.dashboardRequests.every(request => request.method === "GET"),
    "opening the panel must reuse read-only dashboard handlers");

  const companyButton = buttons.find(button => button.label === "Company");
  const navigated = await invoke({
    type: 3,
    application_id: "application-test",
    token: "dashboard-panel-company-token",
    data: { component_type: 2, custom_id: companyButton.custom_id },
    user: { id: "discord-user-test" }
  }, { linkedRow });

  assert.deepEqual(navigated.payload, { type: 6 }, "navigation should defer the update of the current ephemeral message");
  const updated = navigated.discordRequests.find(request =>
    request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(updated);
  assert.match(updated.body.content, /Company rating: 4/);
  assert.equal(updated.body.components.length, 2, "navigation rows should persist after a view change");
  assert.equal(updated.body.components.flatMap(row => row.components).length, 7, "all views and refresh should remain available after navigation");
  assert.ok(navigated.dashboardRequests.every(request => request.method === "GET"),
    "panel navigation must not trigger a profile refresh or write to dashboard APIs");

  const alertsButton = buttons.find(button => button.label === "Alerts");
  const alerts = await invoke({
    type: 3,
    application_id: "application-test",
    token: "dashboard-panel-alerts-token",
    data: { component_type: 2, custom_id: alertsButton.custom_id },
    user: { id: "discord-user-test" }
  }, { linkedRow });

  assert.deepEqual(alerts.payload, { type: 6 });
  const alertsUpdate = alerts.discordRequests.find(request =>
    request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(alertsUpdate);
  assert.match(alertsUpdate.body.content, /No recent dashboard alerts were found/i);
  assert.equal(alertsUpdate.body.components.length, 2);
  assert.ok(alerts.dashboardRequests.every(request => request.method === "GET"),
    "Alerts view must use the existing account-scoped read-only recent-alerts handler");
  const alertsRequest = alerts.dashboardRequests.find(request => request.url.pathname === "/api/me/alerts");
  assert.ok(alertsRequest);
  assert.equal(alertsRequest.url.searchParams.get("limit"), "100");
  assert.equal(alertsRequest.headers.get("authorization"), "Bearer dashboard-session-test");

  const trendsButton = buttons.find(button => button.label === "Trends");
  const trends = await invoke({
    type: 3,
    application_id: "application-test",
    token: "dashboard-panel-trends-token",
    data: { component_type: 2, custom_id: trendsButton.custom_id },
    user: { id: "discord-user-test" }
  }, { linkedRow });

  assert.deepEqual(trends.payload, { type: 6 });
  const trendsUpdate = trends.discordRequests.find(request =>
    request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(trendsUpdate);
  assert.match(trendsUpdate.body.content, /30-day trend/i);
  assert.equal(trendsUpdate.body.components.length, 2);
  assert.ok(trends.dashboardRequests.every(request => request.method === "GET"),
    "Trends view must reuse only account-scoped read-only handlers");
  const trendsCompaniesRequest = trends.dashboardRequests.find(request => request.url.pathname === "/api/me/companies");
  const trendsHistoryRequest = trends.dashboardRequests.find(request => request.url.pathname === "/api/me/companies/company-123/history");
  assert.ok(trendsCompaniesRequest);
  assert.ok(trendsHistoryRequest);
  assert.equal(trendsHistoryRequest.url.searchParams.get("days"), "30");
  assert.equal(trendsHistoryRequest.headers.get("authorization"), "Bearer dashboard-session-test");

});

test("dashboard panel can be disabled without database or dashboard access while legacy routes stay available", async () => {
  const disabled = await invoke({
    type: 2,
    application_id: "application-test",
    token: "dashboard-panel-disabled",
    data: { name: "dashboard", options: [{ type: 1, name: "panel" }] },
    user: { id: "discord-user-test" }
  }, { dashboardPanelEnabled: false });

  assert.equal(disabled.payload.type, 4);
  assert.equal(disabled.payload.data.flags, 64);
  assert.match(disabled.payload.data.content, /currently disabled/i);
  assert.equal(disabled.db.runs.length, 0, "disabled panel opens must not run DDL or query account data");
  assert.equal(disabled.dashboardRequests.length, 0, "disabled panel opens must not call dashboard APIs");

  const disabledClick = await invoke({
    type: 3,
    application_id: "application-test",
    token: "dashboard-panel-click-disabled",
    data: { component_type: 2, custom_id: "ncdash:v1:discord-user-test:home" },
    user: { id: "discord-user-test" }
  }, { dashboardPanelEnabled: false });

  assert.equal(disabledClick.payload.type, 4);
  assert.match(disabledClick.payload.data.content, /currently disabled/i);
  assert.equal(disabledClick.db.runs.length, 0, "disabled component clicks must fail closed before D1 access");
  assert.equal(disabledClick.discordRequests.length, 0, "disabled component clicks must not update the original panel");

  const legacy = await invoke({
    type: 2,
    application_id: "application-test",
    token: "dashboard-health-still-works",
    data: { name: "dashboard", options: [{ type: 1, name: "health" }] },
    user: { id: "discord-user-test" }
  }, { linkedRow: await encryptedSession("dashboard-session-test"), dashboardPanelEnabled: false });

  assert.deepEqual(legacy.payload, { type: 5, data: { flags: 64 } });
  const legacyEdit = legacy.discordRequests.find(request =>
    request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(legacyEdit);
  assert.match(legacyEdit.body.content, /Dashboard Worker:/, "existing dashboard health command remains available when the panel flag is off");
});

console.log("PASS Discord command dispatch: canonical route matrix, invalid-route short circuit, autocomplete safety, and malformed parser inputs.");
