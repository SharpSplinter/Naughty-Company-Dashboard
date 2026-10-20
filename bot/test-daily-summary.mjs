import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailySummaryMessage,
  calculateRankingMetrics,
  isDailySummaryDue,
  previousReportingDay,
  reportingDayAt,
  summaryMetricValues,
} from "./daily-summary.mjs";

test("Torn reporting day rolls over at 18:00 UTC and daily report waits until 18:20 UTC", () => {
  assert.equal(reportingDayAt("2026-10-20T17:59:59.000Z"), "2026-10-19");
  assert.equal(reportingDayAt("2026-10-20T18:00:00.000Z"), "2026-10-20");
  assert.equal(isDailySummaryDue("2026-10-20T18:19:59.000Z"), false);
  assert.equal(isDailySummaryDue("2026-10-20T18:20:00.000Z"), true);
  assert.equal(previousReportingDay("2026-10-20"), "2026-10-19");
});

test("ranking and next-star gap use same-type companies and correct next-star benchmark", () => {
  const rankings = [
    { companyId: "self", companyType: "Oil Rig", companyTypeId: 28, starRating: 5, weeklyIncome: 700 },
    { companyId: "ahead", companyType: "Oil Rig", companyTypeId: 28, starRating: 5, weeklyIncome: 900 },
    { companyId: "next-low", companyType: "Oil Rig", companyTypeId: 28, starRating: 6, weeklyIncome: 950 },
    { companyId: "next-high", companyType: "Oil Rig", companyTypeId: 28, starRating: 6, weeklyIncome: 1000 },
    { companyId: "other", companyType: "Casino", companyTypeId: 7, starRating: 9, weeklyIncome: 100 },
  ];
  assert.deepEqual(calculateRankingMetrics({
    companyId: "self", companyType: "Oil Rig", companyTypeId: 28, weeklyIncome: 700, starLevel: 5,
  }, rankings), { companyRank: 2, starIncomeGap: 250 });
});

test("metric history remains unknown instead of treating a missing snapshot as zero", () => {
  const values = summaryMetricValues(null, [], { companyId: "1", companyType: "Oil Rig", companyTypeId: 28 });
  assert.equal(values.dailyIncome, null);
  assert.equal(values.dailyProfit, null);
  assert.equal(values.stockQuantity, null);
  assert.equal(values.companyRank, null);
});

test("single daily message includes each requested metric and prior-day direction", () => {
  const message = buildDailySummaryMessage({
    reportingDay: "2026-10-20",
    companies: [{
      name: "Example Oil",
      snapshotDay: "2026-10-20",
      previousDayAvailable: true,
      metrics: { dailyIncome: 150, dailyProfit: 70, starLevel: 6, starIncomeGap: 200, companyRank: 12, stockQuantity: 900 },
      previousMetrics: { dailyIncome: 100, dailyProfit: 90, starLevel: 5, starIncomeGap: 250, companyRank: 18, stockQuantity: 800 },
    }],
  });
  for (const expected of [
    "DAILY COMPANY SUMMARY", "Daily income: $150", "gained $50 vs prior day",
    "Daily profit: $70", "lost $20 vs prior day", "Star level: 6 ★",
    "gained 1 star level", "Income gap to next star: $200", "gap narrowed by $50",
    "Company rank: #12", "gained 6 places", "Stock quantity: 900", "gained 100 units",
  ]) assert.ok(message.includes(expected), `expected summary to include: ${expected}`);
  assert.ok(message.length <= 1900);
});

test("rank improvements and losses are reported in the correct direction", () => {
  const message = buildDailySummaryMessage({
    reportingDay: "2026-10-20",
    companies: [{
      name: "Rank Shift",
      previousDayAvailable: true,
      metrics: { companyRank: 25, starIncomeGap: 300 },
      previousMetrics: { companyRank: 20, starIncomeGap: 200 },
    }],
  });
  assert.ok(message.includes("lost 5 places"));
  assert.ok(message.includes("gap widened by $100"));
});

test("no prior value is reported as unavailable, not zero", () => {
  const message = buildDailySummaryMessage({
    reportingDay: "2026-10-20",
    companies: [{
      name: "New company",
      metrics: { dailyIncome: 123 },
      previousMetrics: {},
      previousDayAvailable: false,
    }],
  });
  assert.ok(message.includes("Daily income: $123"));
  assert.ok(message.includes("change unavailable (prior-day value missing)"));
  assert.ok(message.includes("Prior-day comparison unavailable"));
});

console.log("PASS daily company summary: reporting-day boundary, delay, rank math, metric deltas, and missing-data handling.");
