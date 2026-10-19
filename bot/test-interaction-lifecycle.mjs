import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import worker from "./production-worker.js";

globalThis.crypto = webcrypto;
const encoder = new TextEncoder();
const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: "Ed25519" }, true, ["sign", "verify"]
);
const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", publicKey));
const publicKeyHex = [...rawPublicKey].map(byte => byte.toString(16).padStart(2, "0")).join("");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(interaction) {
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

function fakeDatabase({ delayMs = 0, firstDelayMs = 0, failSchema = false } = {}) {
  let runCount = 0;
  return {
    get runCount() { return runCount; },
    prepare(sql) {
      return {
        bind() { return this; },
        async run() {
          runCount += 1;
          if (failSchema && sql.startsWith("CREATE TABLE")) throw new Error("simulated D1 schema failure");
          if (delayMs) await delay(delayMs);
          return { success: true };
        },
        async first() { if (firstDelayMs) await delay(firstDelayMs); return null; },
        async all() { return { results: [] }; }
      };
    }
  };
}

const botStatusInteraction = () => ({
  type: 2,
  application_id: "application-test",
  token: "interaction-token-test",
  data: { name: "bot", options: [{ type: 1, name: "status" }] },
  user: { id: "discord-user-test" }
});

async function invoke(interaction, {
  dbDelayMs = 0,
  dbFirstDelayMs = 0,
  failSchema = false,
  apiDelayMs = 0,
  failApi = false
} = {}) {
  const previousFetch = globalThis.fetch;
  const webhookRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    webhookRequests.push({
      url: String(input),
      method: init.method || "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null
    });
    return new Response(null, { status: 204 });
  };

  const db = fakeDatabase({ delayMs: dbDelayMs, firstDelayMs: dbFirstDelayMs, failSchema });
  const env = {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    BOT_ENCRYPTION_KEY: "0".repeat(64),
    BOT_DB: db,
    DASHBOARD_API: {
      async fetch(request) {
        if (apiDelayMs) await delay(apiDelayMs);
        if (failApi) throw new Error("simulated dashboard timeout");
        if (new URL(request.url).pathname === "/health") {
          return new Response(JSON.stringify({ ok: true, checkedAt: "test timestamp" }), {
            status: 200, headers: { "content-type": "application/json" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    }
  };

  const backgroundTasks = [];
  let taskFinishedBeforeAcknowledgement = false;
  try {
    const request = await signedRequest(interaction);
    const started = Date.now();
    const response = await worker.fetch(request, env, {
      waitUntil(promise) {
        let settled = false;
        const tracked = Promise.resolve(promise).then(
          () => { settled = true; },
          error => { settled = true; throw error; }
        ).finally(() => { if (settled) taskFinishedBeforeAcknowledgement = true; });
        backgroundTasks.push(tracked);
      }
    });
    const elapsedMs = Date.now() - started;
    const callback = await response.json();
    const finishedImmediately = taskFinishedBeforeAcknowledgement;
    await Promise.all(backgroundTasks);
    return { response, callback, elapsedMs, finishedImmediately, webhookRequests, db };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("slow dashboard work is acknowledged privately before the dependency completes", async () => {
  const result = await invoke(botStatusInteraction(), { dbDelayMs: 80, apiDelayMs: 500 });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.callback, { type: 5, data: { flags: 64 } });
  assert.equal(result.finishedImmediately, false, "deferred work must still be pending when the acknowledgement is returned");
  assert.ok(result.elapsedMs < 350, "the initial response must not wait for simulated slow dependencies");
  const edit = result.webhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(edit, "the background result must edit the original response");
  assert.match(edit.body.content, /Dashboard API: healthy/);
  assert.deepEqual(edit.body.allowed_mentions, { parse: [] });
});

test("dashboard failure becomes a private completion message rather than a missed acknowledgement", async () => {
  const result = await invoke(botStatusInteraction(), { dbDelayMs: 10, apiDelayMs: 50, failApi: true });
  assert.deepEqual(result.callback, { type: 5, data: { flags: 64 } });
  const edit = result.webhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(edit, "failed dashboard health checks must still complete the deferred response");
  assert.match(edit.body.content, /dashboard API health could not be checked/i);
  assert.deepEqual(edit.body.allowed_mentions, { parse: [] });
});

test("D1 schema initialization failure still completes the deferred response safely", async () => {
  const result = await invoke(botStatusInteraction(), { failSchema: true });
  assert.deepEqual(result.callback, { type: 5, data: { flags: 64 } });
  const edit = result.webhookRequests.find(request => request.method === "PATCH" && request.url.endsWith("/messages/@original"));
  assert.ok(edit, "schema failures must be converted into a completed deferred response");
  assert.match(edit.body.content, /request could not be completed/i);
  assert.deepEqual(edit.body.allowed_mentions, { parse: [] });
});

test("autocomplete keeps its required response type and bypasses DDL initialization", async () => {
  const result = await invoke({
    type: 4,
    data: { name: "company", options: [] },
    user: { id: "discord-user-test" }
  }, { failSchema: true });
  assert.deepEqual(result.callback, { type: 8, data: { choices: [] } });
  assert.equal(result.db.runCount, 0, "autocomplete must not run schema DDL before acknowledging");
  assert.equal(result.webhookRequests.length, 0, "autocomplete must return its choices directly");
});

test("slow autocomplete returns valid empty choices before the acknowledgement deadline", async () => {
  const result = await invoke({
    type: 4,
    data: { name: "company", options: [{ type: 3, name: "company_id", value: "123", focused: true }] },
    user: { id: "discord-user-test" }
  }, { dbFirstDelayMs: 2200 });
  assert.ok(result.elapsedMs < 2500, "autocomplete should stop waiting well before Discord's three-second deadline");
  assert.deepEqual(result.callback, { type: 8, data: { choices: [] } });
  assert.equal(result.db.runCount, 0, "autocomplete timeout must not initialize the schema");
});

test("link-code modal opens immediately without deferral or database work", async () => {
  const result = await invoke({
    type: 2,
    data: { name: "link-code" },
    user: { id: "discord-user-test" }
  }, { failSchema: true });
  assert.equal(result.callback.type, 9);
  assert.equal(result.callback.data.custom_id, "link_code_submit");
  assert.equal(result.db.runCount, 0, "showing a modal must not wait for schema initialization");
});

test("fast private replies explicitly suppress mention parsing", async () => {
  const result = await invoke({
    type: 2,
    data: { name: "link" },
    user: { id: "discord-user-test" }
  });
  assert.equal(result.callback.type, 4);
  assert.equal(result.callback.data.flags, 64);
  assert.deepEqual(result.callback.data.allowed_mentions, { parse: [] });
});
