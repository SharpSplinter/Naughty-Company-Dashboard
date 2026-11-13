import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.STAGING_PAGES_URL || "https://naughtyfamily-staging.pages.dev";
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
  const response = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(response?.ok(), `Staging portal returned HTTP ${response?.status()}`);

  await page.getByRole("button", { name: /Explore the demo dashboard/ }).click();
  await page.getByRole("button", { name: /Company Dashboard/ }).click();
  await page.locator(".company-module").waitFor({ state: "visible", timeout: 15000 });

  const primaryNav = page.getByRole("navigation", { name: "Company dashboard categories" });
  const companyNav = page.getByRole("navigation", { name: "Company pages" });
  await primaryNav.waitFor({ state: "visible" });
  await companyNav.waitFor({ state: "visible" });

  // Exercise navigation, not just a static screenshot of the landing panel.
  await primaryNav.getByRole("button", { name: "Insights", exact: true }).click();
  await companyNav.getByRole("button", { name: "Historical Trends", exact: true }).click();
  await page.getByText("History window", { exact: false }).waitFor({ state: "visible" });

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
      const rect = (element) => {
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
    console.log(`${ok ? "PASS" : "FAIL"} ${viewport.label}: ${JSON.stringify(metrics)}`);
    if (!ok) failures.push(`${viewport.label}: document overflow (${metrics.documentWidth}px for ${viewport.width}px viewport)`);
    assert.ok(metrics.shell && metrics.main && metrics.groupTabs && metrics.pageTabs, `${viewport.label}: Company workspace layout elements missing`);
    await page.screenshot({ path: `test-results/staging-responsive/${viewport.label}.png`, fullPage: true });
  }

  // Confirm a narrow screen can switch to another top-level area without losing the current Company shell.
  await page.setViewportSize({ width: 390, height: 844 });
  await primaryNav.getByRole("button", { name: "Rankings", exact: true }).click();
  await companyNav.getByRole("button", { name: "Faction Rankings", exact: true }).click();
  await page.locator(".company-module").waitFor({ state: "visible" });
  assert.equal(await page.locator(".sidebar").evaluate(element => getComputedStyle(element).display), "none");
  if (failures.length) throw new Error(failures.join("\\n"));
  console.log(`PASS responsive Company workspace checks at ${viewports.length} viewports; tab navigation and shared Faction shell verified.`);
} finally {
  await browser.close();
}
