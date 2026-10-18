const isNumber = value => typeof value === "number" && Number.isFinite(value);
const firstNumber = (...values) => values.find(isNumber);

export function findAdvertisingBudget(profile) {
  const keys = ["advertisement_budget", "advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return null;
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = visit(child, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    for (const key of keys) if (isNumber(value[key])) return Math.max(0, value[key]);
    for (const nested of Object.values(value)) {
      const found = visit(nested, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(profile);
}

export function stockOrderExpenses(stock) {
  if (stock === null || stock === undefined || (typeof stock !== "object")) {
    return { available: false, total: null, itemCount: 0, orderedItems: [], unknownItems: [] };
  }

  const rows = [];
  const visit = (value, depth = 0, label = "") => {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, depth + 1, String(index + 1)));
      return;
    }
    const hasOwn = key => Object.prototype.hasOwnProperty.call(value, key);
    const unitCost = firstNumber(value.cost, value.unit_cost, value.cost_per_unit, value.purchase_price);
    const hasCostField = ["cost", "unit_cost", "cost_per_unit", "purchase_price"].some(hasOwn);
    const hasOrderField = ["on_order", "onOrder"].some(hasOwn);
    const hasInventoryField = ["in_stock", "quantity", "amount", "price", "rrp"].some(hasOwn);
    const rowLike = hasOrderField || (hasCostField && hasInventoryField);
    if (rowLike) {
      rows.push({
        name: String(value.name || value.item_name || value.itemName || label || "Stock item"),
        order: firstNumber(value.on_order, value.onOrder),
        unitCost,
        rawCost: value.cost,
        hasOrderField
      });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") visit(child, depth + 1, key);
    }
  };
  visit(stock);

  let total = 0;
  let complete = true;
  const orderedItems = [];
  const unknownItems = [];
  for (const row of rows) {
    const nonOrderable = typeof row.rawCost === "string" && /cannot be ordered/i.test(row.rawCost);
    if (row.order === undefined) {
      // The Wiki explicitly marks some products as non-orderable; a zero unit cost is also zero expense.
      if (nonOrderable || row.unitCost === 0) continue;
      complete = false;
      unknownItems.push(row.name);
      continue;
    }
    const order = Math.max(0, row.order);
    if (order === 0) continue;
    if (row.unitCost === undefined) {
      complete = false;
      unknownItems.push(row.name);
      continue;
    }
    const amount = order * Math.max(0, row.unitCost);
    total += amount;
    orderedItems.push({ name: row.name, onOrder: order, unitCost: row.unitCost, total: amount });
  }

  return {
    available: complete,
    total: complete ? total : null,
    itemCount: rows.length,
    orderedItems,
    unknownItems
  };
}

export function knownWageSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return { available: false, total: null, knownCount: null, rosterCount: null };
  }
  const rosterCount = isNumber(summary.rosterCount) && summary.rosterCount >= 0 ? summary.rosterCount : null;
  const knownCount = isNumber(summary.knownWageCount) && summary.knownWageCount >= 0 ? summary.knownWageCount : null;
  const total = isNumber(summary.totalKnownWages) && summary.totalKnownWages >= 0 ? summary.totalKnownWages : null;
  const available = rosterCount !== null && knownCount === rosterCount && total !== null;
  return { available, total: available ? total : null, knownCount, rosterCount };
}

export function buildCostBreakdown({ advertisingBudget, wages, stockSummary }) {
  const adBudget = isNumber(advertisingBudget) && advertisingBudget >= 0 ? advertisingBudget : null;
  const totalWages = isNumber(wages) && wages >= 0 ? wages : null;
  const stockCosts = stockSummary?.available === true && isNumber(stockSummary.total) && stockSummary.total >= 0
    ? stockSummary.total
    : null;
  const dailyRecurringCosts = adBudget !== null && totalWages !== null ? adBudget + totalWages : null;
  const total = dailyRecurringCosts !== null && stockCosts !== null ? dailyRecurringCosts + stockCosts : null;
  return { adBudget, wages: totalWages, stockCosts, dailyRecurringCosts, total, complete: total !== null };
}

export function estimateDailyProfit(dailyIncome, breakdown) {
  return isNumber(dailyIncome) && breakdown?.total !== null && isNumber(breakdown?.total)
    ? dailyIncome - breakdown.total
    : null;
}

export function estimateWeeklyProfit(weeklyIncome, breakdown) {
  return isNumber(weeklyIncome) && isNumber(breakdown?.dailyRecurringCosts) && isNumber(breakdown?.stockCosts)
    ? weeklyIncome - breakdown.dailyRecurringCosts * 7 - breakdown.stockCosts
    : null;
}


export function summarizeMonthToDate(history, now = new Date()) {
  const timestamp = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    return { month: null, startDay: null, reportingDay: null, expectedDays: 0, snapshotDays: 0, incomeDays: 0, costDays: 0, monthlyIncome: null, monthlyProfit: null };
  }

  // Torn's company reporting day rolls over at 18:00 UTC, matching the daily lock-in snapshots.
  const reportingDay = new Date(timestamp - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const month = reportingDay.slice(0, 7);
  const startDay = month + "-01";
  const expectedDays = Number(reportingDay.slice(8, 10));
  const pointsByDay = new Map();

  for (const point of Array.isArray(history) ? history : []) {
    const day = typeof point?.day === "string" ? point.day : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < startDay || day > reportingDay) continue;
    const existing = pointsByDay.get(day);
    const currentTime = Date.parse(point.fetchedAt || "");
    const existingTime = Date.parse(existing?.fetchedAt || "");
    if (!existing || (Number.isFinite(currentTime) && (!Number.isFinite(existingTime) || currentTime >= existingTime))) pointsByDay.set(day, point);
  }

  const rows = Array.from(pointsByDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  const numeric = value => typeof value === "number" && Number.isFinite(value);
  const incomeRows = rows.filter(point => numeric(point.dailyIncome));
  const completeProfitRows = rows.filter(point =>
    numeric(point.dailyIncome) &&
    numeric(point.advertisingBudget) &&
    numeric(point.employeeWages) &&
    numeric(point.stockOrderExpense)
  );
  const fullMonthToDateCoverage = rows.length === expectedDays && rows.every((point, index) => point.day === startDay.slice(0, 8) + String(index + 1).padStart(2, "0"));
  const incomeComplete = fullMonthToDateCoverage && incomeRows.length === expectedDays;
  const profitComplete = fullMonthToDateCoverage && completeProfitRows.length === expectedDays;

  return {
    month,
    startDay,
    reportingDay,
    expectedDays,
    snapshotDays: rows.length,
    incomeDays: incomeRows.length,
    costDays: completeProfitRows.length,
    monthlyIncome: incomeComplete ? incomeRows.reduce((sum, point) => sum + point.dailyIncome, 0) : null,
    monthlyProfit: profitComplete ? completeProfitRows.reduce((sum, point) => sum + point.dailyIncome - point.advertisingBudget - point.employeeWages - point.stockOrderExpense, 0) : null
  };
}
