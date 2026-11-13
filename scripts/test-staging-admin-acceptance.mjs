import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const pagesUrl = process.env.STAGING_PAGES_URL || "https://naughtyfamily-staging.pages.dev";
const apiUrl = process.env.STAGING_API_URL || "https://naughtyfamily-api-staging.kboone801.workers.dev";
const memberToken = process.env.STAGING_TEST_SESSION_TOKEN || "";
const otherMemberToken = process.env.STAGING_TEST_OTHER_SESSION_TOKEN || "";
const adminToken = process.env.STAGING_TEST_ADMIN_SESSION_TOKEN || "";
const adminPlayerId = process.env.STAGING_TEST_ADMIN_PLAYER_ID || "";

assert.ok(memberToken && otherMemberToken && adminToken && adminPlayerId, "Admin acceptance fixture credentials are missing.");
mkdirSync("test-results/admin-acceptance", { recursive: true });

const adminEndpoints = [
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
];

async function apiRequest(path, token, method = "GET", body = undefined) {
  const started = performance.now();
  const response = await fetch(apiUrl + path, {
    method,
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const durationMs = Math.round((performance.now() - started) * 10) / 10;
  const payload = await response.json().catch(() => null);
  return { response, payload, durationMs };
}

const sessionAdmin = await apiRequest("/api/auth/session", adminToken);
assert.equal(sessionAdmin.response.status, 200, "Synthetic administrator session should authenticate.");
assert.equal(sessionAdmin.payload?.isAdmin, true, "Administrator session must resolve the live registry role.");
assert.equal(sessionAdmin.payload?.player?.id, adminPlayerId);
const sessionMember = await apiRequest("/api/auth/session", memberToken);
assert.equal(sessionMember.response.status, 200);
assert.equal(sessionMember.payload?.isAdmin, false, "Ordinary member session must not inherit administrator access.");

const anonymous = await apiRequest("/api/admin/overview", "");
assert.equal(anonymous.response.status, 401, "Anonymous administration requests must fail with 401.");

const deniedChecks = [
  ["/api/admin/overview", "GET"],
  ["/api/admin/members?limit=5", "GET"],
  ["/api/admin/settings", "GET"],
  ["/api/admin/administrators", "GET"],
  ["/api/admin/automation/runs?limit=2&days=7", "GET"],
  ["/api/admin/faction/weekly-boundaries?limit=1", "GET"],
  ["/api/admin/administrators/grant", "POST"],
];
const deniedResults = await Promise.all(deniedChecks.map(async ([path, method]) =>
  apiRequest(path, memberToken, method, method === "POST" ? { playerId: "not-a-torn-id" } : undefined)
));
for (let index = 0; index < deniedResults.length; index += 1) {
  assert.equal(deniedResults[index].response.status, 403, "Non-admin request must be blocked before route handling: " + deniedChecks[index][0]);
  assert.match(String(deniedResults[index].payload?.error || ""), /administrator access is required/i);
}
console.log("PASS role enforcement API: admin session recognized; member role remains non-admin; anonymous=401; all " + deniedChecks.length + " representative member attempts=403.");

const timing = [];
const roundSize = 5;
for (let round = 0; round < 2; round += 1) {
  for (let start = 0; start < adminEndpoints.length; start += roundSize) {
    const batch = adminEndpoints.slice(start, start + roundSize);
    const results = await Promise.all(batch.map(path => apiRequest(path, adminToken)));
    for (let index = 0; index < results.length; index += 1) {
      const entry = { round: round + 1, path: batch[index], status: results[index].response.status, durationMs: results[index].durationMs };
      timing.push(entry);
      assert.equal(entry.status, 200, "Administrator read endpoint failed: " + batch[index] + " returned " + entry.status);
    }
  }
}
const sorted = timing.map(item => item.durationMs).sort((a, b) => a - b);
const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
const requestBudget = {
  scope: "isolated staging D1 and Worker; authenticated read-only API calls; no Torn endpoints or mutating admin actions",
  adminReadRequests: timing.length,
  concurrency: "two rounds, batches of five concurrent GET requests",
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  maxMs: sorted[sorted.length - 1],
  endpointTimings: timing,
};
writeFileSync("test-results/admin-acceptance/request-budget.json", JSON.stringify(requestBudget, null, 2) + "\n");
console.log("PASS request-budget smoke: " + timing.length + " admin GETs in two five-request bursts; p50=" + requestBudget.p50Ms + "ms p95=" + requestBudget.p95Ms + "ms max=" + requestBudget.maxMs + "ms.");

const axeTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const accessibility = [];
const browserRequests = [];
const browser = await chromium.launch({ headless: true });
try {
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const memberPage = await memberContext.newPage();
  await memberPage.addInitScript(token => {
    localStorage.setItem("ncd_session", token);
    sessionStorage.removeItem("ncd_active_view");
  }, memberToken);
  const memberResponse = await memberPage.goto(pagesUrl, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(memberResponse?.ok(), "Member portal should load.");
  assert.equal(await memberPage.locator(".portal-card-admin").count(), 0, "A non-admin must not see the Admin Panel workspace card.");
  const memberAxe = await new AxeBuilder({ page: memberPage }).withTags(axeTags).analyze();
  accessibility.push({ view: "member-portal", violations: memberAxe.violations });
  await memberPage.screenshot({ path: "test-results/admin-acceptance/member-portal.png", fullPage: true });
  await memberPage.goto(pagesUrl + "/admin", { waitUntil: "networkidle", timeout: 30000 });
  await memberPage.getByRole("heading", { name: "Administrator access required" }).waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await memberPage.locator(".admin-console").count(), 0, "Direct /admin navigation must not mount admin UI for a member.");
  const blockedAxe = await new AxeBuilder({ page: memberPage }).withTags(axeTags).analyze();
  accessibility.push({ view: "member-direct-admin-denied", violations: blockedAxe.violations });
  await memberPage.screenshot({ path: "test-results/admin-acceptance/member-admin-denied.png", fullPage: true });
  await memberContext.close();
  console.log("PASS non-admin browser: no Admin Panel card; direct /admin route renders access-denied screen only.");

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const adminPage = await adminContext.newPage();
  adminPage.on("request", request => {
    const url = request.url();
    if (url.startsWith(apiUrl + "/api/admin/")) {
      browserRequests.push({ method: request.method(), path: new URL(url).pathname + new URL(url).search });
    }
  });
  await adminPage.addInitScript(token => {
    localStorage.setItem("ncd_session", token);
    sessionStorage.removeItem("ncd_active_view");
  }, adminToken);
  const adminResponse = await adminPage.goto(pagesUrl, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(adminResponse?.ok(), "Administrator portal should load.");
  const adminCard = adminPage.locator(".portal-card-admin");
  await adminCard.waitFor({ state: "visible", timeout: 15000 });
  await adminCard.click();
  await adminPage.locator(".admin-console").waitFor({ state: "visible", timeout: 20000 });
  await adminPage.getByText("ADMINISTRATOR VERIFIED", { exact: false }).waitFor({ state: "visible" });
  await adminPage.getByText("Read-only mode.", { exact: false }).waitFor({ state: "visible" });
  await adminPage.screenshot({ path: "test-results/admin-acceptance/admin-overview.png", fullPage: true });

  const sectionNames = [
    ["Overview", "System overview"],
    ["Members", "Member management"],
    ["Administrators", "Administrator management"],
    ["Operations", "Refresh and maintenance jobs"],
    ["History & Backups", "History and backups"],
    ["Global Settings", "Global dashboard settings"],
    ["Weekly Boundaries", "Sunday boundary diagnostics"],
    ["Audit Log", "Administrative audit log"],
  ];
  const adminNav = adminPage.getByRole("navigation", { name: "Administration sections" });
  for (const [label, heading] of sectionNames) {
    const tab = adminNav.getByRole("button", { name: label, exact: true });
    await tab.click();
    await adminPage.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible", timeout: 15000 });
    const activeCount = await adminNav.locator('[aria-current="page"]').count();
    assert.equal(activeCount, 1, "Exactly one admin section should expose aria-current=page after selecting " + label);
    const scan = await new AxeBuilder({ page: adminPage }).withTags(axeTags).analyze();
    accessibility.push({ view: "admin-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), violations: scan.violations });
  }
  await adminNav.getByRole("button", { name: "Administrators", exact: true }).click();
  await adminPage.getByRole("heading", { name: "Administrator management", exact: true }).waitFor({ state: "visible" });
  assert.equal(await adminPage.getByRole("button", { name: "Grant administrator", exact: true }).isDisabled(), true, "Role grants must remain disabled in read-only mode.");
  await adminNav.getByRole("button", { name: "Operations", exact: true }).click();
  await adminPage.getByRole("heading", { name: "Refresh and maintenance jobs", exact: true }).waitFor({ state: "visible" });
  assert.equal(await adminPage.getByRole("button", { name: "Queue selected endpoint refresh ↻", exact: true }).isDisabled(), true, "Refresh jobs must remain disabled in read-only mode.");
  await adminPage.screenshot({ path: "test-results/admin-acceptance/admin-operations-readonly.png", fullPage: true });

  const counts = {};
  for (const item of browserRequests) counts[item.path] = (counts[item.path] || 0) + 1;
  const nonGetRequests = browserRequests.filter(item => item.method !== "GET");
  assert.equal(nonGetRequests.length, 0, "Read-only admin walkthrough must not issue any admin mutations.");
  assert.ok(browserRequests.length <= 14, "Admin tab walkthrough exceeded the 14-request UI read budget: " + browserRequests.length);
  assert.ok((counts["/api/admin/members?limit=50"] || 0) <= 2, "Member list was fetched more than twice.");
  assert.ok((counts["/api/admin/history/summary"] || 0) <= 1, "History summary should only be loaded once during the walkthrough.");
  console.log("PASS admin UI: all eight sections opened; active nav is announced; grants and refresh actions stay disabled; " + browserRequests.length + " GETs, zero mutations.");

  const allViolations = accessibility.flatMap(result => result.violations.map(violation => ({
    view: result.view,
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })),
  })));
  const accessibilityReport = { tags: axeTags, scans: accessibility.length, violationCount: allViolations.length, violations: allViolations };
  writeFileSync("test-results/admin-acceptance/accessibility.json", JSON.stringify(accessibilityReport, null, 2) + "\n");
  const serious = allViolations.filter(item => item.impact === "critical" || item.impact === "serious");
  console.log("ACCESSIBILITY: " + accessibility.length + " screens scanned; " + allViolations.length + " violations (" + serious.length + " serious/critical).");
  for (const item of allViolations.slice(0, 30)) console.log("AXE " + item.impact + " " + item.id + " [" + item.view + "]: " + item.help + " :: " + item.nodes.map(node => node.target.join(" ")).join("; "));
  assert.equal(serious.length, 0, "Accessibility scan found serious or critical WCAG violations; inspect accessibility.json.");
  await adminContext.close();
} finally {
  await browser.close();
}
console.log("PASS staging admin/non-admin E2E, WCAG 2.1 A/AA automated scan and read-only request-budget smoke.");
