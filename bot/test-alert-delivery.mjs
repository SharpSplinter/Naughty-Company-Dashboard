import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { webcrypto } from "node:crypto";
import worker from "./production-worker.js";
import { isDuringQuietHours, severityRank } from "./alert-delivery.mjs";
import { previousReportingDay, reportingDayAt } from "./daily-summary.mjs";

const ENCRYPTION_KEY = "0".repeat(64);
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const hexBytes = value => Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));
const accountId = "discord-user-alert-test";
const sessionToken = "dashboard-session-alert-test";
const linkedAt = "2026-10-01T00:00:00.000Z";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function encryptedLink(token = sessionToken) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey("raw", hexBytes(ENCRYPTION_KEY), "AES-GCM", false, ["encrypt"]);
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token));
  return { encrypted_session_token: hex(cipher), token_iv: hex(iv) };
}

function makeFixture({
  now = "2026-10-20T18:25:00.000Z",
  preferences = {},
  preferencesByAccount = {},
  companies,
  historiesByCompany = {},
  rankings,
  dashboardThrowsFor = [],
  dashboardTimeoutFor = [],
  messageFailureCount = 0,
  channelFailureCount = 0,
  seedPreviousSummary = true
} = {}) {
  const reportDay = reportingDayAt(now);
  const priorDay = previousReportingDay(reportDay);
  const defaultCompanies = companies || [{ company_id: "123", company_name: "Example Oil", company_type: "Oil Rig" }];
  const defaultRankings = rankings || [
    { companyId: "123", companyName: "Example Oil", companyType: "Oil Rig", companyTypeId: 28, starRating: 6, weeklyIncome: 1050 },
    { companyId: "ahead", companyName: "Ahead Oil", companyType: "Oil Rig", companyTypeId: 28, starRating: 6, weeklyIncome: 1200 },
    { companyId: "next", companyName: "Next Star Oil", companyType: "Oil Rig", companyTypeId: 28, starRating: 7, weeklyIncome: 1600 }
  ];
  const defaultHistory = [
    { day: priorDay, fetchedAt: priorDay + "T18:10:00.000Z", dailyIncome: 100, dailyProfit: 50, weeklyIncome: 700, rating: 5, stockQuantity: 800 },
    { day: reportDay, fetchedAt: reportDay + "T18:10:00.000Z", dailyIncome: 150, dailyProfit: 70, weeklyIncome: 1050, rating: 6, stockQuantity: 900 }
  ];
  const accountState = new Map([[accountId, { linkedAt }]]);
  const pollStates = new Map();
  const escalations = new Map();
  const dailyDeliveries = new Map();
  const summaryStates = new Map();
  if (seedPreviousSummary) {
    summaryStates.set(accountId + ":123", {
      snapshotDay: priorDay,
      metrics: { dailyIncome: 100, dailyProfit: 50, starLevel: 5, starIncomeGap: 600, companyRank: 4, stockQuantity: 800, weeklyIncome: 700 }
    });
  }

  const dashboardRequests = [];
  const discordRequests = [];
  const pollHealthReports = [];
  let messageAttempts = 0;
  let successfulMessages = 0;
  let channelAttempts = 0;

  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          const lower = sql.toLowerCase();
          if (lower.startsWith("insert into discord_alert_state")) {
            accountState.set(values[0], { linkedAt: values[1] });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.startsWith("insert into discord_alert_poll_state")) {
            const [user, startedAt, updatedAt] = values;
            const prior = pollStates.get(user) || { consecutiveFailures: 0 };
            pollStates.set(user, { ...prior, lastStartedAt: startedAt, lastStatus: "running", updatedAt });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.startsWith("update discord_alert_poll_state set last_completed_at=?")) {
            if (lower.includes("last_status='error'")) {
              const [completedAt, errorCode, errorAt, pages, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, updatedAt, user] = values;
              const prior = pollStates.get(user) || { consecutiveFailures: 0 };
              pollStates.set(user, { ...prior, lastCompletedAt: completedAt, lastStatus: "error", lastErrorCode: errorCode, lastErrorAt: errorAt, consecutiveFailures: Number(prior.consecutiveFailures || 0) + 1, lastPageCount: pages, lastEventsSeen: eventsSeen, lastDelivered: delivered, lastFiltered: filtered, lastFailed: failed, lastExhausted: exhausted, lastStaleRecovered: staleRecovered, updatedAt });
            } else {
              const [completedAt, successStatus, successAt, status, errorCode, , errorAt, pages, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, updatedAt, user] = values;
              const prior = pollStates.get(user) || { consecutiveFailures: 0 };
              pollStates.set(user, { ...prior, lastCompletedAt: completedAt, lastSuccessAt: successAt, lastStatus: status, lastErrorCode: errorCode, lastErrorAt: errorAt, consecutiveFailures: 0, lastPageCount: pages, lastEventsSeen: eventsSeen, lastDelivered: delivered, lastFiltered: filtered, lastFailed: failed, lastExhausted: exhausted, lastStaleRecovered: staleRecovered, updatedAt });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.startsWith("insert into discord_daily_summary_deliveries")) {
            const [user, day, updatedAt, staleBefore] = values;
            const key = user + ":" + day;
            const prior = dailyDeliveries.get(key);
            if (!prior) {
              dailyDeliveries.set(key, { status: "processing", attempts: 1, updatedAt });
              return { success: true, meta: { changes: 1 } };
            }
            const canClaim = prior.status !== "delivered" && Number(prior.attempts || 0) < 3 &&
              (prior.status !== "processing" || prior.updatedAt < staleBefore);
            if (canClaim) dailyDeliveries.set(key, { status: "processing", attempts: Number(prior.attempts || 0) + 1, updatedAt });
            return { success: true, meta: { changes: canClaim ? 1 : 0 } };
          }
          if (lower.startsWith("update discord_daily_summary_deliveries set status=")) {
            const status = lower.includes("status='delivered'") ? "delivered" : "failed";
            const [updatedAt, user, day, attempts] = values;
            const key = user + ":" + day;
            const prior = dailyDeliveries.get(key);
            const changed = prior?.status === "processing" && Number(prior.attempts) === Number(attempts);
            if (changed) dailyDeliveries.set(key, { ...prior, status, updatedAt });
            return { success: true, meta: { changes: changed ? 1 : 0 } };
          }
          if (lower.startsWith("insert into discord_daily_company_summary_state")) {
            const [user, companyId, snapshotDay, metricsJson, updatedAt] = values;
            summaryStates.set(user + ":" + companyId, { snapshotDay, metrics: JSON.parse(metricsJson), updatedAt });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.startsWith("insert into discord_alert_poll_escalations")) {
            const [user, triggeredAt, retryCutoff] = values;
            const key = user + ":poll_failure_streak";
            const prior = escalations.get(key);
            if (!prior) {
              escalations.set(key, { triggeredAt, notificationDelivered: 0 });
              return { success: true, meta: { changes: 1 } };
            }
            if (Number(prior.notificationDelivered || 0) === 0 && prior.triggeredAt < retryCutoff) {
              escalations.set(key, { ...prior, triggeredAt });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (lower.startsWith("update discord_alert_poll_escalations set notification_delivered=1")) {
            const [user] = values;
            const key = user + ":poll_failure_streak";
            const prior = escalations.get(key);
            if (prior) escalations.set(key, { ...prior, notificationDelivered: 1 });
            return { success: true, meta: { changes: prior ? 1 : 0 } };
          }
          if (lower.startsWith("delete from discord_alert_poll_escalations")) {
            const [user] = values;
            const existed = escalations.delete(user + ":poll_failure_streak");
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          const lower = sql.toLowerCase();
          if (lower.includes("select linked_at as linkedat")) return accountState.get(values[0]) || null;
          if (lower.includes("from discord_alert_poll_state")) return pollStates.get(values[0]) || null;
          if (lower.includes("from discord_daily_summary_deliveries") && lower.includes("select status,attempts,updated_at")) return dailyDeliveries.get(values[0] + ":" + values[1]) || null;
          if (lower.includes("from discord_daily_summary_deliveries") && lower.includes("select attempts")) {
            const row = dailyDeliveries.get(values[0] + ":" + values[1]);
            return row ? { attempts: row.attempts } : null;
          }
          if (lower.includes("from discord_daily_company_summary_state")) {
            const row = summaryStates.get(values[0] + ":" + values[1]);
            return row ? { snapshotDay: row.snapshotDay, metricsJson: JSON.stringify(row.metrics) } : null;
          }
          if (lower.includes("select count(*) as count from discord_daily_summary_deliveries")) return { count: 0 };
          if (lower.includes("select consecutive_failures as consecutivefailures")) {
            return pollStates.get(values[0]) || null;
          }
          return null;
        },
        async all() {
          const lower = sql.toLowerCase();
          if (lower.includes("from discord_links")) {
            const row = await encryptedLink();
            return { results: [{ discordUserId: accountId, cipher: row.encrypted_session_token, iv: row.token_iv }] };
          }
          return { results: [] };
        }
      };
    }
  };

  const dashboardApi = {
    async fetch(request) {
      const url = new URL(request.url);
      dashboardRequests.push({ url, method: request.method, headers: request.headers });
      const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const userId = token === sessionToken ? accountId : "unknown-account";
      if (dashboardTimeoutFor.includes(url.pathname)) {
        const error = new Error("simulated dashboard request timeout");
        error.name = "TimeoutError";
        throw error;
      }
      if (dashboardThrowsFor.includes(userId)) return jsonResponse({ error: "simulated dashboard API failure" }, 503);
      if (url.pathname === "/api/me/discord-alert-poll-health" && request.method === "POST") {
        pollHealthReports.push({ userId, report: await request.clone().json() });
        return jsonResponse({ recorded: true });
      }
      if (url.pathname === "/api/me/discord-link") return jsonResponse({ linked: true, alertsEnabled: true });
      if (url.pathname === "/api/me/automation-preferences") return jsonResponse({ preferences: { quietHoursEnabled: false, ...preferences, ...(preferencesByAccount[userId] || {}) } });
      if (url.pathname === "/api/me/companies") return jsonResponse({ companies: defaultCompanies });
      if (url.pathname === "/api/rankings" && url.searchParams.get("scope") === "global") return jsonResponse({ companies: defaultRankings });
      const historyMatch = url.pathname.match(/^\/api\/me\/companies\/(\d+)\/history$/);
      if (historyMatch) return jsonResponse({ history: historiesByCompany[historyMatch[1]] || defaultHistory });
      return jsonResponse({ error: "not found" }, 404);
    }
  };

  const env = {
    BOT_DB: db,
    BOT_ENCRYPTION_KEY: ENCRYPTION_KEY,
    DISCORD_TOKEN: "mock-discord-token",
    DASHBOARD_API: dashboardApi,
    __testNow: now
  };

  const discordFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    let body = null;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    discordRequests.push({ url, method: init.method || "GET", body });
    if (url.pathname === "/api/v10/users/@me/channels") {
      channelAttempts += 1;
      if (channelAttempts <= channelFailureCount) return new Response("DMs unavailable", { status: 500 });
      return jsonResponse({ id: "dm-channel-test" });
    }
    if (url.pathname === "/api/v10/channels/dm-channel-test/messages") {
      messageAttempts += 1;
      if (messageAttempts <= messageFailureCount) return new Response("message rejected", { status: 500 });
      successfulMessages += 1;
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: "unexpected mock URL" }, 500);
  };

  return {
    env, pollStates, escalations, dailyDeliveries, summaryStates, dashboardRequests, discordRequests, pollHealthReports, discordFetch,
    setNow(value) { env.__testNow = value; },
    setMessageFailureCount(value) { messageFailureCount = value; },
    get messageAttempts() { return messageAttempts; },
    get successfulMessages() { return successfulMessages; },
    get channelAttempts() { return channelAttempts; },
    get reportDay() { return reportDay; }
  };
}

async function runScheduled(fixture, count = 1) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.discordFetch;
  try {
    for (let i = 0; i < count; i++) {
      const pending = [];
      await worker.scheduled({}, fixture.env, { waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
      await Promise.all(pending);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("severity levels and quiet-hours helpers remain deterministic", () => {
  assert.equal(severityRank("info"), 1);
  assert.equal(severityRank("warning"), 2);
  assert.equal(severityRank("critical"), 3);
  assert.equal(severityRank("unknown"), 1);
  assert.equal(isDuringQuietHours({ quietHoursEnabled: false }, new Date("2026-10-20T23:00:00Z")), false);
  assert.equal(isDuringQuietHours({ quietHoursEnabled: true, timezone: "UTC", quietHoursStart: "22:00", quietHoursEnd: "08:00" }, new Date("2026-10-20T23:00:00Z")), true);
});

test("private Discord receives one consolidated daily report and not one DM per alert event", async () => {
  const fixture = makeFixture();
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 1, "one daily summary should be sent as one private DM");
  const body = fixture.discordRequests.find(request => request.url.pathname === "/api/v10/channels/dm-channel-test/messages")?.body;
  assert.match(body.content, /DAILY COMPANY SUMMARY/);
  assert.match(body.content, /Daily income: \$150.*gained \$50/s);
  assert.match(body.content, /Daily profit: \$70.*gained \$20/s);
  assert.match(body.content, /Star level: 6 ★.*gained 1 star level/s);
  assert.match(body.content, /Income gap to next star: \$550.*gap narrowed by \$50/s);
  assert.match(body.content, /Company rank: #3.*gained 1 place/s);
  assert.match(body.content, /Stock quantity: 900.*gained 100 units/s);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(fixture.summaryStates.get(accountId + ":123").snapshotDay, fixture.reportDay);
  assert.equal(fixture.pollHealthReports.at(-1).report.delivered, 1);
});

test("a daily summary is deduplicated for the reporting day across repeated minute polls", async () => {
  const fixture = makeFixture();
  await runScheduled(fixture);
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 1);
  assert.equal(fixture.dailyDeliveries.get(accountId + ":" + fixture.reportDay).status, "delivered");
});

test("the summary waits until 18:20 UTC and sends after the rankings snapshot has settled", async () => {
  const fixture = makeFixture({ now: "2026-10-20T18:19:59.000Z" });
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 0);
  fixture.setNow("2026-10-20T18:20:00.000Z");
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 1);
});

test("failed daily summary DMs retry and recover without creating a second daily report", async () => {
  const fixture = makeFixture();
  fixture.setMessageFailureCount(1);
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 0);
  assert.equal(fixture.dailyDeliveries.get(accountId + ":" + fixture.reportDay).status, "failed");
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 1);
  assert.equal(fixture.dailyDeliveries.get(accountId + ":" + fixture.reportDay).status, "delivered");
});

test("missing current-day history is shown as unavailable and does not overwrite the last valid comparison state", async () => {
  const fixture = makeFixture({ historiesByCompany: { "123": [] } });
  await runScheduled(fixture);
  const body = fixture.discordRequests.find(request => request.url.pathname === "/api/v10/channels/dm-channel-test/messages")?.body?.content || "";
  assert.match(body, /Daily income: Not available/);
  assert.match(body, /today's snapshot is missing/);
  assert.equal(fixture.summaryStates.get(accountId + ":123").snapshotDay, previousReportingDay(fixture.reportDay));
});

test("a dashboard API failure persists poll diagnostics and triggers one private operational escalation after three failures", async () => {
  const fixture = makeFixture({ dashboardThrowsFor: [accountId] });
  await runScheduled(fixture);
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 0);
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 1, "the third consecutive poll failure sends one operational escalation");
  const alert = fixture.discordRequests.find(request => request.url.pathname === "/api/v10/channels/dm-channel-test/messages")?.body?.content || "";
  assert.match(alert, /operational alert/i);
  assert.match(alert, /3 consecutive times/);
  await runScheduled(fixture);
  assert.equal(fixture.successfulMessages, 1, "the same failure streak must not send duplicate escalations");
  assert.equal(fixture.pollStates.get(accountId).lastStatus, "error");
});

test("dashboard poll timeout diagnostics identify the request stage", async () => {
  const cases = [
    ["/api/me/discord-link", "dashboard_discord_link_timeout"],
    ["/api/me/automation-preferences", "dashboard_preferences_timeout"],
    ["/api/me/companies/123/history", "dashboard_company_history_timeout"]
  ];
  for (const [path, expectedCode] of cases) {
    const fixture = makeFixture({ dashboardTimeoutFor: [path] });
    await runScheduled(fixture);
    assert.equal(fixture.pollStates.get(accountId).lastErrorCode, expectedCode);
    assert.equal(fixture.pollHealthReports.at(-1).report.errorCode, expectedCode);
  }
});


test("health-report timeouts have a dedicated diagnostic without marking a successful poll as failed", async () => {
  const fixture = makeFixture({ dashboardTimeoutFor: ["/api/me/discord-alert-poll-health"] });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await runScheduled(fixture);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(fixture.pollStates.get(accountId).lastStatus, "healthy");
  assert.equal(fixture.successfulMessages, 1);
  assert.ok(
    warnings.some(line =>
      line.includes("[alert-poll] dashboard health report unavailable") &&
      line.includes("dashboard_health_report_timeout")
    ),
    "a health-report timeout should emit its own diagnostic"
  );
});


test("scheduled polling uses the deployment-managed bot schema without runtime DDL", () => {
  const workerSource = readFileSync(new URL("./production-worker.js", import.meta.url), "utf8");
  const schema = readFileSync(new URL("./migrations/0001_bot_schema.sql", import.meta.url), "utf8");
  const pollStart = workerSource.indexOf("async function pollPrivateAlerts(env) {");
  const pollEnd = workerSource.indexOf("\nfunction snapshotAgeLabel", pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart, "poll function boundaries should remain discoverable");
  const pollSource = workerSource.slice(pollStart, pollEnd);
  assert.doesNotMatch(pollSource, /ensureBotSchema|CREATE TABLE IF NOT EXISTS/);

  const requiredTables = [
    "discord_links",
    "alert_preferences",
    "alert_deliveries",
    "discord_alert_state",
    "discord_alert_deliveries",
    "discord_alert_poll_state",
    "discord_alert_poll_escalations",
    "discord_daily_summary_deliveries",
    "discord_daily_company_summary_state"
  ];
  for (const table of requiredTables) {
    assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS " + table + " ("), table + " must be provisioned before the Worker deploys");
  }
});


console.log("PASS private alert delivery: single daily company summaries, day-level deduplication, retries, missing-data safety, and operational failure escalation.");
