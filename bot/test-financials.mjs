import assert from "node:assert/strict";
import {
  buildCostBreakdown,
  estimateDailyProfit,
  estimateWeeklyProfit,
  findAdvertisingBudget,
  knownWageSummary,
  stockOrderExpenses
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
assert.equal(buildCostBreakdown({ advertisingBudget: null, wages: wages.total, stockSummary: stockCosts }).total, null);
assert.equal(buildCostBreakdown({ advertisingBudget: 5200000, wages: null, stockSummary: stockCosts }).total, null);
assert.equal(buildCostBreakdown({ advertisingBudget: 5200000, wages: wages.total, stockSummary: stockOrderExpenses(null) }).total, null);

console.log("PASS company financials: cost × on_order only, known wage coverage, and honest profit estimates.");
