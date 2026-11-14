import { appendFile, readFile } from "node:fs/promises";

const STAGING_API_URL = "https://naughtyfamily-api-staging.kboone801.workers.dev";
const EXPECTED_PLAYER_ID = process.env.EXPECTED_TORN_PLAYER_ID || "351311";
const KEY = process.env.TORN_API_KEY_FULL_ACCESS || "";
const API_BASE = process.env.STAGING_API_URL || STAGING_API_URL;
const EVENT_YEARS = (process.env.HALLOWEEN_EVENT_YEARS || "2026")
  .split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value));
const CONSENT_MARKER = "I authorize use of repository secret TORN_API_KEY_FULL_ACCESS for my own Halloween historical User -> Log and User -> Attacks collection, including contribution of resulting event metrics to the authenticated Naughty Souls member archive, using the isolated naughtyfamily-staging API and database only.";

let sessionToken = "";
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function redactError(error) {
  return error instanceof Error ? error.message.replaceAll(KEY, "[REDACTED]") : "Unknown error";
}

async function fetchJson(url, options = {}, label = "request") {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(25000),
      headers: { accept: "application/json", ...(options.headers || {}) },
    });
  } catch {
    throw new Error(label + " failed due to a network or timeout error.");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : "HTTP " + response.status;
    throw new Error(label + " failed: " + message);
  }
  assert(body && typeof body === "object", label + " returned an invalid JSON response.");
  return body;
}

async function portal(path, options = {}) {
  const method = options.method || "GET";
  const headers = { accept: "application/json" };
  if (sessionToken) headers.authorization = "Bearer " + sessionToken;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetchJson(API_BASE + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }, method + " " + path);
}

async function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, lines.join("\n") + "\n");
}

async function validateRepositoryMarker() {
  const marker = await readFile(".github/HALLOWEEN_COLLECTION_RUN_NOW", "utf8");
  assert(marker.trim() === CONSENT_MARKER, "The one-time owner authorization marker is missing or does not match.");
}

async function validateTornKey() {
  assert(KEY.length >= 20, "Repository secret TORN_API_KEY_FULL_ACCESS is missing or malformed.");
  const info = await fetchJson("https://api.torn.com/v2/key/info", {
    headers: { authorization: "ApiKey " + KEY },
  }, "Torn key identity check");
  const root = info.info && typeof info.info === "object" ? info.info : info;
  const ownerId = String(root?.user?.id ?? "");
  const accessType = String(root?.access?.type ?? "");
  assert(ownerId === EXPECTED_PLAYER_ID,
    "The repository Full Access key does not belong to the configured owner account. No collection was started.");
  assert(accessType === "Full Access", "The supplied repository key does not report Full Access.");
  console.log("Torn key verified for owner account " + EXPECTED_PLAYER_ID + "; access=Full Access. Secret value suppressed.");
}

async function signInToStaging() {
  const payload = await fetchJson(API_BASE + "/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ apiKey: KEY }),
  }, "Staging portal sign-in");
  assert(typeof payload.token === "string" && payload.token.length > 20, "Staging sign-in did not return a session token.");
  assert(String(payload.player?.id ?? "") === EXPECTED_PLAYER_ID,
    "Staging sign-in resolved to a different Torn identity. No collection was started.");
  sessionToken = payload.token;
  console.log("Authenticated to isolated staging as the expected Naughty Souls member (Torn ID " + EXPECTED_PLAYER_ID + ").");
}

async function collectYear(year) {
  const window = await portal("/api/me/halloween/event-window?year=" + year);
  const personal = window.myWindow;
  assert(personal?.configured === true && personal.startAt && personal.endAt && personal.startTime,
    "Event " + year + " has no saved personal TCT start-time slot. No guessed time will be used; save the slot in the Halloween Live tab first.");
  console.log("Event " + year + " personal slot verified: " + personal.startTime + " TCT (" + personal.startAt + " through " + personal.endAt + ").");

  const consent = await portal("/api/me/halloween/key", {
    method: "POST",
    body: { consent: true, consentVersion: "halloween-history-v2" },
  });
  assert(consent.saved === true && consent.accessLevel === "Full Access",
    "The portal did not accept the Full Access key for the required Halloween Log and Attacks permissions.");
  console.log("Halloween historical collection consent and Full Access permissions validated for event " + year + ".");

  const queued = await portal("/api/me/halloween/collect", {
    method: "POST",
    body: { year },
  });
  assert(queued.queued === true || queued.alreadyComplete === true,
    "The event " + year + " collection was not queued: " + (queued.error || "unexpected queue response"));
  console.log("Event " + year + " collection request accepted; log=" +
    (queued.logCollection?.status || "unknown") + ", attacks=" + (queued.attackCollection?.status || "unknown") + ".");

  const deadline = Date.now() + 5 * 60 * 60 * 1000;
  let previousStatus = "";
  while (Date.now() < deadline) {
    const status = await portal("/api/me/halloween/archive?year=" + year);
    const mine = status.myCollection;
    assert(mine, "The staging archive did not return this member's event " + year + " collection status.");
    const logStatus = String(mine.collectionStatus || "not_collected");
    const coverage = String(mine.coverage || "not_collected");
    const attackStatus = String(mine.attackMetricsStatus || "not_collected");
    const outcomesStatus = String(mine.attackOutcomesStatus || "not_collected");
    const current = "coverage=" + coverage + "; logs=" + logStatus + "; attacks=" +
      attackStatus + "; outcomes=" + outcomesStatus + "; records=" + Number(mine.logsCollected || 0);
    if (current !== previousStatus) {
      console.log("Event " + year + " progress: " + current);
      previousStatus = current;
    }

    if (coverage === "complete" && attackStatus === "complete" && outcomesStatus === "complete") {
      const record = {
        year,
        startTime: personal.startTime,
        coverage,
        logStatus,
        attackStatus,
        outcomesStatus,
        logsCollected: Number(mine.logsCollected || 0),
        totalHits: mine.totalHits === null || mine.totalHits === undefined ? null : Number(mine.totalHits),
        lastCollectedAt: mine.lastCollectedAt || null,
      };
      results.push(record);
      console.log("Event " + year + " collection complete: " + record.logsCollected +
        " stored logs; coverage and detailed attack outcomes complete.");
      return;
    }

    if (["failed", "cancelled"].includes(logStatus) || ["failed", "cancelled"].includes(attackStatus)) {
      throw new Error("Event " + year + " collection stopped in a terminal state (" + current +
        "). Inspect the staging Worker queue/DLQ before retrying.");
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error("Event " + year + " collection exceeded the five-hour Actions monitoring window. Its current jobs remain in staging and can be inspected or resumed.");
}

async function main() {
  assert(API_BASE === STAGING_API_URL, "Refusing to run: API target is not the fixed naughtyfamily staging Worker.");
  assert(EVENT_YEARS.length > 0 && EVENT_YEARS.every((year) => year >= 2000 && year <= 2100),
    "No valid Halloween event years were supplied.");
  assert(EVENT_YEARS.every((year, index) => EVENT_YEARS.indexOf(year) === index),
    "Duplicate Halloween event years were supplied.");
  await validateRepositoryMarker();
  await validateTornKey();
  await signInToStaging();
  for (const year of EVENT_YEARS) await collectYear(year);
  console.log("All requested staging Halloween collections completed: " + EVENT_YEARS.join(", ") + ".");
}

try {
  await main();
} catch (error) {
  console.error("COLLECTION FAILED: " + redactError(error));
  await writeSummary([
    "# Halloween history collection",
    "",
    "**Result:** Failed or blocked safely.",
    "",
    "**Detail:** " + redactError(error),
    "",
    "No production Worker or production database was contacted.",
  ]).catch(() => {});
  process.exitCode = 1;
} finally {
  if (sessionToken) {
    try {
      await portal("/api/auth/sign-out", { method: "POST" });
      console.log("Staging portal session signed out.");
    } catch {
      console.error("Staging sign-out did not confirm; session remains protected by its normal expiry.");
    }
  }
  if (results.length) {
    await writeSummary([
      "# Halloween history collection",
      "",
      "**Result:** Complete.",
      "",
      "**Target:** " + STAGING_API_URL,
      "",
      "| Event year | Personal slot (TCT) | Coverage | Logs | Hits | Last collection |",
      "|---:|---:|---|---:|---:|---|",
      ...results.map((row) => "| " + row.year + " | " + row.startTime + " | " + row.coverage +
        " | " + row.logsCollected + " | " + (row.totalHits ?? "Unavailable") + " | " +
        (row.lastCollectedAt || "—") + " |"),
      "",
      "User API key value was not written to logs or artifacts. No production Worker or database was contacted.",
    ]).catch(() => {});
  }
}
