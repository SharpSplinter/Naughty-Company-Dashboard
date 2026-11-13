import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const apiUrl = process.env.STAGING_API_URL || "https://naughtyfamily-api-staging.kboone801.workers.dev";
const adminToken = process.env.STAGING_TEST_ADMIN_SESSION_TOKEN || "";
const durationSeconds = Number(process.env.STAGING_LOAD_DURATION_SECONDS || 300);
const requestsPerSecond = Number(process.env.STAGING_LOAD_REQUESTS_PER_SECOND || 5);
const maxConcurrency = Number(process.env.STAGING_LOAD_MAX_CONCURRENCY || 8);
const timeoutMs = Number(process.env.STAGING_LOAD_TIMEOUT_MS || 15000);

assert.ok(adminToken, "Synthetic staging administrator token is required.");
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 60 && durationSeconds <= 600, "Load duration must be 60–600 seconds.");
assert.ok(Number.isFinite(requestsPerSecond) && requestsPerSecond >= 1 && requestsPerSecond <= 20, "Rate must be 1–20 requests/second.");
assert.ok(Number.isInteger(maxConcurrency) && maxConcurrency >= 1 && maxConcurrency <= 16, "Concurrency must be 1–16.");

const endpoints = [
  "/api/admin/overview",
  "/api/admin/members?limit=10",
  "/api/admin/jobs?limit=10",
  "/api/admin/settings",
  "/api/admin/history/summary",
  "/api/admin/audit?limit=10",
  "/api/admin/administrators",
  "/api/admin/faction/weekly-boundaries?limit=2",
  "/api/admin/automation/runs?limit=5&days=7",
  "/api/admin/member-activity?days=7",
  "/api/admin/private-live",
];
const totalPlanned = durationSeconds * requestsPerSecond;
const intervalMs = 1000 / requestsPerSecond;
const timings = [];
const pending = new Set();
let active = 0;
let observedMaxConcurrency = 0;
let attempted = 0;
const startedAt = performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readOnlyRequest(path, sequence) {
  const requestStarted = performance.now();
  active += 1;
  observedMaxConcurrency = Math.max(observedMaxConcurrency, active);
  try {
    const response = await fetch(apiUrl + path, {
      method: "GET",
      headers: { authorization: "Bearer " + adminToken, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the response without retaining member or diagnostic payloads in the report.
    await response.arrayBuffer();
    return {
      sequence,
      path,
      status: response.status,
      durationMs: Math.round((performance.now() - requestStarted) * 10) / 10,
      ok: response.status === 200,
      error: null,
    };
  } catch (error) {
    return {
      sequence,
      path,
      status: 0,
      durationMs: Math.round((performance.now() - requestStarted) * 10) / 10,
      ok: false,
      error: error instanceof Error ? error.name : "request-failed",
    };
  } finally {
    active -= 1;
  }
}

for (let index = 0; index < totalPlanned; index += 1) {
  const targetStart = startedAt + index * intervalMs;
  const waitMs = targetStart - performance.now();
  if (waitMs > 0) await sleep(waitMs);
  while (pending.size >= maxConcurrency) await Promise.race(pending);
  const requestPromise = readOnlyRequest(endpoints[index % endpoints.length], index + 1)
    .then(result => { timings.push(result); return result; });
  pending.add(requestPromise);
  requestPromise.finally(() => pending.delete(requestPromise));
  attempted += 1;
}
await Promise.all(pending);
const elapsedMs = performance.now() - startedAt;
const sorted = timings.map(item => item.durationMs).sort((a, b) => a - b);
const percentile = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
const failures = timings.filter(item => !item.ok);
const byEndpoint = {};
for (const item of timings) {
  byEndpoint[item.path] ||= { requests: 0, failures: 0, p95Ms: 0, maxMs: 0, samples: [] };
  const bucket = byEndpoint[item.path];
  bucket.requests += 1;
  if (!item.ok) bucket.failures += 1;
  bucket.samples.push(item.durationMs);
  bucket.maxMs = Math.max(bucket.maxMs, item.durationMs);
}
for (const bucket of Object.values(byEndpoint)) {
  bucket.samples.sort((a, b) => a - b);
  bucket.p95Ms = bucket.samples[Math.min(bucket.samples.length - 1, Math.ceil(bucket.samples.length * 0.95) - 1)];
  delete bucket.samples;
}
const report = {
  generatedAt: new Date().toISOString(),
  environment: "isolated staging Worker and acceptance D1 only",
  scope: "authenticated administrator GET requests; eleven read-only diagnostics endpoints; no writes, no queue jobs, no Torn API calls",
  plannedDurationSeconds: durationSeconds,
  elapsedSeconds: Math.round(elapsedMs / 100) / 10,
  targetRequestsPerSecond: requestsPerSecond,
  achievedRequestsPerSecond: Math.round((timings.length / (elapsedMs / 1000)) * 100) / 100,
  maxConcurrencyConfigured: maxConcurrency,
  observedMaxConcurrency,
  plannedRequests: totalPlanned,
  attemptedRequests: attempted,
  completedRequests: timings.length,
  failures: failures.length,
  failureRatePercent: Math.round((failures.length / Math.max(1, timings.length)) * 10000) / 100,
  latencyMs: {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  },
  byEndpoint,
  failuresByStatus: failures.reduce((result, item) => {
    const key = item.status ? String(item.status) : item.error || "network-error";
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {}),
  endpointTimings: timings,
};
mkdirSync("test-results/staging-load", { recursive: true });
writeFileSync("test-results/staging-load/sustained-load.json", JSON.stringify(report, null, 2) + "\n");
console.log("STAGING LOAD SUMMARY " + JSON.stringify({
  elapsedSeconds: report.elapsedSeconds,
  requests: report.completedRequests,
  achievedRps: report.achievedRequestsPerSecond,
  concurrency: report.observedMaxConcurrency,
  failureRatePercent: report.failureRatePercent,
  p50Ms: report.latencyMs.p50,
  p95Ms: report.latencyMs.p95,
  p99Ms: report.latencyMs.p99,
  maxMs: report.latencyMs.max,
}));
assert.equal(failures.length, 0, "Sustained staging GET load produced non-200 responses or network errors. Inspect sustained-load.json.");
assert.ok(report.latencyMs.p95 <= 1500, "Staging sustained-load p95 exceeded 1.5 seconds.");
assert.ok(report.latencyMs.p99 <= 3000, "Staging sustained-load p99 exceeded 3 seconds.");
assert.ok(report.latencyMs.max <= 10000, "A staging request exceeded the 10-second hard latency guard.");
assert.ok(observedMaxConcurrency <= maxConcurrency, "Observed request concurrency exceeded its configured ceiling.");
console.log("PASS five-minute paced, concurrent, read-only staging admin load test.");
