import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.STAGING_PAGES_URL || "https://naughtyfamily-staging.pages.dev";
const apiBase = process.env.STAGING_API_URL || "https://naughtyfamily-api-staging.kboone801.workers.dev";
const sessionToken = process.env.STAGING_TEST_SESSION_TOKEN || "";
const otherSessionToken = process.env.STAGING_TEST_OTHER_SESSION_TOKEN || "";
const companyId = process.env.STAGING_TEST_COMPANY_ID || "";
const playerId = process.env.STAGING_TEST_PLAYER_ID || "";
const otherPlayerId = process.env.STAGING_TEST_OTHER_PLAYER_ID || "";
const primarySeries = JSON.parse(process.env.STAGING_TEST_EXPECTED_INCOME_SERIES || "[]");
const otherSeries = JSON.parse(process.env.STAGING_TEST_OTHER_INCOME_SERIES || "[]");

assert.ok(sessionToken && otherSessionToken && companyId && playerId && otherPlayerId, "Authenticated staging fixture variables are missing.");
assert.equal(primarySeries.length, 7, "Expected seven primary-owner historical income points.");
assert.equal(otherSeries.length, 7, "Expected seven second-owner historical income points.");

const historyUrl = apiBase + "/api/me/companies/" + encodeURIComponent(companyId) + "/history?days=90";
const authenticatedGet = (token, path) => fetch(path, {
  headers: { authorization: "Bearer " + token, accept: "application/json" },
});

async function loadPrivateHistory(token, label, expectedPlayerId, expectedSeries) {
  const sessionResponse = await authenticatedGet(token, apiBase + "/api/auth/session");
  assert.equal(sessionResponse.status, 200, label + " session should be accepted by the normal Worker session middleware.");
  const session = await sessionResponse.json();
  assert.equal(session.player.id, expectedPlayerId, label + " session should resolve to its own synthetic player ID.");
  assert.equal(session.isAdmin, false, label + " fixture must not receive administrator privileges.");

  const response = await authenticatedGet(token, historyUrl);
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, 200, label + " private history should load successfully.");
  assert.equal(payload?.company?.companyId, companyId, label + " should receive its own connected company record.");
  assert.equal(payload?.summary?.snapshotCount, 7, label + " should receive seven daily reporting points.");
  assert.deepEqual(payload.history.map(point => point.dailyIncome), expectedSeries, label + " must receive only its own daily-income series.");
  assert.deepEqual(payload.history.map(point => point.dailyProfit), expectedSeries.map(value => value - (label === "primary member" ? 151250 : 353150)));
  assert.ok(payload.history.every(point => point.dailyProfitSource === "reported"), label + " profit points should retain their reported source.");
  assert.ok(payload.history.every(point => point.advertisingBudget === (label === "primary member" ? 50000 : 120000)));
  assert.ok(payload.history.every(point => point.employeeWages === (label === "primary member" ? 100000 : 230000)));
  assert.ok(payload.history.every(point => point.stockOrderExpense === (label === "primary member" ? 1250 : 3150)));
  return payload;
}

// The history route must fail closed without a session.
const anonymousResponse = await fetch(historyUrl);
assert.equal(anonymousResponse.status, 401, "Unauthenticated history requests must be rejected.");
const primaryHistory = await loadPrivateHistory(sessionToken, "primary member", playerId, primarySeries);
const otherHistory = await loadPrivateHistory(otherSessionToken, "other member", otherPlayerId, otherSeries);

// Both synthetic members intentionally own a company with the same ID but different data.
// A response must be scoped to the bearer token's player_id, never just the company ID.
assert.notDeepEqual(primaryHistory.history.map(point => point.dailyIncome), otherHistory.history.map(point => point.dailyIncome));
assert.ok(!primaryHistory.history.some(point => otherSeries.includes(point.dailyIncome)), "Primary member response leaked the other member's income series.");
assert.ok(!otherHistory.history.some(point => primarySeries.includes(point.dailyIncome)), "Other member response leaked the primary member's income series.");
console.log("PASS authenticated history API: 7 private points per owner; anonymous requests rejected; same-company cross-member data remains isolated.");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const failures = [];
mkdirSync("test-results/staging-responsive", { recursive: true });

try {
  await page.addInitScript((token) => {
    localStorage.setItem("ncd_session", token);
    sessionStorage.removeItem("ncd_active_view");
  }, sessionToken);

  const response = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(response?.ok(), "Staging portal returned HTTP " + response?.status());
  const companyWorkspaceCard = page.getByRole("button", { name: /Company Dashboard/ });
  await companyWorkspaceCard.waitFor({ state: "visible", timeout: 20000 });
  await companyWorkspaceCard.click();
  await page.locator(".company-module").waitFor({ state: "visible", timeout: 15000 });

  const primaryNav = page.getByRole("navigation", { name: "Company dashboard categories" });
  const companyNav = page.getByRole("navigation", { name: "Company pages" });
  await primaryNav.waitFor({ state: "visible" });
  await companyNav.waitFor({ state: "visible" });

  // Navigate as an authenticated member into the real private-history view.
  await primaryNav.getByRole("button", { name: "Insights", exact: true }).click();
  const insightsNav = page.getByRole("navigation", { name: "Insights pages" });
  await insightsNav.waitFor({ state: "visible" });
  await insightsNav.getByRole("button", { name: "Historical Trends", exact: true }).click();

  const trendsPageHeading = page.locator(".company-module-heading h1").filter({
    hasText: /^Historical Trends and Comparisons$/,
  });
  await trendsPageHeading.waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await trendsPageHeading.count(), 1, "Expected one page-level Historical Trends heading.");

  const trendsToolbar = page.locator(".insights-range-toolbar");
  await trendsToolbar.waitFor({ state: "visible", timeout: 20000 });
  const historyWindow = trendsToolbar.getByRole("combobox", { name: "History window" });
  await historyWindow.waitFor({ state: "visible" });
  assert.equal(await historyWindow.inputValue(), "90", "Authenticated Trends should expose the default 90-day history selector.");

  const historyPanel = page.locator(".insights-table-panel");
  await historyPanel.waitFor({ state: "visible", timeout: 20000 });
  const historyRows = historyPanel.locator("tbody tr");
  await historyRows.first().waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await historyRows.count(), 7, "Authenticated private history table should render all seven saved reporting points.");

  const latestRowText = await historyRows.first().innerText();
  const format = value => Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const latestIncome = primarySeries[primarySeries.length - 1];
  const latestProfit = latestIncome - 151250;
  for (const expected of [latestIncome, latestProfit, 50000, 100000, 1250, 10600]) {
    assert.ok(latestRowText.includes(format(expected)), "Latest private history row is missing expected value " + format(expected) + ".");
  }
  assert.ok(!latestRowText.includes(format(otherSeries[otherSeries.length - 1])), "The rendered primary-member history table must not contain the other member's private income.");
  console.log("PASS authenticated private history UI: " + (await historyRows.count()) + " reporting rows, income/profit/cost/stock fields, and no second-member sentinel.");

  const viewports = [
    { width: 320, height: 720, label: "phone-320" },
    { width: 360, height: 800, label: "phone-360" },
    { width: 390, height: 844, label: "phone-390" },
    { width: 430, height: 932, label: "phone-430" },
    { width: 640, height: 900, label: "breakpoint-640" },
    { width: 768, height: 1024, label: "tablet-768" },
    { width: 1024, height: 768, label: "tablet-1024" },
    { width: 1440, height: 900, label: "desktop-1440" },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(80);
    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const shell = document.querySelector(".company-module");
      const main = document.querySelector(".company-module .main-area");
      const groups = document.querySelector(".company-workspace-groups");
      const tabs = document.querySelector(".company-workspace-views");
      const rect = element => {
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
      };
      return {
        viewportWidth: window.innerWidth,
        documentWidth: root.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        shell: rect(shell),
        main: rect(main),
        groupTabs: rect(groups),
        pageTabs: rect(tabs),
        groupTabsScrollable: !!groups && groups.scrollWidth > groups.clientWidth,
        pageTabsScrollable: !!tabs && tabs.scrollWidth > tabs.clientWidth,
      };
    });

    const ok = metrics.documentWidth <= viewport.width + 1 && metrics.bodyWidth <= viewport.width + 1;
    console.log((ok ? "PASS " : "FAIL ") + viewport.label + ": " + JSON.stringify(metrics));
    if (!ok) failures.push(viewport.label + ": document overflow (" + metrics.documentWidth + "px for " + viewport.width + "px viewport)");
    assert.ok(metrics.shell && metrics.main && metrics.groupTabs && metrics.pageTabs, viewport.label + ": Company workspace layout elements missing");
    await page.screenshot({ path: "test-results/staging-responsive/" + viewport.label + ".png", fullPage: true });
  }

  // Account Settings must fit the viewport without forcing document-level horizontal scrolling.
  const settingsPage = await context.newPage();
  await settingsPage.goto(baseUrl + "/settings", { waitUntil: "networkidle", timeout: 30000 });
  const settingsModule = settingsPage.locator(".settings-module");
  await settingsModule.waitFor({ state: "visible", timeout: 20000 });
  const settingsGrid = settingsModule.locator(".settings-grid");
  await settingsGrid.waitFor({ state: "visible", timeout: 10000 });
  for (const viewport of viewports) {
    await settingsPage.setViewportSize({ width: viewport.width, height: viewport.height });
    await settingsPage.waitForTimeout(80);
    const metrics = await settingsPage.evaluate(() => {
      const root = document.documentElement;
      const module = document.querySelector(".settings-module");
      const grid = document.querySelector(".settings-module .settings-grid");
      const cards = [...document.querySelectorAll(".settings-module .settings-card")];
      const bounds = element => {
        const box = element.getBoundingClientRect();
        return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
      };
      return {
        viewportWidth: window.innerWidth,
        documentWidth: root.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        module: bounds(module),
        grid: bounds(grid),
        rowGap: parseFloat(getComputedStyle(grid).rowGap) || 0,
        cards: cards.map(bounds),
      };
    });
    const withinViewport = metrics.documentWidth <= viewport.width + 1
      && metrics.bodyWidth <= viewport.width + 1
      && metrics.module.left >= -1
      && metrics.module.right <= viewport.width + 1
      && metrics.grid.left >= -1
      && metrics.grid.right <= viewport.width + 1
      && metrics.cards.every(card => card.left >= -1 && card.right <= viewport.width + 1);
    console.log((withinViewport ? "PASS " : "FAIL ") + "settings-" + viewport.label + ": " + JSON.stringify(metrics));
    assert.ok(withinViewport, "Account Settings overflowed or a card exceeded the viewport at " + viewport.label);
    assert.ok(metrics.rowGap >= 8, "Account Settings cards are too tightly spaced at " + viewport.label);
    await settingsPage.screenshot({ path: "test-results/staging-responsive/settings-" + viewport.label + ".png", fullPage: true });
  }
  await settingsPage.close();
  console.log("PASS Account Settings viewport bounds and card spacing at " + viewports.length + " viewports.");

  // Confirm a narrow screen can switch to another top-level area without losing the Company shell.
  await page.setViewportSize({ width: 390, height: 844 });
  await primaryNav.getByRole("button", { name: "Rankings", exact: true }).click();
  const rankingsNav = page.getByRole("navigation", { name: "Rankings pages" });
  await rankingsNav.waitFor({ state: "visible" });
  await rankingsNav.getByRole("button", { name: "Faction Rankings", exact: true }).click();
  await page.locator(".company-module").waitFor({ state: "visible" });
  assert.equal(await page.locator(".sidebar").evaluate(element => getComputedStyle(element).display), "none");
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("PASS responsive authenticated Company workspace checks at " + viewports.length + " viewports; Trends data and Rankings/Faction navigation verified.");
} finally {
  await browser.close();
}
