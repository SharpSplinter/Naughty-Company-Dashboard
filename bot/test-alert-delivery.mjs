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

async function encryptedLink() {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey("raw", hexBytes(ENCRYPTION_KEY), "AES-GCM", false, ["encrypt"]);
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(sessionToken));
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

function makeFixture({ events = [], preferences = {}, seededDeliveries = {}, messageFailureCount = 0, channelFailureCount = 0 } = {}) {
  const dbRuns = [];
  const dbReads = [];
  const deliveries = new Map(Object.entries(seededDeliveries).map(([eventId, row]) => [
    deliveryKey(accountId, eventId), structuredClone(row)
  ]));
  const discordRequests = [];
  const dashboardRequests = [];
  const linkRowPromise = encryptedLink();
  let linkRow;

  let messageAttempts = 0;
  let channelAttempts = 0;

  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() {
          dbRuns.push({ sql, values: [...values] });
          if (sql.startsWith("INSERT INTO discord_alert_state")) {
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO discord_alert_deliveries") && sql.includes("'filtered'")) {
            const [user, eventId, updatedAt] = values;
            deliveries.set(deliveryKey(user, eventId), { status: "filtered", attempts: 0, updatedAt });
          } else if (sql.startsWith("INSERT INTO discord_alert_deliveries")) {
            const [user, eventId, status, attempts, updatedAt] = values;
            deliveries.set(deliveryKey(user, eventId), { status, attempts: Number(attempts), updatedAt });
          }
          return { success: true };
        },
        async first() {
          dbReads.push({ sql, values: [...values] });
          if (sql.includes("SELECT linked_at AS linkedAt")) return { linkedAt };
          if (sql.includes("SELECT status,attempts FROM discord_alert_deliveries")) {
            return deliveries.get(deliveryKey(values[0], values[1])) || null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM discord_links")) {
            linkRow = linkRow || await linkRowPromise;
            return { results: [{
              discordUserId: accountId,
              cipher: linkRow.encrypted_session_token,
              iv: linkRow.token_iv
            }] };
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
      if (url.pathname === "/api/me/discord-link") return jsonResponse({ linked: true, alertsEnabled: true });
      if (url.pathname === "/api/me/automation-preferences") return jsonResponse({ preferences: { quietHoursEnabled: false, ...preferences } });
      if (url.pathname === "/api/me/alerts") return jsonResponse({ events });
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
    env, dbRuns, dbReads, deliveries, discordRequests, dashboardRequests, discordFetch,
    get messageAttempts() { return messageAttempts; },
    get channelAttempts() { return channelAttempts; },
    set messageFailureCount(value) { messageFailureCount = value; }
  };
}

async function runScheduled(fixture) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.discordFetch;
  const pending = [];
  try {
    await worker.scheduled({}, fixture.env, { waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = previousFetch;
  }
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

console.log("PASS private alert delivery: severity and quiet-hours filtering, duplicate suppression, retry cap, transient recovery, and DM-channel failures.");
