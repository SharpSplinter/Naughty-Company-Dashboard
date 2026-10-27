const isFiniteNumber = value => typeof value === "number" && Number.isFinite(value);

export function reportingDayAt(value = new Date()) {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("A valid date is required.");
  // Torn company reporting days roll over at 18:00 UTC.
  return new Date(timestamp - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function previousReportingDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new TypeError("A reporting day must be YYYY-MM-DD.");
  const timestamp = Date.parse(String(day) + "T12:00:00.000Z");
  if (!Number.isFinite(timestamp)) throw new TypeError("A valid reporting day is required.");
  return new Date(timestamp - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isDailySummaryDue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.getUTCHours() > 18 || (date.getUTCHours() === 18 && date.getUTCMinutes() >= 20);
}

export function calculateRankingMetrics(company, rankingRows) {
  const weeklyIncome = isFiniteNumber(company?.weeklyIncome) ? company.weeklyIncome : null;
  const starLevel = isFiniteNumber(company?.starLevel) ? company.starLevel : null;
  if (!Array.isArray(rankingRows) || rankingRows.length === 0) return { companyRank: null, starIncomeGap: null };

  const sameType = row => {
    if (!row || typeof row !== "object") return false;
    const targetId = company?.companyTypeId;
    const rowId = row.companyTypeId ?? row.company_type_id ?? row.typeId;
    if (targetId != null && rowId != null) return String(targetId) === String(rowId);
    const targetName = String(company?.companyType ?? "").trim().toLocaleLowerCase();
    const rowName = String(row.companyType ?? row.company_type ?? row.typeName ?? "").trim().toLocaleLowerCase();
    return Boolean(targetName && rowName && targetName === rowName);
  };
  const peers = rankingRows.filter(row => sameType(row) && isFiniteNumber(row.weeklyIncome ?? row.weekly_income));
  let companyRank = null;
  if (weeklyIncome !== null && peers.length > 0) {
    companyRank = 1 + peers.filter(row =>
      String(row.companyId ?? row.company_id) !== String(company.companyId) &&
      Number(row.weeklyIncome ?? row.weekly_income) > weeklyIncome
    ).length;
    if (!peers.some(row => String(row.companyId ?? row.company_id) === String(company.companyId))) {
      // The current company is still rankable when it is missing from the cached list.
      companyRank = 1 + peers.filter(row => Number(row.weeklyIncome ?? row.weekly_income) > weeklyIncome).length;
    }
  }

  let starIncomeGap = null;
  if (weeklyIncome !== null && starLevel !== null) {
    const higherStarPeers = peers.filter(row => {
      const rowStar = row.starRating ?? row.star_rating ?? row.rating;
      return isFiniteNumber(rowStar) && rowStar > starLevel;
    });
    if (higherStarPeers.length) {
      const nextStar = Math.min(...higherStarPeers.map(row => Number(row.starRating ?? row.star_rating ?? row.rating)));
      const nextStarIncome = Math.min(...higherStarPeers
        .filter(row => Number(row.starRating ?? row.star_rating ?? row.rating) === nextStar)
        .map(row => Number(row.weeklyIncome ?? row.weekly_income)));
      starIncomeGap = Math.max(0, nextStarIncome - weeklyIncome);
    }
  }
  return { companyRank, starIncomeGap };
}

const money = value => isFiniteNumber(value)
  ? "$" + Math.round(value).toLocaleString("en-US")
  : "Not available";
const quantity = value => isFiniteNumber(value)
  ? Math.round(value).toLocaleString("en-US")
  : "Not available";

function movement(metric, current, previous) {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous)) return "change unavailable (prior-day value missing)";
  const delta = current - previous;
  if (delta === 0) return "no change vs prior day";
  const amount = Math.abs(delta);
  if (metric === "starLevel") return delta > 0
    ? `gained ${amount} star level${amount === 1 ? "" : "s"} vs prior day`
    : `lost ${amount} star level${amount === 1 ? "" : "s"} vs prior day`;
  if (metric === "companyRank") return delta < 0
    ? `gained ${amount} place${amount === 1 ? "" : "s"} vs prior day`
    : `lost ${amount} place${amount === 1 ? "" : "s"} vs prior day`;
  if (metric === "starIncomeGap") return delta < 0
    ? `gap narrowed by ${money(amount)} (gained ground)`
    : `gap widened by ${money(amount)} (lost ground)`;
  if (metric === "stockQuantity") return delta > 0
    ? `gained ${quantity(amount)} units vs prior day`
    : `lost ${quantity(amount)} units vs prior day`;
  return delta > 0
    ? `gained ${money(amount)} vs prior day`
    : `lost ${money(amount)} vs prior day`;
}

function metricLine(label, metric, current, previous) {
  const formatted = metric === "starLevel"
    ? (isFiniteNumber(current) ? `${current} ★` : "Not available")
    : metric === "companyRank"
      ? (isFiniteNumber(current) ? `#${current}` : "Not available")
      : metric === "stockQuantity"
        ? quantity(current)
        : money(current);
  return `• ${label}: ${formatted} | ${movement(metric, current, previous)}`;
}

export function buildDailySummaryMessage({ reportingDay, companies }) {
  const blocks = [`📊 DAILY COMPANY SUMMARY · ${reportingDay}`, "Changes are versus the previous Torn reporting day."];
  const source = Array.isArray(companies) ? companies : [];
  if (!source.length) blocks.push("", "No connected company data was available for this report.");
  let omitted = 0;
  for (const company of source) {
    const name = String(company.name || "Company").replace(/@/g, "@\u200b").replace(/[\r\n]+/g, " ").slice(0, 90);
    const current = company.metrics || {};
    const previous = company.previousMetrics || {};
    const starGapLine = isFiniteNumber(current.starLevel) && current.starLevel >= 10
      ? `• Income gap to next star: N/A (maximum star level) | ${
          isFiniteNumber(previous.starLevel)
            ? previous.starLevel >= 10
              ? (previous.starLevel === current.starLevel ? "no change vs prior day" : "maximum star level maintained")
              : "reached maximum star level vs prior day"
            : "not applicable at maximum star level"
        }`
      : metricLine("Income gap to next star", "starIncomeGap", current.starIncomeGap, previous.starIncomeGap);
    const lines = [
      `**${name}**`,
      metricLine("Daily income", "dailyIncome", current.dailyIncome, previous.dailyIncome),
      metricLine("Daily profit", "dailyProfit", current.dailyProfit, previous.dailyProfit),
      metricLine("Star level", "starLevel", current.starLevel, previous.starLevel),
      starGapLine,
      metricLine("Company rank", "companyRank", current.companyRank, previous.companyRank),
      metricLine("Stock quantity", "stockQuantity", current.stockQuantity, previous.stockQuantity),
    ];
    if (company.snapshotDay !== reportingDay) lines.push(company.snapshotDay ? `⚠️ Latest saved company snapshot: ${company.snapshotDay}; today's snapshot is missing.` : "⚠️ No saved company snapshot is available; today's snapshot is missing.");
    if (!company.previousDayAvailable) lines.push("Prior-day comparison unavailable where no previous-day value was saved.");
    const candidate = "\n\n" + lines.join("\n");
    if (blocks.join("\n").length + candidate.length > 1750) { omitted += 1; continue; }
    blocks.push(candidate);
  }
  if (omitted) blocks.push("", `…${omitted} additional company summary block(s) omitted to fit Discord's single-message limit.`);
  return blocks.join("\n").slice(0, 1900);
}

export function summaryMetricValues(point, rankingRows, company) {
  if (!point || typeof point !== "object") return {
    dailyIncome: null, dailyProfit: null, starLevel: null, starIncomeGap: null, companyRank: null, stockQuantity: null, weeklyIncome: null,
  };
  const weeklyIncome = isFiniteNumber(point.weeklyIncome) ? point.weeklyIncome : null;
  const starLevel = isFiniteNumber(point.rating) ? point.rating : null;
  const ranking = calculateRankingMetrics({
    companyId: company.companyId,
    companyType: company.companyType,
    companyTypeId: company.companyTypeId,
    weeklyIncome,
    starLevel,
  }, rankingRows);
  return {
    dailyIncome: isFiniteNumber(point.dailyIncome) ? point.dailyIncome : null,
    dailyProfit: isFiniteNumber(point.dailyProfit) ? point.dailyProfit : null,
    starLevel,
    starIncomeGap: ranking.starIncomeGap,
    companyRank: ranking.companyRank,
    stockQuantity: isFiniteNumber(point.stockQuantity) ? point.stockQuantity : null,
    weeklyIncome,
  };
}
