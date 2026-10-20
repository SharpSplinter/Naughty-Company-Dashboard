import assert from "node:assert/strict";
import {
  buildCostBreakdown,
  estimateDailyProfit,
  estimateWeeklyProfit,
  findAdvertisingBudget,
  knownWageSummary,
  stockOrderExpenses,
  stockInventorySummary,
  stockQuantityDeltaForReportingDays,
  summarizeMonthToDate
} from "./financials.mjs";

assert.equal(findAdvertisingBudget({ profile: { company: { advertising_budget: 5200000 } } }), 5200000);
assert.equal(findAdvertisingBudget({ profile: { company: {} } }), null);

const oilRigStock = {
  "Oil (Barrel)": { cost: 100, in_stock: 1177376, on_order: 0, price: 100, rrp: 100 }
};
assert.equal(stockOrderExpenses(oilRigStock).total, 0, "on-hand production stock must not be charged as a purchase");
assert.equal(stockOrderExpenses({ Tealight: { cost: 4, in_stock: 1000, on_order: 5 } }).total, 20, "only cost × on_order is an expense");
assert.equal(stockOrderExpenses({ "Produced item": { cost: "Cannot be ordered", in_stock: 500 } }).total, 0, "non-orderable stock has no purchase expense");
assert.equal(stockOrderExpenses({ Tealight: { cost: 4, in_stock: 1000 } }).available, false, "missing on_order must not silently become zero");
assert.equal(stockOrderExpenses({ Tealight: { on_order: 3, in_stock: 0 } }).total, null, "pending orders without unit cost must remain unavailable");
assert.equal(stockOrderExpenses({}).total, 0, "an explicit empty stock payload means there are no listed stock-order expenses");
assert.equal(stockOrderExpenses(null).total, null, "missing stock payload must remain unavailable");

const inventory = stockInventorySummary({
  stock: [
    { name: "Widget", in_stock: 5, price: 10, rrp: 12 },
    { name: "Gadget", in_stock: 3, price: 20, rrp: 25 }
  ]
});
assert.equal(inventory.itemCount, 2);
assert.equal(inventory.totalQuantity, 8);
assert.equal(inventory.totalValue, 110, "on-hand value must use quantity × listed unit price");
assert.equal(stockInventorySummary({ stock: [{ name: "Unknown price", in_stock: 5 }] }).totalValue, null,
  "partial stock prices must not be silently valued as zero");
assert.equal(stockInventorySummary(null).totalQuantity, null, "missing stock payload must remain unavailable");
assert.equal(stockInventorySummary([]).totalQuantity, 0, "an explicit empty stock response means zero on-hand units");

assert.equal(stockQuantityDeltaForReportingDays([
  { day: "2026-10-19", stockQuantity: 8, fetchedAt: "2026-10-19T18:10:00.000Z" },
  { day: "2026-10-20", stockQuantity: 10, fetchedAt: "2026-10-20T18:10:00.000Z" }
], "2026-10-20", "2026-10-19"), 2);
assert.equal(stockQuantityDeltaForReportingDays([
  { day: "2026-10-18", stockQuantity: 8 },
  { day: "2026-10-20", stockQuantity: 10 }
], "2026-10-20", "2026-10-19"), null,
  "stock delta must stay unavailable when the immediately previous reporting day is missing");

assert.deepEqual(knownWageSummary({ rosterCount: 2, knownWageCount: 2, totalKnownWages: 300 }), {
  available: true, total: 300, knownCount: 2, rosterCount: 2
});
assert.equal(knownWageSummary({ rosterCount: 2, knownWageCount: 1, totalKnownWages: 100 }).total, null);

const stockCosts = stockOrderExpenses(oilRigStock);
const wages = knownWageSummary({ rosterCount: 30, knownWageCount: 30, totalKnownWages: 78200000 });
const breakdown = buildCostBreakdown({ advertisingBudget: 5200000, wages: wages.total, stockSummary: stockCosts });
assert.equal(breakdown.total, 83400000);
assert.equal(estimateDailyProfit(119465920, breakdown), 36065920);
assert.equal(estimateWeeklyProfit(850324992, breakdown), 850324992 - (5200000 + 78200000) * 7);

const monthHistory = [
  { day: "2026-10-01", fetchedAt: "2026-10-01T20:00:00.000Z", dailyIncome: 100, advertisingBudget: 10, employeeWages: 20, stockOrderExpense: 3 },
  { day: "2026-10-02", fetchedAt: "2026-10-02T20:00:00.000Z", dailyIncome: 200, advertisingBudget: 20, employeeWages: 30, stockOrderExpense: 4 },
];
const monthToDate = summarizeMonthToDate(monthHistory, new Date("2026-10-02T20:30:00.000Z"));
assert.equal(monthToDate.month, "2026-10");
assert.equal(monthToDate.expectedDays, 2);
assert.equal(monthToDate.snapshotDays, 2);
assert.equal(monthToDate.monthlyIncome, 300, "monthly income must sum daily income in the current reporting month");
assert.equal(monthToDate.monthlyProfit, 213, "monthly profit must sum saved daily income minus that day's advertising, wages, and stock orders");
assert.equal(summarizeMonthToDate([monthHistory[1]], new Date("2026-10-02T20:30:00.000Z")).monthlyIncome, null, "missing days must not be treated as zero");
assert.equal(summarizeMonthToDate(monthHistory.map(point => ({ ...point, employeeWages: null })), new Date("2026-10-02T20:30:00.000Z")).monthlyProfit, null, "missing historical costs must not be treated as zero");

assert.equal(buildCostBreakdown({ advertisingBudget: null, wages: wages.total, stockSummary: stockCosts }).total, null);
assert.equal(buildCostBreakdown({ advertisingBudget: 5200000, wages: null, stockSummary: stockCosts }).total, null);
assert.equal(buildCostBreakdown({ advertisingBudget: 5200000, wages: wages.total, stockSummary: stockOrderExpenses(null) }).total, null);

console.log("PASS company financials: cost × on_order only, known wage coverage, and honest profit estimates.");
