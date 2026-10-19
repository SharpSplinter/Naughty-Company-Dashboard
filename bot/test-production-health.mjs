import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionHealth } from "./production-health.mjs";

const healthyPayload = {
  ok: true,
  service: "naughty-company-bot",
  database: true,
  encryption: true,
  discordConfigured: true,
  dashboardBinding: true,
  privateAlertDelivery: true
};
const validResponse = {
  status: 200,
  contentType: "application/json; charset=utf-8",
  payload: healthyPayload
};

test("accepts a healthy production Worker response", () => {
  assert.equal(assertProductionHealth(validResponse), true);
});

test("rejects non-200 HTTP responses", () => {
  assert.throws(() => assertProductionHealth({ ...validResponse, status: 503 }), /HTTP 200/);
});

test("rejects non-JSON responses", () => {
  assert.throws(() => assertProductionHealth({ ...validResponse, contentType: "text/html" }), /JSON/);
});

test("rejects malformed health payload shapes", () => {
  assert.throws(() => assertProductionHealth({ ...validResponse, payload: null }), /invalid JSON shape/);
  assert.throws(() => assertProductionHealth({ ...validResponse, payload: [] }), /invalid JSON shape/);
});

test("rejects a response from the wrong service or an unhealthy Worker", () => {
  assert.throws(() => assertProductionHealth({
    ...validResponse, payload: { ...healthyPayload, service: "another-worker" }
  }), /identity or status/);
  assert.throws(() => assertProductionHealth({
    ...validResponse, payload: { ...healthyPayload, ok: false }
  }), /identity or status/);
});

test("rejects every missing or false required configuration flag", () => {
  for (const flag of ["database", "encryption", "discordConfigured", "dashboardBinding", "privateAlertDelivery"]) {
    assert.throws(() => assertProductionHealth({
      ...validResponse,
      payload: { ...healthyPayload, [flag]: false }
    }), new RegExp("configuration flag: " + flag));
    const missing = { ...healthyPayload };
    delete missing[flag];
    assert.throws(() => assertProductionHealth({
      ...validResponse, payload: missing
    }), new RegExp("configuration flag: " + flag));
  }
});

console.log("PASS production health contract: healthy responses, HTTP/content-type errors, identity, payload shape, and required flags.");
