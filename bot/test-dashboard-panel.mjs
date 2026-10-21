import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardPanelComponents,
  dashboardPanelCustomId,
  isDashboardPanelView,
  parseDashboardPanelCustomId
} from "./dashboard-panel.mjs";

test("panel custom IDs bind every action to a single owner and supported view", () => {
  const ownerId = "123456789012345678";
  for (const view of ["home", "company", "rankings", "automation", "alerts", "trends"]) {
    const id = dashboardPanelCustomId(ownerId, view);
    assert.ok(id.length <= 100);
    assert.deepEqual(parseDashboardPanelCustomId(id), { version: 1, ownerId, view, refresh: false });
  }
  assert.deepEqual(parseDashboardPanelCustomId(dashboardPanelCustomId(ownerId, "refresh-rankings")), {
    version: 1, ownerId, view: "rankings", refresh: true
  });
});

test("panel router rejects unknown actions, versions, malformed payloads, and oversized IDs", () => {
  for (const invalid of [
    null, undefined, {}, "", "ncdash:v2:123456789012345678:home",
    "ncdash:v1:123456789012345678:settings",
    "ncdash:v1:123456789012345678:automation:delete",
    "ncdash:v1::home",
    "ncdash:v1:123456789012345678:refresh-settings",
    "x".repeat(101)
  ]) assert.equal(parseDashboardPanelCustomId(invalid), null, String(invalid));

  assert.throws(() => dashboardPanelCustomId("owner:other", "home"), /owner/);
  assert.throws(() => dashboardPanelCustomId("123456789012345678", "unlink"), /allowlisted/);
  assert.equal(isDashboardPanelView("home"), true);
  assert.equal(isDashboardPanelView("settings"), false);
});

test("panel exposes six destinations over two valid button rows and includes a scoped refresh", () => {
  const userId = "123456789012345678";
  const rows = buildDashboardPanelComponents(userId, "company");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.type === 1));
  assert.ok(rows.every(row => row.components.length <= 5));
  assert.deepEqual(rows.map(row => row.components.length), [3, 4]);
  const buttons = rows.flatMap(row => row.components);
  assert.deepEqual(buttons.map(button => button.label), ["Home", "Company", "Rankings", "Automation", "Alerts", "Trends", "Refresh"]);
  assert.ok(buttons.every(component => component.type === 2));
  assert.ok(buttons.every(component => component.custom_id.length <= 100));
  assert.equal(buttons.find(component => component.label === "Company").style, 1);
  assert.equal(buttons.find(component => component.label === "Home").style, 2);
  assert.equal(buttons.find(component => component.label === "Alerts").style, 2);
  assert.equal(buttons.find(component => component.label === "Trends").style, 2);
  assert.deepEqual(parseDashboardPanelCustomId(buttons.find(component => component.label === "Refresh").custom_id), {
    version: 1, ownerId: userId, view: "company", refresh: true
  });
  assert.throws(() => buildDashboardPanelComponents(userId, "settings"), /allowlisted/);
});

console.log("PASS Discord dashboard panel contract: allowlisted owner-bound actions, versioned custom IDs, and bounded component rows.");
