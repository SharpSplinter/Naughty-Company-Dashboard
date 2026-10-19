import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import worker from "./production-worker.js";

const encoder = new TextEncoder();
const ENCRYPTION_KEY = "0".repeat(64);
const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: "Ed25519" }, true, ["sign", "verify"]
);
const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", publicKey));
const publicKeyHex = [...rawPublicKey].map(byte => byte.toString(16).padStart(2, "0")).join("");

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value) {
  return Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));
}

async function signedRequestBody(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
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

async function encryptedSessionToken(token) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey("raw", hexBytes(ENCRYPTION_KEY), "AES-GCM", false, ["encrypt"]);
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token));
  return { encrypted_session_token: hex(cipher), token_iv: hex(iv) };
}

function fakeDatabase({ linkedRow = null } = {}) {
  const runs = [];
  const firstCalls = [];
  return {
    runs,
    firstCalls,
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
          if (linkedRow && /SELECT encrypted_session_token[\s\S]*FROM discord_links/.test(sql)) return linkedRow;
          return null;
        },
        async all() { return { results: [] }; }
      };
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function invoke(interaction, {
  rawBody = null,
  linkedRow = null,
  dashboardHandler = async () => jsonResponse({}),
  tamperSignature = false
} = {}) {
  const previousFetch = globalThis.fetch;
  const discordWebhookRequests = [];
  const dashboardRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    discordWebhookRequests.push({
      url: String(input),
      method: init.method || "GET",
      body
    });
    return new Response(null, { status: 204 });
  };
  const db = fakeDatabase({ linkedRow });
  const env = {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    BOT_ENCRYPTION_KEY: ENCRYPTION_KEY,
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
    const body = rawBody === null ? JSON.stringify(interaction) : rawBody;
    const request = await signedRequestBody(body);
    if (tamperSignature) request.headers.set("x-signature-timestamp", String(Math.floor(Date.now() / 1000) - 600));
    const response = await worker.fetch(request, env, { waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
    const payload = await response.json();
    await Promise.all(pending);
    return { status: response.status, payload, db, discordWebhookRequests, dashboardRequests };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function linkCodeSubmission(code) {
  return {
    type: 5,
    application_id: "application-test",
    token: "link-interaction-token",
    data: {
      custom_id: "link_code_submit",
      components: [{
        type: 18,
        label: "Dashboard link code",
        component: { type: 4, custom_id: "link_code", value: code }
      }]
    },
    user: { id: "discord-user-test" }
  };
}

function companyListInteraction() {
  return {
    type: 2,
    application_id: "application-test",
    token: "company-list-token",
    data: { name: "company", options: [{ type: 1, name: "list", options: [] }] },
    user: { id: "discord-user-test" }
  };
}

test("valid one-time link code is redeemed for the invoking Discord user and stores an encrypted session", async () => {
  const code = "ab".repeat(24);
  const sessionToken = "dashboard-session-secret";
  const result = await invoke(linkCodeSubmission(code), {
    dashboardHandler: async request => {
      if (request.url.pathname === "/api/discord/link/redeem") {
        return jsonResponse({ token: sessionToken, playerId: "player-123" });
      }
      return jsonResponse({}, 404);
    }
  });

  assert.deepEqual(result.payload, { type: 5, data: { flags: 64 } }, "modal submissions should be acknowledged privately first");
  const redeem = result.dashboardRequests.find(request => request.url.pathname === "/api/discord/link/redeem");
  assert.ok(redeem, "the valid code should call the dashboard redemption endpoint");
  assert.equal(redeem.method, "POST");
  assert.deepEqual(redeem.body, { code, discordUserId: "discord-user-test" });

  const finalReply = result.discordWebhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(finalReply);
  assert.match(finalReply.body.content, /linked securely/i);
  assert.deepEqual(finalReply.body.allowed_mentions, { parse: [] });

  const linkInsert = result.db.runs.find(entry => entry.sql.startsWith("INSERT INTO discord_links"));
  assert.ok(linkInsert, "successful redemption should persist the link");
  assert.equal(linkInsert.values[0], "discord-user-test");
  assert.equal(linkInsert.values[1], "player-123");
  assert.notEqual(linkInsert.values[2], sessionToken, "the raw dashboard session token must not be stored");
  assert.ok(linkInsert.values[2] && linkInsert.values[3], "ciphertext and IV should be persisted");
  assert.ok(result.db.runs.some(entry => entry.sql.startsWith("INSERT INTO alert_preferences")));
  assert.ok(result.db.runs.some(entry => entry.sql.startsWith("INSERT INTO discord_alert_state")));
});

test("malformed or invalid link-code modal submissions do not redeem or persist a link", async () => {
  const result = await invoke(linkCodeSubmission("not-a-valid-code"), {
    dashboardHandler: async () => { throw new Error("dashboard must not be called for invalid link codes"); }
  });
  assert.deepEqual(result.payload, { type: 5, data: { flags: 64 } });
  const finalReply = result.discordWebhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(finalReply);
  assert.match(finalReply.body.content, /48-character code/i);
  assert.equal(result.dashboardRequests.length, 0);
  assert.equal(result.db.runs.some(entry => entry.sql.startsWith("INSERT INTO discord_links")), false);
});

test("expired or revoked dashboard sessions are reported privately and remove the stale link", async t => {
  const linkedRow = await encryptedSessionToken("expired-session");
  for (const status of [401, 403]) {
    await t.test("HTTP " + status, async () => {
      const result = await invoke(companyListInteraction(), {
        linkedRow,
        dashboardHandler: async request => request.url.pathname === "/api/me/companies"
          ? jsonResponse({ error: "unauthorized" }, status)
          : jsonResponse({}, 404)
      });
      assert.deepEqual(result.payload, { type: 5, data: { flags: 64 } });
      const finalReply = result.discordWebhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
      assert.ok(finalReply);
      assert.match(finalReply.body.content, /session expired or access changed/i);
      assert.deepEqual(finalReply.body.allowed_mentions, { parse: [] });
      assert.ok(result.db.runs.some(entry =>
        entry.sql.startsWith("DELETE FROM discord_links") && entry.values[0] === "discord-user-test"
      ), "the stale local link should be removed after authentication failure");
    });
  }
});

test("malformed JSON and stale request signatures are rejected before command work", async t => {
  await t.test("malformed JSON", async () => {
    const result = await invoke(null, { rawBody: "{broken-json" });
    assert.equal(result.status, 400);
    assert.deepEqual(result.payload, { ok: false, error: "invalid_json" });
    assert.equal(result.db.runs.length, 0);
    assert.equal(result.dashboardRequests.length, 0);
  });
  await t.test("stale signature timestamp", async () => {
    const result = await invoke({ type: 2, data: { name: "link" }, user: { id: "discord-user-test" } }, { tamperSignature: true });
    assert.equal(result.status, 401);
    assert.deepEqual(result.payload, { ok: false, error: "invalid_request_signature" });
    assert.equal(result.db.runs.length, 0);
    assert.equal(result.dashboardRequests.length, 0);
  });
});

test("multi-part private alert replies edit the original response and suppress mentions on every follow-up", async () => {
  const linkedRow = await encryptedSessionToken("active-session");
  const events = Array.from({ length: 10 }, (_, index) => ({
    eventId: "11111111-1111-4111-8111-" + String(index).padStart(12, "0"),
    severity: "warning",
    title: "Alert title " + index + " ".repeat(85),
    status: "unread",
    message: "Details for this alert, with enough diagnostic context to exercise multi-part private responses. ".repeat(3),
    companyName: "Example company " + index,
    createdAt: "2026-10-19T18:00:00.000Z"
  }));
  const result = await invoke({
    type: 2,
    application_id: "application-test",
    token: "multi-part-alerts-token",
    data: { name: "company", options: [{
      type: 2, name: "alerts", options: [{
        type: 1, name: "recent", options: [{ type: 4, name: "limit", value: 10 }]
      }]
    }] },
    user: { id: "discord-user-test" }
  }, {
    linkedRow,
    dashboardHandler: async request => request.url.pathname === "/api/me/alerts"
      ? jsonResponse({ events })
      : jsonResponse({}, 404)
  });

  assert.deepEqual(result.payload, { type: 5, data: { flags: 64 } });
  const edit = result.discordWebhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  const followups = result.discordWebhookRequests.filter(request => request.method === "POST" && request.url.endsWith("/webhooks/application-test/multi-part-alerts-token"));
  assert.ok(edit, "the first part should edit the original deferred response");
  assert.ok(followups.length > 0, "long alert results should be split into follow-up messages");
  assert.match(edit.body.content, /Recent dashboard alerts/);
  assert.deepEqual(edit.body.allowed_mentions, { parse: [] });
  for (const followup of followups) {
    assert.equal(followup.body.flags, 64, "each follow-up should remain ephemeral");
    assert.deepEqual(followup.body.allowed_mentions, { parse: [] });
    assert.match(followup.body.content, /continued/i);
  }
});
