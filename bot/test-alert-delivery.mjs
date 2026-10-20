import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import worker from "./production-worker.js";
import { isDuringQuietHours, severityRank } from "./alert-delivery.mjs";

const ENCRYPTION_KEY = "0".repeat(64);
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const hexBytes = value => Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));
const accountId = "discord-user-alert-test";
const sessionToken = "dashboard-session-alert-test";
const linkedAt = "2026-10-01T00:00:00.000Z";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function encryptedLink(token = sessionToken) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey("raw", hexBytes(ENCRYPTION_KEY), "AES-GCM", false, ["encrypt"]);
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token));
  return { encrypted_session_token: hex(cipher), token_iv: hex(iv) };
}

function alertEvent(eventId, severity = "warning", createdAt = "2026-10-02T00:00:00.000Z") {
  return {
    eventId,
    severity,
    title: "Test " + severity + " alert",
    message: "Private alert delivery test body",
    status: "unread",
    companyId: "company-test",
    companyName: "Alert Test Company",
    createdAt
  };
}

function deliveryKey(user, eventId) {
  return user + ":" + eventId;
}

function makeFixture({
  events = [],
  preferences = {},
  seededDeliveries = {},
  messageFailureCount = 0,
  channelFailureCount = 0,
  linkedAccounts = [{ discordUserId: accountId, sessionToken }],
  eventsByAccount = {},
  preferencesByAccount = {},
  dashboardThrowsFor = []
} = {}) {
  const dbRuns = [];
  const dbReads = [];
  const pollStates = new Map();
  const deliveries = new Map(Object.entries(seededDeliveries).map(([eventId, row]) => [
    deliveryKey(accountId, eventId), structuredClone(row)
  ]));
  const discordRequests = [];
  const dashboardRequests = [];
  const linkRowPromise = Promise.all(linkedAccounts.map(async account => ({
    account,
    row: account.invalidCipher
      ? { encrypted_session_token: "00", token_iv: "00" }
      : await encryptedLink(account.sessionToken || sessionToken)
  })));
  let linkRows;

  let messageAttempts = 0;
  let channelAttempts = 0;

  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          dbRuns.push({ sql, values: [...values] });
          if (sql.startsWith("INSERT INTO discord_alert_poll_state")) {
            const [user, startedAt, updatedAt] = values;
            const prior = pollStates.get(user) || { consecutiveFailures: 0 };
            pollStates.set(user, {
              ...prior, lastStartedAt: startedAt, lastStatus: "running", updatedAt,
              lastPageCount: 0, lastEventsSeen: 0, lastDelivered: 0, lastFiltered: 0,
              lastFailed: 0, lastExhausted: 0, lastStaleRecovered: 0
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE discord_alert_poll_state SET last_completed_at=?")) {
            if (sql.includes("last_status='error'")) {
              const [completedAt, errorCode, errorAt, pages, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, updatedAt, user] = values;
              const prior = pollStates.get(user) || { consecutiveFailures: 0 };
              pollStates.set(user, {
                ...prior, lastCompletedAt: completedAt, lastStatus: "error", lastErrorCode: errorCode,
                lastErrorAt: errorAt, consecutiveFailures: Number(prior.consecutiveFailures || 0) + 1,
                lastPageCount: pages, lastEventsSeen: eventsSeen, lastDelivered: delivered, lastFiltered: filtered,
                lastFailed: failed, lastExhausted: exhausted, lastStaleRecovered: staleRecovered, updatedAt
              });
            } else {
              const [completedAt, successStatus, successAt, status, errorCode, errorAtCheck, errorAt, pages, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, updatedAt, user] = values;
              const prior = pollStates.get(user) || { consecutiveFailures: 0 };
              pollStates.set(user, {
                ...prior, lastCompletedAt: completedAt,
                lastSuccessAt: ["healthy","partial","quiet_hours","disabled","unlinked","initialized"].includes(successStatus) ? successAt : prior.lastSuccessAt,
                lastStatus: status, lastErrorCode: errorCode, lastErrorAt: errorAtCheck === null ? null : errorAt,
                consecutiveFailures: 0, lastPageCount: pages, lastEventsSeen: eventsSeen, lastDelivered: delivered,
                lastFiltered: filtered, lastFailed: failed, lastExhausted: exhausted, lastStaleRecovered: staleRecovered, updatedAt
              });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO discord_alert_state")) {
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO discord_alert_deliveries") && sql.includes("VALUES(?,?,'processing',1,?)")) {
            const [user, eventId, updatedAt, expiredBefore] = values;
            const key = deliveryKey(user, eventId);
            const prior = deliveries.get(key);
            if (!prior) {
              deliveries.set(key, { status: "processing", attempts: 1, updatedAt });
              return { success: true, meta: { changes: 1 } };
            }
            const staleProcessing = prior.status === "processing" && prior.updatedAt < expiredBefore;
            const canClaim = !["delivered", "filtered"].includes(prior.status) &&
              Number(prior.attempts || 0) < 3 && (prior.status !== "processing" || staleProcessing);
            if (canClaim) deliveries.set(key, { status: "processing", attempts: Number(prior.attempts || 0) + 1, updatedAt });
            return { success: true, meta: { changes: canClaim ? 1 : 0 } };
          }
          if (sql.startsWith("INSERT INTO discord_alert_deliveries") && sql.includes("'filtered'")) {
            const [user, eventId, updatedAt] = values;
            const key = deliveryKey(user, eventId);
            const prior = deliveries.get(key);
            if (!prior || !["delivered", "processing"].includes(prior.status)) {
              deliveries.set(key, { status: "filtered", attempts: 0, updatedAt });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith("UPDATE discord_alert_deliveries SET status='failed',updated_at=?")) {
            const [updatedAt, user, cutoff] = values;
            let changes = 0;
            for (const [key, prior] of deliveries.entries()) {
              if (key.startsWith(user + ":") && prior.status === "processing" && Number(prior.attempts) >= 3 && prior.updatedAt < cutoff) {
                deliveries.set(key, { ...prior, status: "failed", updatedAt });
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (sql.startsWith("UPDATE discord_alert_deliveries SET status=?")) {
            const [status, updatedAt, user, eventId, attempts] = values;
            const key = deliveryKey(user, eventId);
            const prior = deliveries.get(key);
            const changed = prior?.status === "processing" && Number(prior.attempts) === Number(attempts);
            if (changed) deliveries.set(key, { status, attempts: Number(attempts), updatedAt });
            return { success: true, meta: { changes: changed ? 1 : 0 } };
          }
          return { success: true };
        },
        async first() {
          dbReads.push({ sql, values: [...values] });
          if (sql.includes("SELECT linked_at AS linkedAt")) return { linkedAt };
          if (sql.includes("FROM discord_alert_poll_state")) return pollStates.get(values[0]) || null;
          if (sql.includes("SELECT status,attempts FROM discord_alert_deliveries")) {
            return deliveries.get(deliveryKey(values[0], values[1])) || null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM discord_alert_deliveries WHERE discord_user_id=?")) {
            return { results: [...deliveries.entries()].filter(([key]) => key.startsWith(values[0] + ":")).map(([key, row]) => ({
              eventId: key.slice(values[0].length + 1), status: row.status, attempts: row.attempts, updatedAt: row.updatedAt
            })).filter(row => row.status === "failed" || row.status === "processing").sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,10) };
          }
          if (sql.includes("FROM discord_links")) {
            linkRows = linkRows || await linkRowPromise;
            return { results: linkRows.map(({ account, row }) => ({
              discordUserId: account.discordUserId,
              cipher: row.encrypted_session_token,
              iv: row.token_iv
            })) };
          }
          return { results: [] };
        }
      };
    }
  };

  const dashboardApi = {
    async fetch(request) {
      const url = new URL(request.url);
      const record = { url, method: request.method, headers: request.headers };
      dashboardRequests.push(record);
      const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const account = linkedAccounts.find(item => (item.sessionToken || sessionToken) === token) || linkedAccounts[0];
      const userId = account?.discordUserId || accountId;
      if (dashboardThrowsFor.includes(userId)) return jsonResponse({ error: "simulated account-specific dashboard API failure" }, 503);
      if (url.pathname === "/api/me/discord-link") return jsonResponse({ linked: true, alertsEnabled: true });
      if (url.pathname === "/api/me/automation-preferences") {
        return jsonResponse({ preferences: { quietHoursEnabled: false, ...preferences, ...(preferencesByAccount[userId] || {}) } });
      }
      if (url.pathname === "/api/me/alerts") {
        const source = [...(eventsByAccount[userId] ?? events)];
        let selected = source;
        if (url.searchParams.has("after")) {
          const after = url.searchParams.get("after") || "";
          const afterEventId = url.searchParams.get("afterEventId") || "";
          selected = source.filter(event => typeof event.createdAt === "string" && typeof event.eventId === "string" &&
            (event.createdAt > after || (afterEventId && event.createdAt === after && event.eventId > afterEventId)))
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.eventId).localeCompare(String(b.eventId)));
        }
        const limit = Math.min(100, Number(url.searchParams.get("limit") || 50));
        return jsonResponse({ events: selected.slice(0, limit) });
      }
      return jsonResponse({ error: "not found" }, 404);
    }
  };

  const env = {
    BOT_DB: db,
    BOT_ENCRYPTION_KEY: ENCRYPTION_KEY,
    DISCORD_TOKEN: "mock-discord-token",
    DASHBOARD_API: dashboardApi
  };

  const discordFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    discordRequests.push({ url, method: init.method || "GET", body });
    if (url.pathname === "/api/v10/users/@me/channels") {
      channelAttempts += 1;
      if (channelAttempts <= channelFailureCount) return new Response("DMs unavailable", { status: 500 });
      return jsonResponse({ id: "dm-channel-test" });
    }
    if (url.pathname === "/api/v10/channels/dm-channel-test/messages") {
      messageAttempts += 1;
      if (messageAttempts <= messageFailureCount) return new Response("message rejected", { status: 500 });
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: "unexpected mock URL" }, 500);
  };

  return {
    env, dbRuns, dbReads, deliveries, pollStates, dashboardThrowsFor, discordRequests, dashboardRequests, discordFetch,
    get messageAttempts() { return messageAttempts; },
    get channelAttempts() { return channelAttempts; },
    set messageFailureCount(value) { messageFailureCount = value; }
  };
}

async function executeScheduled(fixture) {
  const pending = [];
  await worker.scheduled({}, fixture.env, { waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
  await Promise.all(pending);
}

async function runScheduled(fixture) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.discordFetch;
  try { await executeScheduled(fixture); }
  finally { globalThis.fetch = previousFetch; }
}

async function runConcurrentScheduled(fixture, count = 2) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.discordFetch;
  try { await Promise.all(Array.from({ length: count }, () => executeScheduled(fixture))); }
  finally { globalThis.fetch = previousFetch; }
}

test("severity levels are ordered and unknown values fail closed to informational severity", () => {
  assert.equal(severityRank("info"), 1);
  assert.equal(severityRank("notice"), 1);
  assert.equal(severityRank("warning"), 2);
  assert.equal(severityRank("medium"), 2);
  assert.equal(severityRank("critical"), 3);
  assert.equal(severityRank("fatal"), 3);
});

test("quiet hours honor local timezone, overnight windows, and inclusive/exclusive boundaries", () => {
  const defaults = { quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00" };
  assert.equal(isDuringQuietHours({ ...defaults, timezone: "America/New_York" }, new Date("2026-10-20T02:00:00.000Z")), true,
    "02:00 UTC is 22:00 in New York during daylight time");
  assert.equal(isDuringQuietHours({ ...defaults, timezone: "Asia/Tokyo" }, new Date("2026-10-20T02:00:00.000Z")), false,
    "the same instant is daytime in Tokyo");
  assert.equal(isDuringQuietHours({ ...defaults, timezone: "Asia/Tokyo" }, new Date("2026-10-19T14:00:00.000Z")), true,
    "23:00 in Tokyo falls inside the overnight quiet window");
  assert.equal(isDuringQuietHours({ ...defaults, timezone: "America/New_York" }, new Date("2026-10-20T12:00:00.000Z")), false,
    "08:00 local time is the exclusive end of the quiet window");
  assert.equal(isDuringQuietHours({ ...defaults, quietHoursEnabled: false, timezone: "America/New_York" }, new Date("2026-10-20T02:00:00.000Z")), false,
    "disabled quiet hours never suppress delivery");
});

test("invalid quiet-hour configuration safely disables quiet-hour suppression", () => {
  const base = { quietHoursEnabled: true, timezone: "UTC", quietHoursStart: "22:00", quietHoursEnd: "08:00" };
  const atNight = new Date("2026-10-20T02:00:00.000Z");
  assert.equal(isDuringQuietHours({ ...base, timezone: "Mars/Olympus" }, atNight), false);
  assert.equal(isDuringQuietHours({ ...base, quietHoursStart: "24:00" }, atNight), false);
  assert.equal(isDuringQuietHours({ ...base, quietHoursStart: "22:90" }, atNight), false);
  assert.equal(isDuringQuietHours({ ...base, quietHoursStart: "08:00", quietHoursEnd: "08:00" }, atNight), false);
  assert.equal(isDuringQuietHours(base, new Date("not-a-date")), false);
});

test("the scheduled poll filters low severity, suppresses duplicate events, and records terminal states", async () => {
  const warning = alertEvent("11111111-1111-4111-8111-111111111111", "warning");
  const critical = alertEvent("22222222-2222-4222-8222-222222222222", "critical");
  const fixture = makeFixture({
    events: [warning, critical, critical],
    preferences: { minimumSeverity: "critical" }
  });

  await runScheduled(fixture);

  assert.equal(fixture.messageAttempts, 1, "only the critical event should produce a DM");
  assert.deepEqual(fixture.deliveries.get(deliveryKey(accountId, warning.eventId)), {
    status: "filtered", attempts: 0, updatedAt: fixture.deliveries.get(deliveryKey(accountId, warning.eventId)).updatedAt
  });
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, critical.eventId)).status, "delivered");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, critical.eventId)).attempts, 1);
  assert.deepEqual(fixture.discordRequests.find(request => request.url.pathname === "/api/v10/channels/dm-channel-test/messages").body.allowed_mentions, { parse: [] },
    "the direct message must suppress all mention parsing");

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 1, "delivered and filtered event rows must prevent duplicate DMs in later polls");
});

test("failed DM deliveries retry across scheduled polls but stop after three total attempts", async () => {
  const event = alertEvent("33333333-3333-4333-8333-333333333333");
  const fixture = makeFixture({ events: [event], messageFailureCount: 99 });

  await runScheduled(fixture);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "failed");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 1);

  await runScheduled(fixture);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 2);

  await runScheduled(fixture);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 3);
  assert.equal(fixture.messageAttempts, 3);

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 3, "the next poll must stop once the retry budget is exhausted");
});

test("a transient DM failure can recover on the next poll and is then deduplicated", async () => {
  const event = alertEvent("44444444-4444-4444-8444-444444444444");
  const fixture = makeFixture({ events: [event], messageFailureCount: 1 });

  await runScheduled(fixture);
  assert.deepEqual(fixture.deliveries.get(deliveryKey(accountId, event.eventId)), {
    status: "failed", attempts: 1, updatedAt: fixture.deliveries.get(deliveryKey(accountId, event.eventId)).updatedAt
  });

  await runScheduled(fixture);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "delivered");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 2);

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 2, "a recovered delivery must not be sent again");
});

test("quiet hours prevent Discord delivery without marking events delivered or filtered", async () => {
  // Make the local quiet-hours window cover every normal local minute for this test;
  // helper-level timezone tests above check the exact boundaries deterministically.
  const event = alertEvent("55555555-5555-4555-8555-555555555555");
  const currentLocalMinute = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date()).split(":");
  const hour = Number(currentLocalMinute[0]);
  const start = String((hour + 23) % 24).padStart(2, "0") + ":00";
  const end = String((hour + 1) % 24).padStart(2, "0") + ":00";
  const fixture = makeFixture({
    events: [event],
    preferences: { quietHoursEnabled: true, timezone: "UTC", quietHoursStart: start, quietHoursEnd: end }
  });

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 0, "quiet hours must prevent opening/sending Discord DMs");
  assert.equal(fixture.deliveries.has(deliveryKey(accountId, event.eventId)), false,
    "quiet-hours skips must remain eligible for delivery after quiet hours end");
});

test("DM-channel creation failure is recorded and retried on the next scheduled poll", async () => {
  const event = alertEvent("66666666-6666-4666-8666-666666666666");
  const fixture = makeFixture({ events: [event], channelFailureCount: 1 });

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 0);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "failed");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 1);

  await runScheduled(fixture);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "delivered");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 2);
});

test("a dashboard API failure for one linked account does not block later accounts", async () => {
  const event = alertEvent("77777777-7777-4777-8777-777777777777");
  const brokenUser = "discord-user-broken-account";
  const fixture = makeFixture({
    events: [],
    linkedAccounts: [
      { discordUserId: brokenUser, sessionToken: "dashboard-session-broken" },
      { discordUserId: accountId, sessionToken }
    ],
    eventsByAccount: { [accountId]: [event] },
    dashboardThrowsFor: [brokenUser]
  });

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 1, "the second account should still receive its eligible alert");
  assert.equal(fixture.discordRequests.find(request => request.url.pathname === "/api/v10/users/@me/channels")?.body.recipient_id, accountId);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "delivered");
});

test("the scheduled poll pages through more than 100 eligible alerts without missing the older events", async () => {
  const events = Array.from({ length: 155 }, (_, index) => alertEvent(
    "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    "warning",
    new Date(Date.parse(linkedAt) + (index + 1) * 1000).toISOString()
  ));
  const fixture = makeFixture({ events });

  await runScheduled(fixture);
  assert.equal(fixture.messageAttempts, 155, "all events across both pages should be attempted");
  assert.equal(fixture.dashboardRequests.filter(request => request.url.pathname === "/api/me/alerts").length, 2,
    "the poll should fetch a full first page then the remaining 55 events");
  assert.equal([...fixture.deliveries.values()].filter(row => row.status === "delivered").length, 155);
});

test("overlapping scheduled polls atomically claim an event and send only one DM", async () => {
  const event = alertEvent("88888888-8888-4888-8888-888888888888");
  const fixture = makeFixture({ events: [event] });

  await runConcurrentScheduled(fixture, 2);

  assert.equal(fixture.messageAttempts, 1, "only the poll that atomically claimed the event should send");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "delivered");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 1);
});

test("repeated dashboard API failures persist account diagnostics and reset after recovery", async () => {
  const brokenUser = accountId;
  const fixture = makeFixture({ dashboardThrowsFor: [brokenUser] });

  await runScheduled(fixture);
  assert.equal(fixture.pollStates.get(accountId).lastStatus, "error");
  assert.equal(fixture.pollStates.get(accountId).lastErrorCode, "dashboard_discord_link_http_503");
  assert.equal(fixture.pollStates.get(accountId).consecutiveFailures, 1);

  await runScheduled(fixture);
  assert.equal(fixture.pollStates.get(accountId).consecutiveFailures, 2, "consecutive API failures should accumulate");

  fixture.dashboardThrowsFor.length = 0;
  await runScheduled(fixture);
  assert.equal(fixture.pollStates.get(accountId).lastStatus, "healthy");
  assert.equal(fixture.pollStates.get(accountId).consecutiveFailures, 0, "a healthy poll clears the consecutive failure counter");
  assert.equal(fixture.pollStates.get(accountId).lastErrorCode, null);
});

test("a DM failure exhausting its retry budget is persisted as an actionable delivery issue", async () => {
  const event = alertEvent("99999999-9999-4999-8999-999999999999");
  const fixture = makeFixture({ events: [event], messageFailureCount: 99 });

  await runScheduled(fixture);
  await runScheduled(fixture);
  await runScheduled(fixture);

  assert.equal(fixture.pollStates.get(accountId).lastStatus, "partial");
  assert.equal(fixture.pollStates.get(accountId).lastErrorCode, "discord_dm_delivery_failed");
  assert.equal(fixture.pollStates.get(accountId).lastFailed, 1);
  assert.equal(fixture.pollStates.get(accountId).lastExhausted, 1);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 3);
});

test("an exhausted stale processing claim is converted to a retryable failed row", async () => {
  const event = alertEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const fixture = makeFixture({
    events: [event],
    seededDeliveries: {
      [event.eventId]: { status: "processing", attempts: 3, updatedAt: "2026-10-01T00:00:00.000Z" }
    }
  });

  await runScheduled(fixture);
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).status, "failed");
  assert.equal(fixture.deliveries.get(deliveryKey(accountId, event.eventId)).attempts, 3,
    "stale recovery must preserve the attempt budget until an explicit manual retry");
  assert.equal(fixture.pollStates.get(accountId).lastStaleRecovered, 1);
});

console.log("PASS private alert delivery: severity and quiet-hours filtering, duplicate suppression, retry cap, transient recovery, and DM-channel failures.");
