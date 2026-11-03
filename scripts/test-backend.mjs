import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"

const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), "naughty-company-tests-"))
writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "commonjs" }))
const sourceFiles = [
  "src/lib/automation/rules.ts",
  "src/lib/automation/discord-poll-monitoring.ts",
  "src/lib/company/engine.ts",
  "src/lib/company/types.ts",
  "src/lib/torn/client.ts",
  "src/lib/torn/personalstats.ts",
  "src/lib/faction-performance/collector.ts",
  "src/lib/faction-performance/weekly.ts",
  "src/lib/faction-performance/leaderboard.ts",
  "src/lib/faction-performance/private-live.ts",
  "src/lib/torn/types.ts",
  "src/worker/index.ts",
  "src/worker/snapshot-provenance.ts",
  "src/components/floor/ranking-utils.ts",
  "src/components/floor/financial-utils.ts",
].map((file) => resolve(root, file))

try {
  const program = ts.createProgram(sourceFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    allowJs: true,
    strict: true,
    skipLibCheck: true,
    rootDir: resolve(root, "src"),
    outDir: temp,
    types: [],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }))
    process.exitCode = 1
    throw new Error("Backend test compilation failed.")
  }
  program.emit()

  const require = createRequire(import.meta.url)
  const { runEngine } = require(join(temp, "lib/company/engine.js"))
  const { TornApiClient, TornApiClientError } = require(join(temp, "lib/torn/client.js"))
  const {
    parseFactionRosterResponse,
    parseFactionGymEnergyResponse,
    parseFactionPublicStatsResponse,
    parseFactionStatsResponse,
    countCompletePublicMetrics,
  } = require(join(temp, "lib/faction-performance/collector.js"))
  const {
    WEEKLY_METRIC_NAMES,
    WEEK_MS,
    utcSundayWindow,
    calculateWeeklyMemberResult,
    rankWeeklyMembers,
  } = require(join(temp, "lib/faction-performance/weekly.js"))
  const { filterAndSortWeeklyMembers } = require(join(temp, "lib/faction-performance/leaderboard.js"))
  const { parsePrivateLiveBars, parsePrivateLiveCooldowns, parsePrivateLiveNetworth } = require(join(temp, "lib/faction-performance/private-live.js"))
  const {
    buildPersonalStatsPath,
    categoriesForMissingPersonalStats,
    decodePersonalStatsResponse,
  } = require(join(temp, "lib/torn/personalstats.js"))
  const personalStatsFixtures = JSON.parse(readFileSync(resolve(root, "scripts/fixtures/torn-personalstats.json"), "utf8"))
  const livePersonalStatsFixtures = JSON.parse(readFileSync(resolve(root, "scripts/fixtures/torn-personalstats-live-sanitized.json"), "utf8"))
  const PERSONAL_STATS_HISTORIC_NAMES_FOR_TEST = [
    "xantaken", "lsdtaken", "drugsused", "overdosed", "alcoholused", "boostersused",
    "energydrinkused", "refills", "statenhancersused", "networth", "cantaken",
  ]
  const worker = require(join(temp, "worker/index.js")).default
  const { officialSnapshotSourceTime, manualRecoverySnapshotSourceTime } = require(join(temp, "worker/snapshot-provenance.js"))
  const { placement } = require(join(temp, "components/floor/ranking-utils.js"))
  const { estimateWeeklyProfit, financialCosts, reportedCompanyProfit, stockCostTotal } = require(join(temp, "components/floor/financial-utils.js"))
  const { evaluateIncomeDrop, evaluateIncomeIncrease, evaluatePercentageDrop, evaluateRosterChange, isWithinQuietHours, normalizeWebhookUrl, isSnapshotStale, normalizeAlertThreshold, normalizeCooldownHours } = require(join(temp, "lib/automation/rules.js"))
  const { evaluateDiscordPollHealth } = require(join(temp, "lib/automation/discord-poll-monitoring.js"))

  let passed = 0
  async function test(name, fn) {
    await fn()
    passed += 1
    console.log("PASS", name)
  }

  await test("faction-wide stats parser validates the enum and reports missing/future fields explicitly", () => {
    const parsed = parseFactionStatsResponse({ stats: [
      { name: "medicalitemsused", value: 1167570 },
      { name: "organisedcrimemoney", value: 369055040000 },
      { name: "membersamount", value: 6 },
      { name: "futurestat", value: 11 },
    ] })
    assert.equal(parsed.stats.find(stat => stat.name === "organisedcrimemoney")?.value, 369055040000)
    assert.ok(parsed.missingStatNames.includes("gymdexterity"))
    assert.deepEqual(parsed.unexpectedStatNames, ["futurestat"])
    assert.throws(() => parseFactionStatsResponse({ stats: [{ name: "medicalitemsused", value: "11" }] }))
    assert.throws(() => parseFactionStatsResponse({ stats: [{ name: "medicalitemsused", value: 1 }, { name: "medicalitemsused", value: 2 }] }))
  })

  await test("Torn faction-wide totals use the authenticated /faction/stats v2 endpoint", async () => {
    let requestedUrl = ""
    const client = new TornApiClient({
      apiKey: "synthetic-faction-stats-key",
      fetcher: async (input, init) => {
        requestedUrl = String(input)
        assert.equal(new Headers(init?.headers).get("Authorization"), "ApiKey synthetic-faction-stats-key")
        return new Response(JSON.stringify({ stats: [{ name: "attackswon", value: 19 }] }), {
          status: 200, headers: { "content-type": "application/json" },
        })
      },
    })
    const payload = await client.getFactionStats()
    assert.equal(requestedUrl, "https://api.torn.com/v2/faction/stats")
    assert.equal(payload.stats[0].value, 19)
  })

  await test("weekly windows start Sunday 00:00 UTC and remain exactly 168 hours across DST changes", () => {
    const regular = utcSundayWindow(Date.parse("2026-11-02T18:00:00.000Z"))
    assert.equal(regular.startAt, "2026-11-01T00:00:00.000Z")
    assert.equal(regular.endAt, "2026-11-08T00:00:00.000Z")
    assert.equal(Date.parse(regular.endAt) - Date.parse(regular.startAt), WEEK_MS)
    const dstSunday = utcSundayWindow(Date.parse("2026-03-08T07:30:00.000Z"))
    assert.equal(dstSunday.startAt, "2026-03-08T00:00:00.000Z")
    assert.equal(Date.parse(dstSunday.endAt) - Date.parse(dstSunday.startAt), 168 * 60 * 60 * 1000)
  })

  await test("weekly deltas use Sunday baseline snapshots, keep Xanax and LSD separate, and allow negative networth change", () => {
    const baselineValues = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const endingValues = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 105]))
    baselineValues.xantaken = 1240
    endingValues.xantaken = 1247
    baselineValues.lsdtaken = 380
    endingValues.lsdtaken = 390
    baselineValues.networth = 10000
    endingValues.networth = 9950
    const result = calculateWeeklyMemberResult({
      member: { userId: "101", name: "Weekly Member", position: "Member", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { snapshotId: 1, runId: "sunday-baseline", userId: "101", capturedAt: "2026-11-01T00:03:00.000Z", ...baselineValues },
        { snapshotId: 2, runId: "later-sample", userId: "101", capturedAt: "2026-11-01T00:20:00.000Z", ...endingValues },
      ],
      gymSnapshots: [
        { snapshotId: 1, runId: "sunday-gym-baseline", userId: "101", capturedAt: "2026-11-01T00:04:00.000Z", gymEnergyTotal: 100 },
        { snapshotId: 2, runId: "later-gym-sample", userId: "101", capturedAt: "2026-11-01T00:21:00.000Z", gymEnergyTotal: 125 },
      ],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T12:00:00.000Z",
      statsBoundaryRunId: "sunday-baseline",
      gymBoundaryRunId: "sunday-gym-baseline",
    })
    assert.equal(result.metrics.xantaken, 7)
    assert.equal(result.metrics.lsdtaken, 10)
    assert.notEqual(result.metrics.xantaken, result.metrics.lsdtaken)
    assert.equal(result.metrics.networth, -50)
    assert.equal(result.startingNetworth, 10000)
    assert.equal(result.endingNetworth, 9950)
    assert.equal(result.gymEnergy, 25)
    assert.equal(result.status, "complete")
    assert.equal(result.participation, "full_week")
  })

  await test("decreased lifetime counters are anomalies and are never ranked as negative usage", () => {
    const before = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 50]))
    const after = { ...before, xantaken: 49 }
    const result = calculateWeeklyMemberResult({
      member: { userId: "102", name: "Reset Counter", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { runId: "baseline", userId: "102", capturedAt: "2026-11-01T00:01:00.000Z", ...before },
        { runId: "ending", userId: "102", capturedAt: "2026-11-01T00:16:00.000Z", ...after },
      ],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T00:00:00.000Z",
      statsBoundaryRunId: "baseline",
    })
    assert.equal(result.metrics.xantaken, null)
    assert.ok(result.anomalyMetrics.includes("xantaken"))
    assert.equal(result.status, "anomaly")
  })

  await test("midweek joiners use their first observed sample as a partial baseline", () => {
    const before = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 10]))
    const after = { ...before, xantaken: 15 }
    const result = calculateWeeklyMemberResult({
      member: { userId: "103", name: "New Member", estimatedJoinedAt: "2026-11-02T09:00:00.000Z" },
      statSnapshots: [
        { runId: "join-baseline", userId: "103", capturedAt: "2026-11-02T09:15:00.000Z", ...before },
        { runId: "later-sample", userId: "103", capturedAt: "2026-11-02T09:30:00.000Z", ...after },
      ],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T12:00:00.000Z",
    })
    assert.equal(result.participation, "partial_week")
    assert.equal(result.metrics.xantaken, 5)
  })

  await test("missing Sunday baseline or ending sample remains unknown rather than zero", () => {
    const row = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const missingBaseline = calculateWeeklyMemberResult({
      member: { userId: "104", name: "No Baseline", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [{ runId: "only-later", userId: "104", capturedAt: "2026-11-01T00:20:00.000Z", ...row }],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T00:00:00.000Z",
      statsBoundaryRunId: "missing-boundary-run",
    })
    assert.equal(missingBaseline.status, "waiting_for_baseline")
    assert.equal(missingBaseline.metrics.xantaken, null)

    const missingEnding = calculateWeeklyMemberResult({
      member: { userId: "105", name: "No Ending", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [{ runId: "baseline", userId: "105", capturedAt: "2026-11-01T00:20:00.000Z", ...row }],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T00:00:00.000Z",
      statsBoundaryRunId: "baseline",
    })
    assert.equal(missingEnding.status, "waiting_for_update")
    assert.equal(missingEnding.metrics.xantaken, null)
  })

  await test("midweek leavers remain partial-week participants and use only pre-departure samples", () => {
    const before = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const after = { ...before, xantaken: 110 }
    const afterDeparture = { ...before, xantaken: 900 }
    const result = calculateWeeklyMemberResult({
      member: {
        userId: "106",
        name: "Departed Midweek",
        estimatedJoinedAt: "2026-01-01T00:00:00.000Z",
        leftObservedAt: "2026-11-03T13:00:00.000Z",
      },
      statSnapshots: [
        { runId: "baseline", userId: "106", capturedAt: "2026-11-01T00:06:00.000Z", ...before },
        { runId: "before-leave", userId: "106", capturedAt: "2026-11-03T12:00:00.000Z", ...after },
        { runId: "after-leave", userId: "106", capturedAt: "2026-11-04T12:00:00.000Z", ...afterDeparture },
      ],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-05T00:00:00.000Z",
      statsBoundaryRunId: "baseline",
      requireEndingBoundary: true,
    })
    assert.equal(result.participation, "partial_week")
    assert.equal(result.status, "complete", "a midweek leaver is complete when the last in-faction sample is complete")
    assert.equal(result.metrics.xantaken, 10, "samples collected after observed departure must not affect the weekly result")
    assert.equal(result.endingCapturedAt, "2026-11-03T12:00:00.000Z")
  })

  await test("failed samples do not replace a valid Sunday baseline or the latest successful ending sample", () => {
    const baseline = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const ending = { ...baseline, xantaken: 107 }
    const failed = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, null]))
    const result = calculateWeeklyMemberResult({
      member: { userId: "108", name: "Failed Sample", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { runId: "baseline", userId: "108", capturedAt: "2026-11-01T00:02:00.000Z", collectionStatus: "complete", ...baseline },
        { runId: "good-ending", userId: "108", capturedAt: "2026-11-01T00:17:00.000Z", collectionStatus: "complete", ...ending },
        { runId: "failed-later", userId: "108", capturedAt: "2026-11-01T00:32:00.000Z", collectionStatus: "failed", ...failed },
      ],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T00:00:00.000Z",
      statsBoundaryRunId: "baseline",
    })
    assert.equal(result.metrics.xantaken, 7)
    assert.equal(result.endingCapturedAt, "2026-11-01T00:17:00.000Z")
  })

  await test("closed weeks use next-Sunday boundary runs even when the actual capture is late", () => {
    const values = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const later = { ...values, xantaken: 112, lsdtaken: 119, networth: 50 }
    const result = calculateWeeklyMemberResult({
      member: { userId: "110", name: "Boundary Capture", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { runId: "stats-start", userId: "110", capturedAt: "2026-11-01T00:02:00.000Z", ...values },
        { runId: "stats-end", userId: "110", capturedAt: "2026-11-08T00:07:00.000Z", ...later },
      ],
      gymSnapshots: [
        { runId: "gym-start", userId: "110", capturedAt: "2026-11-01T00:03:00.000Z", gymEnergyTotal: 500 },
        { runId: "gym-end", userId: "110", capturedAt: "2026-11-08T00:08:00.000Z", gymEnergyTotal: 540 },
      ],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-08T00:15:00.000Z",
      statsBoundaryRunId: "stats-start",
      gymBoundaryRunId: "gym-start",
      statsEndingBoundaryRunId: "stats-end",
      gymEndingBoundaryRunId: "gym-end",
      requireEndingBoundary: true,
    })
    assert.equal(result.metrics.xantaken, 12)
    assert.equal(result.metrics.lsdtaken, 19)
    assert.equal(result.metrics.networth, -50)
    assert.equal(result.gymEnergy, 40)
    assert.equal(result.endingCapturedAt, "2026-11-08T00:07:00.000Z")
    assert.equal(result.endingIsBoundary, true)
    assert.equal(result.gymEnergyEndingIsBoundary, true)
    assert.equal(result.status, "complete")
  })

  await test("closed weeks without an ending boundary are marked partial instead of silently finalized as complete", () => {
    const values = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const later = { ...values, xantaken: 105 }
    const result = calculateWeeklyMemberResult({
      member: { userId: "111", name: "Missing Boundary", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { runId: "stats-start", userId: "111", capturedAt: "2026-11-01T00:02:00.000Z", ...values },
        { runId: "stats-middle", userId: "111", capturedAt: "2026-11-05T12:00:00.000Z", ...later },
      ],
      gymSnapshots: [
        { runId: "gym-start", userId: "111", capturedAt: "2026-11-01T00:03:00.000Z", gymEnergyTotal: 500 },
        { runId: "gym-middle", userId: "111", capturedAt: "2026-11-05T12:01:00.000Z", gymEnergyTotal: 520 },
      ],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-09T00:00:00.000Z",
      statsBoundaryRunId: "stats-start",
      gymBoundaryRunId: "gym-start",
      statsEndingBoundaryRunId: "missing-stats-end",
      gymEndingBoundaryRunId: "missing-gym-end",
      requireEndingBoundary: true,
    })
    assert.equal(result.metrics.xantaken, 5)
    assert.equal(result.endingIsBoundary, false)
    assert.equal(result.status, "partial")
  })

  await test("the following Sunday 00:00 UTC is exclusive for the ending sample", () => {
    const before = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const atNextBoundary = { ...before, xantaken: 107 }
    const result = calculateWeeklyMemberResult({
      member: { userId: "107", name: "Boundary Member", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { runId: "baseline", userId: "107", capturedAt: "2026-11-01T00:01:00.000Z", ...before },
        { runId: "next-sunday", userId: "107", capturedAt: "2026-11-08T00:00:00.000Z", ...atNextBoundary },
      ],
      gymSnapshots: [],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-08T00:00:00.000Z",
      statsBoundaryRunId: "baseline",
    })
    assert.equal(result.status, "waiting_for_update")
    assert.equal(result.metrics.xantaken, null)
  })

  await test("decreasing gym-energy contributor totals are marked anomalous and remain unranked", () => {
    const baseline = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 100]))
    const ending = { ...baseline, xantaken: 105 }
    const result = calculateWeeklyMemberResult({
      member: { userId: "109", name: "Gym Counter Reset", estimatedJoinedAt: "2026-01-01T00:00:00.000Z" },
      statSnapshots: [
        { runId: "stats-baseline", userId: "109", capturedAt: "2026-11-01T00:01:00.000Z", ...baseline },
        { runId: "stats-ending", userId: "109", capturedAt: "2026-11-01T00:16:00.000Z", ...ending },
      ],
      gymSnapshots: [
        { runId: "gym-baseline", userId: "109", capturedAt: "2026-11-01T00:02:00.000Z", gymEnergyTotal: 1000 },
        { runId: "gym-ending", userId: "109", capturedAt: "2026-11-01T00:17:00.000Z", gymEnergyTotal: 900 },
      ],
      weekStart: "2026-11-01T00:00:00.000Z",
      weekEnd: "2026-11-08T00:00:00.000Z",
      now: "2026-11-02T00:00:00.000Z",
      statsBoundaryRunId: "stats-baseline",
      gymBoundaryRunId: "gym-baseline",
    })
    assert.equal(result.gymEnergy, null)
    assert.ok(result.anomalyMetrics.includes("gymEnergy"))
    assert.equal(result.status, "anomaly")
    const ranked = rankWeeklyMembers([{ ...result }], "gymEnergy")
    assert.equal(ranked[0].rank, null)
  })

  await test("weekly ranking excludes unknown metrics and gives tied values the same rank", () => {
    const metrics = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 10]))
    const base = {
      position: "Member", level: 50, participation: "full_week", status: "complete",
      metrics, gymEnergy: null, knownMetricCount: WEEKLY_METRIC_NAMES.length, anomalyMetrics: [],
      baselineCapturedAt: null, endingCapturedAt: null, baselineSnapshotId: null, endingSnapshotId: null,
      gymEnergyBaselineCapturedAt: null, gymEnergyEndingCapturedAt: null,
    }
    const ranked = rankWeeklyMembers([
      { ...base, userId: "201", name: "A", metrics: { ...metrics, xantaken: 12 } },
      { ...base, userId: "202", name: "B", metrics: { ...metrics, xantaken: 12 } },
      { ...base, userId: "203", name: "C", metrics: { ...metrics, xantaken: null }, status: "waiting_for_baseline" },
    ], "xantaken")
    assert.deepEqual(ranked.map(item => item.rank), [1, 1, null])

    const gymRanked = rankWeeklyMembers([
      { ...base, userId: "204", name: "Gym X", gymEnergy: 50 },
      { ...base, userId: "205", name: "Gym Y", gymEnergy: 70 },
      { ...base, userId: "206", name: "Gym Unknown", gymEnergy: null },
    ], "gymEnergy")
    assert.deepEqual(gymRanked.map(item => item.rank), [1, 2, null])
    assert.equal(gymRanked[0].name, "Gym Y")
  })

  await test("weekly leaderboard filters members and sorts known metrics ahead of unknown values", () => {
    const metrics = Object.fromEntries(WEEKLY_METRIC_NAMES.map(name => [name, 5]))
    const base = {
      position: "Member", level: 50, participation: "full_week", status: "complete",
      metrics, startingNetworth: 1000, endingNetworth: 1100, gymEnergy: 20,
      knownMetricCount: WEEKLY_METRIC_NAMES.length, anomalyMetrics: [],
    }
    const members = [
      { ...base, userId: "301", name: "Alpha", rank: 1, metrics: { ...metrics, xantaken: 10 } },
      { ...base, userId: "302", name: "Bravo", rank: 2, status: "partial", participation: "partial_week", knownMetricCount: 14, anomalyMetrics: ["lsdtaken"], metrics: { ...metrics, xantaken: 30 } },
      { ...base, userId: "303", name: "Charlie", rank: null, status: "waiting_for_baseline", participation: "unknown", knownMetricCount: 0, metrics: { ...metrics, xantaken: null } },
    ]
    const descending = filterAndSortWeeklyMembers(members, { sortBy: "xantaken", direction: "desc" })
    assert.deepEqual(descending.map(member => member.userId), ["302", "301", "303"])
    const ascending = filterAndSortWeeklyMembers(members, { sortBy: "xantaken", direction: "asc" })
    assert.deepEqual(ascending.map(member => member.userId), ["301", "302", "303"])
    const filtered = filterAndSortWeeklyMembers(members, {
      search: "BRAV", status: "partial", participation: "partial_week", anomaliesOnly: true,
    })
    assert.deepEqual(filtered.map(member => member.userId), ["302"])
    assert.deepEqual(filterAndSortWeeklyMembers(members, { status: "complete" }).map(member => member.userId), ["301"])
  })

  await test("private live parsers whitelist owner bars, cooldowns and optional detailed networth", () => {
    const bars = parsePrivateLiveBars({ bars: {
      energy: { current: 125, maximum: 150 },
      nerve: { current: 40, maximum: 60 },
      happy: { current: 5000, maximum: 5000 },
      life: { current: 2500, maximum: 3000 },
      unrelated: { secret: "must not persist" },
    } })
    assert.deepEqual(bars.energy, { current: 125, maximum: 150 })
    assert.equal(bars.life.current, 2500)
    assert.equal(Object.keys(bars).length, 4)
    assert.throws(() => parsePrivateLiveBars({ bars: { unrelated: { current: 12, maximum: 20 } } }))

    const cooldowns = parsePrivateLiveCooldowns({ cooldowns: { drug: 1800, booster: 0, medical: 60, unrelated: 999 } })
    assert.deepEqual(cooldowns, { drug: 1800, booster: 0, medical: 60 })
    assert.throws(() => parsePrivateLiveCooldowns({ cooldowns: { unrelated: 999 } }))

    const networth = parsePrivateLiveNetworth({ networth: {
      total: 123456789, bank: 50000000, wallet: 1234, timestamp: 1791000000,
      private_future_field: "must not persist",
    } })
    assert.equal(networth.total, 123456789)
    assert.equal(networth.bank, 50000000)
    assert.equal(networth.wallet, 1234)
    assert.equal(Object.prototype.hasOwnProperty.call(networth, "private_future_field"), false)
    assert.throws(() => parsePrivateLiveNetworth({ networth: { wallet: 100 } }))
  })

  await test("private live owner key requires consent, validates its owner, encrypts storage, and deletes its current snapshot on disconnect", async () => {
    const originalFetch = globalThis.fetch
    const token = "synthetic-private-live-session-token"
    const tokenDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    const tokenHash = Array.from(new Uint8Array(tokenDigest), byte => byte.toString(16).padStart(2, "0")).join("")
    const apiKey = "synthetic-owner-private-live-key-abcdef"
    const keySecret = "private-live-test-encryption-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
    const player = {
      player_id: "77", player_name: "Private Live Owner", faction_id: "8317",
      faction_verified_at: new Date().toISOString(), membership_check_attempted_at: null,
      membership_check_status: null, is_admin: 0,
    }
    const sessions = new Map([[tokenHash, { player_id: "77", expires_at: Math.floor(Date.now() / 1000) + 3600 }]])
    const primaryKeyDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keySecret))
    const primaryKeyCrypto = await crypto.subtle.importKey("raw", primaryKeyDigest, { name: "AES-GCM" }, false, ["encrypt"])
    const primaryKeyIv = crypto.getRandomValues(new Uint8Array(12))
    const primaryKeyCiphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: primaryKeyIv }, primaryKeyCrypto, new TextEncoder().encode(apiKey))
    const state = { key: null, snapshot: null, throttleAt: null, writes: [], primaryKey: {
      ciphertext: Buffer.from(primaryKeyCiphertext).toString("base64"), iv: Buffer.from(primaryKeyIv).toString("base64"),
    } }
    const db = {
      prepare(sql) {
        const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim()
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            if (normalized.includes("from sessions s join players p")) {
              const session = sessions.get(String(values[0]))
              if (!session || session.expires_at <= Number(values[1])) return null
              return { ...player }
            }
            if (normalized.startsWith("select disabled_at from dashboard_member_status")) return { disabled_at: null }
            if (normalized.startsWith("select ciphertext, iv from api_keys")) return state.primaryKey
            if (normalized.startsWith("select value_json from admin_settings")) return null
            if (normalized.startsWith("select last_four, include_networth")) return state.key
            if (normalized.startsWith("select include_networth from member_private_live_keys")) return state.key ? { include_networth: state.key.include_networth } : null
            if (normalized.startsWith("select ciphertext, iv, include_networth from member_private_live_keys")) {
              return state.key ? { ciphertext: state.key.ciphertext, iv: state.key.iv, include_networth: state.key.include_networth } : null
            }
            if (normalized.startsWith("select captured_at, bars_json, cooldowns_json")) return state.snapshot
            return null
          },
          async all() { return { results: [] } },
          async run() {
            state.writes.push({ sql: normalized, values: [...values] })
            if (normalized.startsWith("insert into member_private_live_api_throttles")) {
              const retryBefore = String(values[2])
              const changes = !state.throttleAt || state.throttleAt <= retryBefore
              if (changes) state.throttleAt = String(values[1])
              return { success: true, meta: { changes: changes ? 1 : 0 } }
            }
            if (normalized.startsWith("insert into member_private_live_keys")) {
              state.key = {
                ciphertext: values[2], iv: values[3], last_four: values[4],
                include_networth: values[5], share_with_faction: 1,
                consent_version: values[6], consented_at: values[7], last_validated_at: values[8],
                last_attempt_at: values[9], last_collected_at: values[10], last_error: null,
                updated_at: values[12],
              }
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("insert into faction_member_private_live_snapshots")) {
              state.snapshot = {
                captured_at: values[2], bars_json: values[3], cooldowns_json: values[4],
                networth_json: values[5], source_timestamps_json: values[6],
              }
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("update member_private_live_keys set last_attempt_at")) {
              if (state.key) state.key.last_attempt_at = values[0]
              return { success: true, meta: { changes: state.key ? 1 : 0 } }
            }
            if (normalized.startsWith("update member_private_live_keys set last_error")) {
              if (state.key) { state.key.last_error = values[0]; state.key.updated_at = values[1] }
              return { success: true, meta: { changes: state.key ? 1 : 0 } }
            }
            if (normalized.startsWith("delete from faction_member_private_live_snapshots")) {
              state.snapshot = null
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("delete from member_private_live_keys")) {
              state.key = null
              return { success: true, meta: { changes: 1 } }
            }
            return { success: true, meta: { changes: 1 } }
          },
        }
      },
    }
    let keyOwnerId = "88"
    let upstreamErrorCode = null
    const calls = []
    globalThis.fetch = async input => {
      const url = new URL(String(input))
      calls.push(url.pathname)
      if (url.pathname === "/v2/key/info") {
        return new Response(JSON.stringify({ info: { user: { id: Number(keyOwnerId) } } }))
      }
      if (url.pathname === "/v2/user/bars") {
        if (upstreamErrorCode !== null) {
          return new Response(JSON.stringify({ error: { code: upstreamErrorCode, error: "Synthetic upstream owner state." } }))
        }
        return new Response(JSON.stringify({ bars: {
          energy: { current: 90, maximum: 100 }, nerve: { current: 30, maximum: 60 },
          happy: { current: 4000, maximum: 5000 }, life: { current: 800, maximum: 1000 },
        } }))
      }
      if (url.pathname === "/v2/user/cooldowns") {
        return new Response(JSON.stringify({ cooldowns: { drug: 120, booster: 0, medical: 60 } }))
      }
      if (url.pathname === "/v2/user/networth") {
        return new Response(JSON.stringify({ networth: { total: 123456, wallet: 1234 }, timestamp: 1791000000 }))
      }
      throw new Error("Unexpected private live Torn request: " + url.pathname)
    }
    const env = {
      DB: db,
      KEY_ENCRYPTION_SECRET: keySecret,
      ALLOWED_ORIGIN: "https://naughty-company-dashboard.pages.dev",
    }
    const request = (method, body, pathname = "/api/me/private-live/key") => worker.fetch(new Request("https://worker.test" + pathname, {
      method,
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, { waitUntil() {} })

    try {
      const missingConsent = await request("POST", { shareWithFaction: true, consentVersion: "faction-private-live-v1" })
      assert.equal(missingConsent.status, 400)
      assert.equal(calls.length, 0, "consent is checked before contacting Torn")

      const wrongOwner = await request("POST", {
        consent: true, shareWithFaction: true, consentVersion: "faction-private-live-v1",
      })
      assert.equal(wrongOwner.status, 403)
      assert.equal(state.key, null, "a key owned by another player must never be stored")
      assert.equal(state.snapshot, null, "a key owned by another player must never create a faction snapshot")

      keyOwnerId = "77"
      // The failed owner verification consumed a request-budget slot. Reset
      // only the request trace, not the D1 throttle state, for the next case.
      calls.length = 0
      state.throttleAt = new Date(Date.now() - 31000).toISOString()
      const connected = await request("POST", {
        consent: true, shareWithFaction: true,
        consentVersion: "faction-private-live-v1", includeNetworth: false,
      })
      assert.equal(connected.status, 200)
      const connectedBody = await connected.json()
      assert.equal(connectedBody.connected, true)
      assert.equal(connectedBody.includeNetworth, false)
      assert.deepEqual(calls, ["/v2/key/info", "/v2/user/bars", "/v2/user/cooldowns"],
        "networth must not be requested unless separately opted in")
      assert.ok(state.key && state.snapshot)
      assert.equal(state.key.include_networth, 0)
      assert.equal(JSON.parse(state.snapshot.bars_json).energy.current, 90)
      assert.equal(JSON.parse(state.snapshot.cooldowns_json).drug, 120)
      assert.equal(state.snapshot.networth_json, null)
      assert.ok(state.writes.every(write => !write.values.includes(apiKey)), "plaintext key must never be bound to D1")

      const requestsBeforeThrottle = calls.length
      const rateLimited = await request("POST", {
        consent: true, shareWithFaction: true,
        consentVersion: "faction-private-live-v1", includeNetworth: false,
      })
      assert.equal(rateLimited.status, 429, "repeat private live connect attempts must share the member request budget")
      assert.equal(calls.length, requestsBeforeThrottle, "a rejected request must not contact Torn")

      const insertKey = state.writes.find(write => write.sql.startsWith("insert into member_private_live_keys"))
      assert.ok(insertKey)
      assert.notEqual(insertKey.values[2], apiKey, "stored key value must be ciphertext")
      const rawKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keySecret))
      const encryptionKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"])
      const decoded = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: Uint8Array.from(Buffer.from(String(insertKey.values[3]), "base64")),
      }, encryptionKey, Uint8Array.from(Buffer.from(String(insertKey.values[2]), "base64")))
      assert.equal(new TextDecoder().decode(decoded), apiKey, "ciphertext must decrypt with the configured Worker encryption secret")

      const status = await worker.fetch(new Request("https://worker.test/api/me/private-live/key", {
        headers: { Origin: env.ALLOWED_ORIGIN, Authorization: "Bearer " + token },
      }), env, { waitUntil() {} })
      assert.equal(status.status, 200)
      const statusBody = await status.json()
      assert.equal(statusBody.connected, true)
      assert.equal(statusBody.snapshot.bars.energy.current, 90)
      assert.equal(JSON.stringify(statusBody).includes(apiKey), false)

      // A temporary owner-state restriction must retain the key and the
      // last successful snapshot so the member can retry when Torn restores access.
      const lastGoodSnapshot = JSON.stringify(state.snapshot)
      state.throttleAt = new Date(Date.now() - 31000).toISOString()
      upstreamErrorCode = 10
      const temporaryFailure = await request("POST", undefined, "/api/me/private-live/refresh")
      assert.equal(temporaryFailure.status, 403)
      assert.ok(state.key, "temporary federal-jail state must not delete the saved owner key")
      assert.equal(JSON.stringify(state.snapshot), lastGoodSnapshot, "temporary owner state must preserve the last successful snapshot")
      assert.match(String(state.key.last_error), /federal jail/i)

      // Replace with an explicit detailed-networth opt-in after the
      // server-enforced 30-second per-member request window has elapsed.
      state.throttleAt = new Date(Date.now() - 31000).toISOString()
      upstreamErrorCode = null
      const networthConnection = await request("POST", {
        consent: true, shareWithFaction: true,
        consentVersion: "faction-private-live-v1", includeNetworth: true,
      })
      assert.equal(networthConnection.status, 200)
      assert.ok(calls.includes("/v2/user/networth"))
      assert.equal(state.key.include_networth, 1)
      assert.equal(JSON.parse(state.snapshot.networth_json).total, 123456)

      const disconnected = await request("DELETE")
      assert.equal(disconnected.status, 200)
      assert.equal(state.key, null)
      assert.equal(state.snapshot, null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("official stock lock-in timestamp accepts only fresh source data from the scheduled reporting day", () => {
    const scheduledAt = Date.parse("2026-10-21T18:10:00.000Z");
    const schedule = { cron: "10 18 * * *", scheduledTime: scheduledAt };
    const sourceTime = (value) => Date.parse(value) / 1000;

    assert.equal(
      officialSnapshotSourceTime(sourceTime("2026-10-21T18:10:00.000Z"), schedule)?.toISOString(),
      "2026-10-21T18:10:00.000Z",
    );
    assert.equal(
      officialSnapshotSourceTime(sourceTime("2026-10-21T18:00:00.000Z"), schedule)?.toISOString(),
      "2026-10-21T18:00:00.000Z",
      "the reporting-day boundary is inclusive",
    );
    assert.equal(
      officialSnapshotSourceTime(sourceTime("2026-10-21T18:15:00.000Z"), schedule)?.toISOString(),
      "2026-10-21T18:15:00.000Z",
      "a small future skew is allowed for request processing",
    );

    for (const invalidSchedule of [
      undefined,
      { cron: "* * * * *", scheduledTime: scheduledAt },
      { cron: "10 18 * * *", scheduledTime: Date.parse("2026-10-21T18:11:00.000Z") },
      { cron: "10 18 * * *", scheduledTime: Number.NaN },
    ]) {
      assert.equal(officialSnapshotSourceTime(sourceTime("2026-10-21T18:10:00.000Z"), invalidSchedule), null);
    }

    for (const invalidTimestamp of [
      null,
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
    ]) {
      assert.equal(officialSnapshotSourceTime(invalidTimestamp, schedule), null);
    }

    assert.equal(officialSnapshotSourceTime(sourceTime("2026-10-21T17:59:59.000Z"), schedule), null,
      "a timestamp before the reporting-day boundary belongs to yesterday");
    assert.equal(officialSnapshotSourceTime(sourceTime("2026-10-21T18:15:01.000Z"), schedule), null,
      "source timestamps more than five minutes ahead are rejected");
    assert.equal(officialSnapshotSourceTime(sourceTime("2026-10-21T17:39:59.000Z"), schedule), null,
      "stale source timestamps are rejected");
  });

  await test("manual snapshot recovery accepts only fresh data from the current 18:00 UTC reporting day", () => {
    const startedAt = Date.parse("2026-10-27T18:50:00.000Z");
    const observedAt = Date.parse("2026-10-27T18:55:00.000Z");
    const sourceTime = (value) => Date.parse(value) / 1000;

    assert.equal(
      manualRecoverySnapshotSourceTime(sourceTime("2026-10-27T18:52:00.000Z"), startedAt, observedAt)?.toISOString(),
      "2026-10-27T18:52:00.000Z",
    );
    assert.equal(
      manualRecoverySnapshotSourceTime(sourceTime("2026-10-27T17:59:59.000Z"), startedAt, observedAt),
      null,
      "previous reporting-day data must not be backfilled as today's snapshot",
    );
    assert.equal(
      manualRecoverySnapshotSourceTime(sourceTime("2026-10-27T17:59:59.000Z"), startedAt, observedAt),
      null,
    );
    assert.equal(
      manualRecoverySnapshotSourceTime(sourceTime("2026-10-27T18:52:00.000Z"), startedAt, Date.parse("2026-10-28T18:55:00.000Z")),
      null,
      "a catch-up cannot write a different reporting day",
    );
    assert.equal(manualRecoverySnapshotSourceTime(null, startedAt, observedAt), null);
    assert.equal(manualRecoverySnapshotSourceTime(sourceTime("2026-10-27T18:04:00.000Z"), startedAt, observedAt), null,
      "source data older than the recovery freshness window must be skipped");
  });

  await test("evaluates income increase thresholds without dividing by zero", () => {
    assert.deepEqual(evaluateIncomeIncrease(100, 120, 15), { changePercent: 20 })
    assert.equal(evaluateIncomeIncrease(100, 105, 10), null)
    assert.equal(evaluateIncomeIncrease(0, 100, 10), null)
  })

  await test("evaluates percentage drops and roster changes symmetrically", () => {
    assert.deepEqual(evaluatePercentageDrop(100, 80, 15), { changePercent: -20 })
    assert.equal(evaluatePercentageDrop(100, 90, 15), null)
    assert.deepEqual(evaluateRosterChange(10, 8, 15), { changePercent: -20 })
    assert.deepEqual(evaluateRosterChange(0, 2, 15), { changePercent: 100 })
    assert.equal(evaluateRosterChange(10, 10, 15), null)
  })

  await test("stock purchase costs use on-order quantity and missing financial inputs remain unknown", () => {
    assert.equal(stockCostTotal({ "Oil (Barrel)": { cost: 100, in_stock: 1177376, on_order: 0 } }), 0)
    assert.equal(stockCostTotal({ Tealight: { cost: 4, in_stock: 1000, on_order: 5 } }), 20)
    assert.equal(stockCostTotal({ Tealight: { cost: 4, in_stock: 1000 } }), null)
    assert.equal(stockCostTotal(null), null)
    const complete = financialCosts(
      { advertising_budget: 500 },
      { Tealight: { cost: 4, in_stock: 1000, on_order: 5 } },
      { company: { employeesHired: 2 }, employees: [{ wage: 100 }, { wage: 200 }] },
    )
    assert.equal(complete.wages, 300)
    assert.equal(complete.stockCosts, 20)
    assert.equal(complete.dailyCosts, 820)
    const missingWage = financialCosts(
      { advertising_budget: 500 },
      { Tealight: { cost: 4, in_stock: 1000, on_order: 5 } },
      { company: { employeesHired: 2 }, employees: [{ wage: 100 }, { wage: null }] },
    )
    assert.equal(missingWage.wages, null)
    assert.equal(missingWage.dailyCosts, null)
  })

  await test("weekly profit prefers Torn's reported value and fallback costs cover exactly seven days", () => {
    const profile = { company: { income: { weekly: 897615035 }, profit: { daily: 62692205, weekly: 240001645 } } }
    assert.equal(reportedCompanyProfit(profile, "weekly"), 240001645)
    assert.equal(reportedCompanyProfit({ profile: { weekly_profit: 240001645 } }, "weekly"), 240001645)
    assert.equal(reportedCompanyProfit({ company: { profit: { daily: 62692205 } } }, "weekly"), null)
    assert.equal(estimateWeeklyProfit(897615035, 13200000 + 80744770, 0), 240001645)
    assert.equal(estimateWeeklyProfit(897615035, 93944770, null), null)
  })

  await test("handles quiet hours that cross midnight and all-day quiet windows", () => {
    assert.equal(isWithinQuietHours(23 * 60, "22:00", "08:00"), true)
    assert.equal(isWithinQuietHours(7 * 60, "22:00", "08:00"), true)
    assert.equal(isWithinQuietHours(12 * 60, "22:00", "08:00"), false)
    assert.equal(isWithinQuietHours(300, "08:00", "08:00"), true)
    assert.equal(isWithinQuietHours(300, "bad", "08:00"), false)
  })

  await test("Discord poll monitoring raises threshold warnings and detects stale telemetry", () => {
    const nowMs = Date.parse("2026-10-20T18:10:00.000Z")
    const healthy = evaluateDiscordPollHealth({
      pollCompletedAt: "2026-10-20T18:09:00.000Z", status: "healthy", consecutiveFailures: 0,
      failed: 0, exhaustedDeliveries: 0, staleClaims: 0,
    }, { linked: true, alertsEnabled: true, nowMs })
    assert.equal(healthy.needsAttention, false)
    assert.equal(healthy.badgeLabel, "Reporting normally")

    const repeatedFailures = evaluateDiscordPollHealth({
      pollCompletedAt: "2026-10-20T18:09:00.000Z", status: "error", consecutiveFailures: 3,
      failed: 0, exhaustedDeliveries: 0, staleClaims: 0,
    }, { linked: true, alertsEnabled: true, nowMs })
    assert.equal(repeatedFailures.needsAttention, true)
    assert.match(repeatedFailures.warningReasons[0], /3 times in a row/)

    const stuckDeliveries = evaluateDiscordPollHealth({
      pollCompletedAt: "2026-10-20T18:09:00.000Z", status: "partial", consecutiveFailures: 0,
      failed: 1, exhaustedDeliveries: 2, staleClaims: 1,
    }, { linked: true, alertsEnabled: true, nowMs })
    assert.equal(stuckDeliveries.needsAttention, true)
    assert.equal(stuckDeliveries.warningReasons.length, 3)

    const staleTelemetry = evaluateDiscordPollHealth({
      pollCompletedAt: "2026-10-20T17:00:00.000Z", status: "healthy", consecutiveFailures: 0,
      exhaustedDeliveries: 0, staleClaims: 0,
    }, { linked: true, alertsEnabled: true, nowMs })
    assert.equal(staleTelemetry.telemetryStale, true)
    assert.match(staleTelemetry.warningReasons[0], /30 minutes/)

    const awaitingFirstReport = evaluateDiscordPollHealth(null, { linked: true, alertsEnabled: true, nowMs })
    assert.equal(awaitingFirstReport.needsAttention, false)
    assert.equal(awaitingFirstReport.badgeLabel, "Awaiting first report")
  })

  await test("automatic alert delivery honors preferences and scheduled digests", () => {
    const source = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(source, /await deliverAutomationWebhook\(env, rule\.owner_player_id/)
    assert.match(source, /digest_mode IN \(\'daily\', \'both\'\)/)
    assert.match(source, /deliverDailyAutomationDigests\(env\)/)
    assert.match(source, /isWithinQuietHours\(preferences\)/)
    assert.match(source, /await deliverAutomationDigest\(env, owner\.ownerPlayerId, events\.results \?\? \[\]\)/)
  })

  await test("official daily stock deltas require scheduled, source-timestamped immutable snapshots", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const provenanceSource = readFileSync(join(root, "src/worker/snapshot-provenance.ts"), "utf8")
    const floorSource = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0009_faction_director_snapshot_kind.sql"), "utf8")
    assert.match(provenanceSource, /function officialSnapshotSourceTime/)
    assert.match(provenanceSource, /schedule\.cron\.trim\(\) !== "10 18 \* \* \*"/)
    assert.match(provenanceSource, /schedule\.scheduledTime/)
    assert.match(provenanceSource, /sourceTimestamp \* 1000/)
    assert.match(workerSource, /snapshot_kind = excluded\.snapshot_kind/)
    assert.match(migrationSource, /snapshot_kind IN \('initialization', 'lock-in', 'legacy'\)/)
    const rankingRefresh = workerSource.slice(workerSource.indexOf("async function refreshRankingProfiles"), workerSource.indexOf("type AdminAuditOutcome"))
    assert.match(rankingRefresh, /officialSnapshotSourceTime\(sourceTimestamp, snapshotSchedule\)/)
    assert.match(rankingRefresh, /if \(sourceSnapshotAt\)/)
    const directoryRefresh = workerSource.slice(workerSource.indexOf("async function syncFactionDirectorDirectory"), workerSource.indexOf("async function refreshFactionDirectoryFromAnyKey"))
    assert.doesNotMatch(directoryRefresh, /persistFactionDirectorSnapshot/, "profile-only directory refreshes must not create official stock history")
    const scheduled = workerSource.slice(workerSource.indexOf("async function runScheduledAutomation"), workerSource.indexOf("type AdminRefreshEndpoint"))
    assert.match(scheduled, /refreshRankingProfiles\(env, isRankingCaptureWindow, \{ cron: controller\.cron, scheduledTime: controller\.scheduledTime \}\)/)
    assert.match(floorSource, /currentOfficialStockSnapshot = officialStockSnapshots\.find\(\(point\) => point\.day === currentSnapshotDay\)/)
    assert.match(floorSource, /currentOfficialStockSnapshot\.stockQuantity - previousStockSnapshot\.stockQuantity/)
    assert.doesNotMatch(floorSource, /currentStockQuantity - previousStockSnapshot\.stockQuantity/)
  })

  await test("faction performance read API is faction-authenticated and exposes only public fields plus explicitly opted-in private live snapshots", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const routeStart = workerSource.indexOf('if (url.pathname === "/api/faction/performance" && request.method === "GET")')
    const routeEnd = workerSource.indexOf('if (url.pathname === "/api/faction/shared-company-data"', routeStart)
    assert.ok(routeStart >= 0 && routeEnd > routeStart)
    const route = workerSource.slice(routeStart, routeEnd)
    assert.match(route, /authenticate\(request, env\)/)
    assert.match(route, /session\.faction_id !== NAUGHTY_SOULS_FACTION_ID/)
    assert.match(route, /faction_member_roster_snapshots/)
    assert.match(route, /faction_member_stat_snapshots/)
    assert.match(route, /faction_gym_energy_snapshots/)
    assert.match(route, /faction_performance_collection_runs/)
    assert.match(route, /status = 'completed'/)
    assert.match(workerSource, /if \(db\.batch\)/)
    assert.match(workerSource, /await db\.batch\(\[finishRun, updateState\]\)/,
      "the terminal run status and last-success timestamp must commit atomically in D1")
    const deadLetterFailureStart = workerSource.indexOf("async function markFactionPerformanceRunFailed")
    const deadLetterFailureEnd = workerSource.indexOf("async function enqueueOneFactionPerformanceRun", deadLetterFailureStart)
    const deadLetterFailure = workerSource.slice(deadLetterFailureStart, deadLetterFailureEnd)
    assert.match(deadLetterFailure, /await db\.batch\(\[failRun, failState\]\)/,
      "DLQ terminal run status and collection state must commit atomically")
    assert.match(route, /statsCapturedAt/)
    assert.match(route, /gymEnergyCapturedAt/)
    assert.match(route, /private, max-age=30/)
    assert.match(route, /faction_member_private_live_snapshots/)
    assert.match(route, /k\.share_with_faction = 1/, "private live values require the member's explicit sharing consent")
    assert.match(route, /st\.disabled_at IS NULL/, "disabled members' private live values must not be shared")
    assert.match(route, /privateLiveByUser/)
    assert.doesNotMatch(route, /api_keys|encrypted_api_key|SELECT ciphertext|SELECT \\* FROM member_private_live_keys/,
      "faction performance must never return encrypted credentials")
  })

  await test("faction performance migration preserves historical data independently of player rows", () => {
    const migration = readFileSync(join(root, "migrations/auth/0019_faction_performance_collection.sql"), "utf8")
    for (const table of [
      "faction_performance_collection_runs",
      "faction_performance_collection_state",
      "faction_membership_intervals",
      "faction_roster_snapshots",
      "faction_member_roster_snapshots",
      "faction_member_stat_snapshots",
      "faction_gym_energy_snapshots",
    ]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
    assert.match(migration, /WHERE left_observed_at IS NULL/)
    assert.match(migration, /estimated_joined_at/)
    assert.ok(migration.includes("ON faction_membership_intervals(user_id, faction_id, estimated_joined_at DESC)"))
    assert.ok(!migration.includes("ON faction_membership_intervals(user_id, faction_id, joined_at DESC)"))
    assert.doesNotMatch(migration, /REFERENCES players|ON DELETE CASCADE|DROP TABLE|DELETE FROM/i)
    assert.match(migration, /xantaken REAL/)
    assert.match(migration, /lsdtaken REAL/)
    assert.match(migration, /energydrinkused REAL/)
    assert.match(migration, /networth REAL/)
  })

  await test("member departure revokes access but never deletes faction performance history", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const departureStart = workerSource.indexOf("async function removeDepartedFactionAccess")
    const departureEnd = workerSource.indexOf("async function applyConfirmedFactionDeparture", departureStart)
    const cleanup = workerSource.slice(departureStart, departureEnd)
    for (const table of [
      "faction_roster_snapshots",
      "faction_member_roster_snapshots",
      "faction_member_stat_snapshots",
      "faction_gym_energy_snapshots",
      "faction_membership_intervals",
    ]) assert.doesNotMatch(cleanup, new RegExp(`DELETE FROM ${table}`))
  })

  await test("faction performance scheduler and queue use a dedicated Worker secret and bounded idempotent runs", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /TORN_FACTION_API_KEY/)
    assert.match(workerSource, /FACTION_PERFORMANCE_PAGE_SIZE = 5/)
    assert.match(workerSource, /collection_key/)
    assert.match(workerSource, /fiveMinuteBucket % 3 === 0/)
    assert.match(workerSource, /FACTION_PERFORMANCE_QUEUE_KIND/)
    assert.match(workerSource, /enqueueFactionPerformanceCollections\(env, scheduledTime\)/)
    assert.match(workerSource, /runFactionPerformanceCollection\(env, runId\)/)
    assert.match(workerSource, /message\.retry\(\{ delaySeconds: Math\.min\(60, attempts \* 10\) \}\)/)
    assert.match(workerSource, /WHERE run_id = \? AND status NOT IN \('completed', 'partial', 'failed'\)/)
    assert.match(workerSource, /left_observed_at IS NULL/)
    const rosterStart = workerSource.indexOf("async function runFactionRosterCollection")
    const rosterEnd = workerSource.indexOf("function emptyFactionPublicStats", rosterStart)
    const rosterCollector = workerSource.slice(rosterStart, rosterEnd)
    assert.match(rosterCollector, /members\.length === 0/, "an empty roster must not mark every member as departed")
    assert.match(rosterCollector, /DELETE FROM faction_member_roster_snapshots WHERE run_id = \?/, "a retried roster run must replace stale child rows")
    assert.ok(rosterCollector.indexOf("members.length === 0") < rosterCollector.indexOf("SELECT interval_id"),
      "an empty roster must be rejected before membership history is modified")
    assert.ok(workerSource.includes("setTimeout(resolve, 800)"))
    assert.ok(workerSource.includes("error.status === 429 || error.status >= 500 || error.code === 9"))
    assert.match(workerSource, /fetcher: env\.TORN_API_FIXTURE\?\.fetch\.bind\(env\.TORN_API_FIXTURE\)/,
      "the staging integration Worker must route Torn requests through a private fixture Service Binding")
    assert.match(workerSource, /Faction performance collection attempt failed/,
      "queue retries must log a sanitized, actionable failure classification")
    const integrationWrangler = readFileSync(join(root, "wrangler.faction-performance-integration.toml"), "utf8")
    assert.match(integrationWrangler, /binding = "TORN_API_FIXTURE"/)
    assert.match(integrationWrangler, /service = "naughty-company-api-faction-performance-mock"/)
    const factionQueueStart = workerSource.lastIndexOf("if (body.kind === FACTION_PERFORMANCE_QUEUE_KIND && runId)")
    const factionQueueEnd = workerSource.indexOf('if (body.kind === "faction-weekly-finalize")', factionQueueStart)
    const factionQueue = workerSource.slice(factionQueueStart, factionQueueEnd)
    const factionQueueCatch = factionQueue.slice(factionQueue.indexOf("} catch (error) {"))
    assert.match(factionQueueCatch, /message\.retry\(\{ delaySeconds: Math\.min\(60, attempts \* 10\) \}\)/)
    assert.doesNotMatch(factionQueueCatch, /markFactionPerformanceRunFailed|message\.ack\(\)/,
      "retry exhaustion must flow through the configured Cloudflare DLQ, not be acknowledged by the source consumer")
    const weeklyFinalizeStart = workerSource.indexOf('if (body.kind === "faction-weekly-finalize")', factionQueueStart)
    const weeklyFinalizeEnd = workerSource.indexOf('if (body.kind === "halloween-live-snapshot"', weeklyFinalizeStart)
    const weeklyFinalizeHandler = workerSource.slice(weeklyFinalizeStart, weeklyFinalizeEnd)
    assert.match(weeklyFinalizeHandler, /await finalizeFactionWeeklyReport\(env, parsedStart\)/)
    assert.match(weeklyFinalizeHandler, /message\.retry\(\{ delaySeconds: Math\.min\(60, attempts \* 10\) \}\)/,
      "weekly report finalization must retry transient storage failures")
    const dlqStart = workerSource.indexOf('if (batch.queue?.endsWith("-dlq"))')
    const mainLoopStart = workerSource.indexOf("\n  for (const message of batch.messages) {", dlqStart + 1)
    const dlqSource = workerSource.slice(dlqStart, mainLoopStart)
    assert.match(dlqSource, /markFactionPerformanceRunFailed/,
      "the dead-letter consumer must persist terminal collection failure")
    const statsPageStart = workerSource.indexOf("async function runFactionPersonalStatsCollectionPage")
    const statsPage = workerSource.slice(statsPageStart, workerSource.indexOf("async function runFactionGymEnergyCollection", statsPageStart))
    assert.ok(statsPage.indexOf("await saveFactionMemberStatSample") > statsPage.indexOf("} catch (error) {"),
      "D1 persistence must stay outside the per-member Torn API catch so storage failures retry the queue message")
    assert.doesNotMatch(workerSource, /The CI-only secret is not a Worker binding/)
    assert.ok(workerSource.includes('status === "completed" ? capturedAt : null'))
  })

  await test("company stock refreshes preserve current values and append historical stock snapshots", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0002_company_financial_history.sql"), "utf8")
    assert.equal((workerSource.match(/INSERT INTO company_financial_snapshots \(player_id, company_id, stock_json, fetched_at\)/g) ?? []).length, 3)
    assert.match(workerSource, /ON CONFLICT\(player_id, company_id\) DO UPDATE SET stock_json = excluded\.stock_json, fetched_at = excluded\.fetched_at/)
    assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS company_financial_snapshots/)
    assert.match(migrationSource, /company_financial_snapshots_owner_idx/)
    assert.doesNotMatch(migrationSource, /DROP TABLE|DELETE FROM company_financials/i)
  })

  await test("company history falls back to complete financial snapshots for stock quantity", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const historyStart = workerSource.indexOf('  if (historyMatch && request.method === "GET") {')
    const historyEnd = workerSource.indexOf('  if (rosterPath && request.method === "GET") {', historyStart)
    const historyBody = workerSource.slice(historyStart, historyEnd)
    assert.ok(historyStart >= 0 && historyEnd > historyStart, "company history route must remain identifiable")
    assert.match(historyBody, /const financialStockQuantityByDay = new Map<string, number>\(\)/)
    assert.match(historyBody, /financialStockQuantityByDay\.set\(row\.day/)
    assert.match(historyBody, /stockByDay\.get\(String\(point\.day\)\) \?\? financialStockQuantityByDay\.get\(String\(point\.day\)\) \?\? null/)
    assert.match(historyBody, /if \(!quantities\.some\(\(quantity\) => quantity === null\)\)/)
  })

  await test("manual company refresh updates live caches without appending immutable history", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const refreshStart = workerSource.indexOf('if (url.pathname === "/api/company/refresh" && request.method === "POST")')
    const refreshEnd = workerSource.indexOf("    // Compatibility routes use the same key-scoped endpoints;", refreshStart)
    const refreshBody = workerSource.slice(refreshStart, refreshEnd)
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "manual company refresh route must remain identifiable")
    assert.match(refreshBody, /INSERT INTO companies/, "manual refresh must update the live company cache")
    assert.match(refreshBody, /INSERT INTO company_financials/, "manual refresh must update the live stock cache")
    assert.match(refreshBody, /saveCompanyApiKey/, "manual refresh must preserve the saved company-key metadata")
    assert.match(refreshBody, /immutable history is captured by approved snapshot paths/)
    assert.doesNotMatch(refreshBody, /INSERT INTO company_snapshots|INSERT INTO company_financial_snapshots|persistFactionDirectorSnapshot/, "manual company refresh must not append profile, stock, or director history")
  })

  await test("global rankings use type-specific company lists at 18:10 UTC and official snapshot only verifies at 00:10 UTC", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const wranglerSource = readFileSync(join(root, "wrangler.toml"), "utf8")
    const configuredCrons = wranglerSource.match(/crons\s*=\s*\[([^\]]*)\]/)?.[1]
      .match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1)) ?? []
    assert.ok(configuredCrons.includes("10 18 * * *"), "the daily ranking capture schedule must remain configured")
    assert.ok(configuredCrons.includes("10 0 * * *"), "the official snapshot verification schedule must remain configured")
    assert.ok(configuredCrons.includes("*/5 * * * *"), "the Halloween live snapshot scheduler must remain configured")
    assert.match(workerSource, /controller\.cron\.trim\(\) === "\*\/5 \* \* \* \*"/, "the five-minute scheduler must have a dedicated handler")
    assert.match(workerSource, /runFiveMinuteScheduledJobs\(env, controller\.scheduledTime\)/, "the five-minute scheduler must run bounded membership and Halloween maintenance")
    assert.ok(workerSource.includes("https://api.torn.com/v2/company/\u0024{type.id}/companies?offset=\u0024{offset}&limit=\u0024{pageSize}"))
    assert.ok(workerSource.includes("https://api.torn.com/v2/company/snapshot"))
    assert.ok(workerSource.includes('source: "Daily cached Torn API v2 /company/{typeId}/companies lists"'))
    assert.match(workerSource, /controller\.cron\.trim\(\) === "10 18 \* \* \*"/)
    assert.match(workerSource, /controller\.cron\.trim\(\) === "10 0 \* \* \*"/)
    assert.match(workerSource, /if \(isRankingCaptureWindow\) tasks\.push\(refreshGlobalRankingCache\(env, undefined, true\)\)/)
    assert.match(workerSource, /if \(isOfficialVerificationWindow\) tasks\.push\(verifyGlobalRankingsAgainstOfficialSnapshot\(env, controller\.scheduledTime\)/)
    assert.match(workerSource, /const maxAgeMs = 6 \* 60 \* 60 \* 1000/)
    assert.match(workerSource, /uniqueIds\.size !== companies\.length/)
    const refreshBody = workerSource.slice(workerSource.indexOf("async function refreshGlobalRankingCache"), workerSource.indexOf("async function verifyGlobalRankingsAgainstOfficialSnapshot"))
    const verificationBody = workerSource.slice(workerSource.indexOf("async function verifyGlobalRankingsAgainstOfficialSnapshot"), workerSource.indexOf("function companyProfileRoot"))
    assert.match(refreshBody, /startGlobalRankingRefresh/, "production ranking refreshes must use the durable queue workflow")
    assert.doesNotMatch(refreshBody, /fetchOfficialCompanySnapshot/, "official snapshot must not be used to refresh ranking data")
    assert.match(workerSource, /No saved Torn API key is available to refresh the global company rankings cache/, "missing ranking credentials must be surfaced as a failed refresh")
    assert.match(workerSource, /maxPagesPerInvocation = 3/, "each queue invocation must have a hard page-fetch bound")
    assert.match(workerSource, /global_rankings_refresh_pages/, "in-progress pages must be staged separately from the published cache")
    assert.match(workerSource, /finalizeGlobalRankingRefresh/, "staged rows must pass final validation before cache publication")
    assert.match(wranglerSource, /binding = "GLOBAL_RANKINGS_QUEUE"/, "production must bind the resumable queue")
    assert.match(wranglerSource, /dead_letter_queue = "ncd-global-rankings-refresh-dlq"/, "exhausted queue retries must be captured for cleanup")
    assert.match(verificationBody, /fetchOfficialCompanySnapshot\(apiKey\)/, "official snapshot is only loaded by the verifier")
    assert.doesNotMatch(verificationBody, /INSERT INTO global_rankings_cache|UPDATE global_rankings_cache/, "official verification must never overwrite the ranking cache")
    assert.equal([...workerSource.matchAll(/refreshGlobalRankingCache\(/g)].length, 4, "ranking cache refresh calls must be limited to the routine, scheduled capture, stale-cache path, and explicit admin endpoint")
  })

  await test("inactive faction memberships are revalidated in bounded scheduled batches", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0016_membership_revalidation_scheduler.sql"), "utf8")
    const stateMigrationSource = readFileSync(join(root, "migrations/auth/0018_membership_verification_state.sql"), "utf8")
    const batchStart = workerSource.indexOf("async function revalidateFactionMembershipBatch")
    const batchEnd = workerSource.indexOf("async function authenticate", batchStart)
    assert.ok(batchStart >= 0 && batchEnd > batchStart, "the scheduled membership revalidation batch must remain identifiable")
    const batchSource = workerSource.slice(batchStart, batchEnd)
    assert.match(migrationSource, /membership_check_attempted_at TEXT/)
    assert.match(migrationSource, /players_membership_revalidation_idx/)
    assert.match(stateMigrationSource, /membership_check_status TEXT/)
    assert.match(stateMigrationSource, /'checking', 'unavailable', 'cleanup_pending'/)
    assert.ok(batchSource.includes("LIMIT ?"))
    assert.ok(batchSource.includes("membership_check_attempted_at IS NULL OR membership_check_attempted_at < ?"), "scheduled jobs must atomically claim stale membership checks")
    assert.ok(batchSource.includes("claim.meta?.changes"), "overlapping scheduled or request-time checks must not duplicate Torn calls")
    assert.ok(batchSource.indexOf("claim.meta?.changes") < batchSource.indexOf("await savedKey(env, playerId)"), "the scheduled sweep must win the atomic claim before decrypting or contacting Torn")
    assert.ok(batchSource.includes("const attemptTime = Date.now()"), "scheduled claims must use execution time so delayed cron delivery cannot create an already-expired lock")
    assert.ok(batchSource.includes("Math.min(10, batchSize)"))
    assert.match(batchSource, /membership_check_attempted_at/)
    assert.ok(batchSource.includes("catch {") && batchSource.includes("continue"), "Torn and decryption failures must be retried, not treated as faction departure")
    assert.ok(batchSource.includes("await removeDepartedFactionAccess(env, playerId)"))
    const authStart = workerSource.indexOf("async function authenticate")
    const authEnd = workerSource.indexOf("async function validateTornKey", authStart)
    const authSource = workerSource.slice(authStart, authEnd)
    assert.match(authSource, /p\.membership_check_attempted_at/)
    assert.ok(authSource.includes("attemptedRecently"), "request-time checks must honor a recent scheduled or request attempt")
    assert.ok(authSource.includes("membership_check_attempted_at IS NULL OR membership_check_attempted_at < ?"), "request-time checks must use an atomic claim instead of racing concurrent requests")
    assert.ok(authSource.includes("Number(claim.meta?.changes ?? 0) < 1"), "only the request that wins the check claim may contact Torn")
    assert.ok(authSource.includes("Another request or the scheduled sweep claimed this check window"), "a losing concurrent request must use bounded grace without making a duplicate Torn call")
    assert.ok(authSource.includes("attemptAgeMs <= 5 * 60 * 1000"), "repeated Torn checks must have a five-minute backoff")
    assert.ok(authSource.includes("ageMs > 15 * 60 * 1000"), "outage grace must remain bounded by the last successful verification")
    assert.ok(authSource.indexOf("UPDATE players SET membership_check_attempted_at = ?") < authSource.indexOf("await verifyFactionMembershipWithKey(apiKey)"), "record the request attempt before contacting Torn")
    assert.ok(authSource.indexOf("const apiKey = await savedKey(env, session.player_id)") < authSource.indexOf("const attemptedRecently"), "a missing saved login key must still fail closed during the backoff")
    assert.ok(authSource.includes('session.membership_check_status === "cleanup_pending"'), "confirmed departures pending cleanup must not be treated as ordinary outages")
    assert.ok(authSource.includes("if (retryCleanup)"), "cleanup-pending retries must fail closed on another Torn outage")
    assert.ok(authSource.includes('membership_check_status = \'unavailable\''), "only genuine Torn failures may enter outage grace")
    assert.ok(authSource.includes('membership_check_status = \'cleanup_pending\''), "cleanup failures must remain explicitly pending")

    assert.ok(batchSource.indexOf("await removeDepartedFactionAccess(env, playerId)") < batchSource.lastIndexOf("UPDATE players SET faction_id = ?"), "confirmed departure cleanup must complete before the membership row is changed")
    const departedStart = workerSource.indexOf("async function removeDepartedFactionAccess")
    const departedEnd = workerSource.indexOf("function classifyHalloweenLog", departedStart)
    const departedSource = workerSource.slice(departedStart, departedEnd)
    assert.ok(departedSource.includes("await purgeHalloweenMemberData(env, playerId)"))
    assert.ok(departedSource.includes("DELETE FROM sessions WHERE player_id = ?"))
    assert.ok(departedSource.includes("DELETE FROM api_keys WHERE player_id = ?"))
    assert.ok(departedSource.includes("DELETE FROM faction_member_cache WHERE player_id = ?"))
    assert.ok(departedSource.includes("DELETE FROM company_sharing_recipients"))
    const scheduledStart = workerSource.indexOf("async function runFiveMinuteScheduledJobs")
    const scheduledEnd = workerSource.indexOf("export default", scheduledStart)
    const scheduledSource = workerSource.slice(scheduledStart, scheduledEnd)
    assert.ok(scheduledSource.includes("revalidateFactionMembershipBatch(env, scheduledTime)"))
    assert.ok(scheduledSource.includes("enqueueScheduledHalloweenSnapshots(env, scheduledTime)"))
  })

  await test("Halloween live snapshot jobs remain retryable until the bounded queue retry limit", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const jobStart = workerSource.indexOf("async function runHalloweenLiveSnapshotJob")
    const jobEnd = workerSource.indexOf("async function enqueueHalloweenLiveSnapshot", jobStart)
    assert.ok(jobStart >= 0 && jobEnd > jobStart, "the Halloween live snapshot job handler must remain identifiable")
    const jobSource = workerSource.slice(jobStart, jobEnd)
    const transientCatch = jobSource.slice(jobSource.indexOf("} catch (error) {"))
    assert.ok(jobSource.includes("SET status = 'queued', last_error"), "transient failures must return the job to the queue")
    assert.doesNotMatch(transientCatch, /SET status = 'failed'/, "a transient failure must not be terminal before queue retries are exhausted")
    assert.ok(jobSource.includes("Snapshot was cancelled because this member's dashboard access is disabled."), "disabled members must stop before snapshot collection")
    const queueSource = workerSource.slice(workerSource.indexOf("async function handleGlobalRankingQueueBatch"), workerSource.indexOf("async function refreshGlobalRankingCache"))
    assert.ok(queueSource.includes("attempts < 4") && queueSource.includes("message.retry("), "live snapshot jobs must use bounded queue retries")
    assert.ok(queueSource.includes("UPDATE halloween_live_snapshot_jobs SET status = 'failed'"), "the consumer must mark the job failed after the retry limit")
    const enqueueStart = workerSource.indexOf("async function enqueueHalloweenLiveSnapshot")
    const enqueueEnd = workerSource.indexOf("async function enqueueScheduledHalloweenSnapshots", enqueueStart)
    const enqueueSource = workerSource.slice(enqueueStart, enqueueEnd)
    assert.ok(enqueueSource.includes("if (existing) return"), "terminal jobs must not be re-enqueued on every scheduler tick")
    assert.doesNotMatch(enqueueSource, /UPDATE halloween_live_snapshot_jobs SET status = 'queued'/, "a failed event bucket must not create an unbounded retry loop")
  })

  await test("Trick or Treat event windows follow each member's selected TCT slot", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0017_halloween_member_event_slots.sql"), "utf8")
    const uiSource = readFileSync(join(root, "src/components/portal/workspaces.tsx"), "utf8")
    assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS halloween_member_event_slots/)
    assert.match(migrationSource, /start_minute_of_day INTEGER NOT NULL/)
    assert.match(migrationSource, /BETWEEN 600 AND 960 AND start_minute_of_day % 15 = 0/)
    assert.match(migrationSource, /window_start_at TEXT/)
    assert.match(migrationSource, /window_end_at TEXT/)
    const windowStart = workerSource.indexOf("function buildHalloweenMemberEventWindow")
    const windowEnd = workerSource.indexOf("async function getHalloweenMemberEventWindow", windowStart)
    assert.ok(windowStart >= 0 && windowEnd > windowStart, "the personal event-window builder must be present")
    const windowSource = workerSource.slice(windowStart, windowEnd)
    assert.ok(windowSource.includes("startMinuteOfDay < 600") && windowSource.includes("startMinuteOfDay > 960"))
    assert.ok(windowSource.includes("startMinuteOfDay % 15 !== 0"), "only 15-minute TCT slots are accepted")
    assert.ok(windowSource.includes("event.startAt.slice(0, 10)") && windowSource.includes("event.endAt.slice(0, 10)"))
    assert.ok(windowSource.includes("startDay + startMinuteOfDay * 60 * 1000"))
    assert.ok(windowSource.includes("endDay + startMinuteOfDay * 60 * 1000"), "the same selected TCT clock time must define the end boundary")
    assert.ok(workerSource.includes('/api/me/halloween/event-window'), "members need authenticated read and save routes for their personal time")
    assert.ok(workerSource.includes("halloween_member_event_slots (event_year, player_id, start_minute_of_day"), "the selected time must be saved per member and year")
    assert.ok(workerSource.includes("Select your personal Trick or Treat start time before collecting historical logs."))
    assert.ok(workerSource.includes("window_start_at, window_end_at"), "historical jobs must pin the selected personal window")
    const collectorStart = workerSource.indexOf("async function runHalloweenLogCollectionPage")
    const collectorEnd = workerSource.indexOf("async function runHalloweenLiveSnapshot", collectorStart)
    const collectorSource = workerSource.slice(collectorStart, collectorEnd)
    assert.ok(collectorSource.includes("job.window_start_at || event.start_at") && collectorSource.includes("job.window_end_at || event.end_at"))
    assert.ok(collectorSource.includes("eventTimestamp < eventStart || eventTimestamp >= eventEnd"), "historical log inserts must remain inside the selected personal window")
    const liveStart = workerSource.indexOf("async function runHalloweenLiveSnapshot")
    const liveEnd = workerSource.indexOf("async function runHalloweenLiveSnapshotJob", liveStart)
    assert.ok(workerSource.slice(liveStart, liveEnd).includes("getHalloweenMemberEventWindow(env, playerId, eventYear)"))
    const schedulerStart = workerSource.indexOf("async function enqueueScheduledHalloweenSnapshots")
    const schedulerEnd = workerSource.indexOf("async function handleGlobalRankingQueueBatch", schedulerStart)
    const schedulerSource = workerSource.slice(schedulerStart, schedulerEnd)
    assert.ok(schedulerSource.includes("JOIN halloween_member_event_slots"), "live snapshots must be scheduled only for members with a configured slot")
    assert.ok(schedulerSource.includes("memberStartMs") && schedulerSource.includes("memberEndMs"), "opening, periodic, and closing captures must use each member's own boundaries")
    assert.ok(workerSource.includes("halloween_live_snapshot_jobs WHERE player_id = ? AND event_year = ? LIMIT 1"), "queued live captures must lock time-slot edits")
    assert.ok(uiSource.includes("length: 25") && uiSource.includes("10 * 60 + index * 15"), "the UI must expose all 25 times from 10:00 through 16:00")
    assert.ok(uiSource.includes('id="halloween-personal-start-time"'), "the member must be able to select a personal event start time")
    assert.ok(uiSource.includes("November 1 at the same selected clock time"), "the UI must explain the correlated end time")
  })

  await test("admin endpoint refresh is admin-gated, selective, audited, and live-only", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const uiSource = readFileSync(join(root, "src/components/floor/admin-panel.tsx"), "utf8")
    const floorAppSource = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0008_admin_endpoint_refresh.sql"), "utf8")
    const adminStart = workerSource.indexOf("async function handleAdminRequest")
    const jobsRoute = workerSource.indexOf('if (url.pathname === "/api/admin/jobs" && request.method === "POST")', adminStart)
    const adminRoutes = workerSource.slice(adminStart, workerSource.indexOf("\nasync function ", adminStart + 30))
    const refreshStart = workerSource.indexOf("async function runAdminEndpointRefresh")
    const refreshEnd = workerSource.indexOf("async function runAdminJob", refreshStart)
    const refreshBody = workerSource.slice(refreshStart, refreshEnd)
    assert.ok(adminStart >= 0 && jobsRoute > adminStart)
    assert.ok(adminRoutes.includes("session.is_admin !== 1"), "admin routes must require the current D1 role")
    assert.ok(workerSource.includes("LEFT JOIN administrators a ON a.player_id = p.player_id AND a.revoked_at IS NULL"))
    assert.ok(workerSource.includes("INSERT INTO administrators"), "administrator role must be persisted")
    assert.ok(workerSource.includes("administrator.granted"))
    assert.ok(workerSource.includes("administrator.revoked"))
    assert.doesNotMatch(workerSource, /ADMIN_PASSWORD_HASH|ADMIN_USERNAME|isAdminElevated|admin_elevated_until/)
    assert.doesNotMatch(floorAppSource, /Unlock administration|adminPassword|adminUsername/)
    assert.match(adminRoutes, /ensureAdminJobPayloadSchema\(env\)/)
    assert.match(adminRoutes, /"endpoint-refresh"/)
    assert.match(adminRoutes, /rawIds\.length > 100/, "selected-user jobs must be bounded")
    assert.match(adminRoutes, /manualRefreshEnabled/, "global manual-refresh policy must be enforced")
    assert.match(workerSource, /job_payload_json AS jobPayloadJson/)
    assert.match(workerSource, /ALTER TABLE admin_jobs ADD COLUMN job_payload_json TEXT/)
    assert.match(refreshBody, /client\.getCompanyProfile\(\)/)
    assert.match(refreshBody, /client\.getCompanyEmployees\(\)/)
    assert.match(refreshBody, /client\.getCompanyStock\(\)/)
    assert.match(refreshBody, /WHERE player_id IN \(/, "selected-user refreshes must scope the credential query")
    assert.match(refreshBody, /refreshGlobalRankingCache\(env, undefined, true\)/)
    assert.match(refreshBody, /syncFactionDirectorDirectory\(env, apiKey, 35, true\)/, "manual directory refresh must force live lookup without writing director history")
    assert.doesNotMatch(workerSource, /captureSnapshots|persistFactionDirectorSnapshot\(env, profile\)/, "profile-only refreshes must not create director history")
    assert.doesNotMatch(refreshBody, /fetchOfficialCompanySnapshot/, "the official snapshot endpoint must not be used for a manual rankings refresh")
    assert.doesNotMatch(refreshBody, /https:\/\/api\.torn\.com\/v2\/company\/snapshot/, "manual rankings refresh must not fetch the official snapshot URL")
    assert.doesNotMatch(refreshBody, /INSERT INTO company_snapshots|INSERT INTO company_financial_snapshots|persistFactionDirectorSnapshot/, "manual endpoint refreshes must not append immutable historical snapshots")
    const persistStart = workerSource.indexOf("async function persistCompanyConnection")
    const persistEnd = workerSource.indexOf("async function ensurePrimaryCompanyConnection", persistStart)
    const persistBody = workerSource.slice(persistStart, persistEnd)
    assert.match(persistBody, /if \(captureHistory\) \{\s*const \[profileHistory, financialHistory, directorHistory\]/)
    assert.match(persistBody, /if \(!profileHistory && !financialHistory && !directorHistory\)/)
    assert.match(workerSource, /persistCompanyConnection\(env, job\.target_player_id, apiKey, validated, false\)/, "admin company refresh must update live data only")
    assert.match(workerSource, /if \(isRepair\) await persistCompanyConnection\(env, targetId, apiKey, validated, false\)/, "admin repairs must not create new history snapshots")
    const rankingStart = workerSource.indexOf("async function refreshRankingProfiles")
    const rankingEnd = workerSource.indexOf("\ntype AdminAuditOutcome", rankingStart)
    const rankingBody = workerSource.slice(rankingStart, rankingEnd)
    assert.match(rankingBody, /const sourceSnapshotAt = captureHistory \? officialSnapshotSourceTime\(sourceTimestamp, snapshotSchedule\) : null/)
    assert.match(rankingBody, /if \(sourceSnapshotAt\) \{\s*const fetchedAt = sourceSnapshotAt\.toISOString\(\)/)
    assert.match(workerSource, /refreshRankingProfiles\(env, false\)/, "legacy global admin refresh must not append ranking history")
    assert.match(workerSource, /refreshFactionDirectoryFromAnyKey\(env, 35, true\)/, "legacy global admin refresh must force a live directory batch without history")
    assert.match(uiSource, /REFRESH_ENDPOINT_OPTIONS/)
    assert.match(uiSource, /setRefreshScope\("selected"\)/)
    assert.match(uiSource, /setRefreshSelectedUserIds/)
    assert.match(migrationSource, /ALTER TABLE admin_jobs ADD COLUMN job_payload_json TEXT/)
  })

  await test("stock difference uses saved daily trend records instead of imported chart archive", () => {
    const uiSource = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /PARTITION BY date\(fetched_at, '-18 hours'\)/)
    assert.match(workerSource, /fetchedAtMs - 18 \* 60 \* 60 \* 1000/)
    assert.ok(uiSource.includes("/api/me/companies/\u0024{encodeURIComponent(companyId)}/history?days=7"))
    assert.match(uiSource, /const officialStockSnapshots = officialStockHistory/)
    assert.match(uiSource, /const stockDifference = currentOfficialStockSnapshot\?\.stockQuantity != null && previousStockSnapshot\?\.stockQuantity != null/)
    assert.match(uiSource, /missingStockSnapshotDays\.join\(" and "\)/)
    assert.doesNotMatch(uiSource, /const officialStockSnapshots = \(currentChartCompany\?\.history \?\? \[\]\)/)
  })

  await test("scheduled automation records stale-rule and digest delivery failures for dashboard visibility", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /let staleRuleFailures = 0/)
    assert.match(workerSource, /let digestFailures = 0/)
    assert.match(workerSource, /stale-data rule evaluation\(s\) failed/)
    assert.match(workerSource, /daily digest delivery group\(s\) failed/)
    assert.match(workerSource, /error_summary AS errorSummary FROM automation_runs ORDER BY started_at DESC LIMIT 1/)
    assert.match(workerSource, /async function deliverDailyAutomationDigests\(env: WorkerEnv, now = new Date\(\)\): Promise<number>/)
    const uiSource = readFileSync(join(root, "src/components/floor/alerts-panel.tsx"), "utf8")
    assert.match(uiSource, /errorSummary\?: string \| null/)
    assert.match(uiSource, /Run details: \{latestRun.errorSummary\}/)
  })

  await test("exceptional instant webhook delivery failures are logged for retry and visibility", () => {
    const source = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const start = source.indexOf("async function deliverAutomationWebhook(")
    const end = source.indexOf("async function deliverAutomationDigest(", start)
    const delivery = source.slice(start, end)
    assert.match(delivery, /Record failures that occur before the HTTP request/)
    assert.match(delivery, /INSERT INTO automation_delivery_log[^\n]+VALUES \(\?, \?, \?, 'failed', NULL/)
    assert.match(delivery, /UPDATE automation_webhooks SET last_error = \?, updated_at = \? WHERE owner_player_id = \?/)
    assert.match(delivery, /return \{ attempted: true, delivered: false, detail \}/)
  })

  await test("combined webhook mode sends alerts immediately and includes owners in daily summaries", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /!\["instant", "both"\]\.includes\(preferences\.digestMode\)/)
    assert.match(workerSource, /WHERE digest_mode IN \('daily', 'both'\)/)
    assert.match(workerSource, /digest_mode IN \('instant', 'daily', 'both', 'off'\)/)
    const uiSource = readFileSync(join(root, "src/components/floor/alerts-panel.tsx"), "utf8")
    assert.match(uiSource, /Instant alerts \+ daily summary/)
  })

  await test("historical period comparisons fetch enough prior history independent of chart range", () => {
    const source = readFileSync(join(root, "src/components/floor/insights-workspace.tsx"), "utf8")
    assert.match(source, /const \[comparisonHistory, setComparisonHistory\] = useState<TrendPoint\[\]>/)
    assert.match(source, /Number\(comparisonDays\) === 7 \? "30" : Number\(comparisonDays\) === 30 \? "90" : "365"/)
    assert.match(source, /if \(view === "trends" \|\| view === "executive"\) tasks\.push\(loadComparison\(\)\)/)
    assert.match(source, /vs prior \{comparisonDays\}-day average/)
    assert.match(source, /const comparison = useMemo\(\(\) => \{ const points = comparisonHistory/)
  })

  await test("Trends workspace charts daily profit and stock quantity without treating missing points as zero", () => {
    const source = readFileSync(join(root, "src/components/floor/insights-workspace.tsx"), "utf8")
    assert.match(source, /type TrendPoint = \{[^}]*dailyProfit: number \| null/)
    assert.match(source, /const profitSeries: ChartSeries.*point\.dailyProfit/)
    assert.match(source, /const stockQuantitySeries: ChartSeries.*point\.stockQuantity/)
    assert.match(source, /LineChart title="Daily profit" money series=\{profitSeries\}/)
    assert.match(source, /LineChart title="Stock quantity" series=\{stockQuantitySeries\}/)
    assert.match(source, /<th>DAILY PROFIT<\/th>/)
    assert.match(source, /<td>\{money\(point\.dailyProfit\)\}<\/td>/)
    assert.match(source, /const points = \(trends\?\.history \|\| \[\]\)\.filter\(\(point\) => point\[metric\] !== null && Number\.isFinite\(point\[metric\]\)\)/)
  })

  await test("daily webhook digest sends every eligible alert in Discord-safe batches and logs each batch accurately", () => {
    const source = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(source, /for \(let offset = 0; offset < eligible\.length; offset \+= 10\)/)
    assert.match(source, /const batch = eligible\.slice\(offset, offset \+ 10\)/)
    assert.match(source, /eventCount: batch\.length, alerts: batch/)
    assert.match(source, /await deliverAutomationDigest\(env, owner\.ownerPlayerId, events\.results \?\? \[\]\)/)
    assert.match(source, /for \(const alert of batch\) \{\s*await db\.prepare\(\"INSERT INTO automation_delivery_log/)
    assert.match(source, /last_error = \?, updated_at = \? WHERE owner_player_id = \?/)
    assert.match(source, /Daily digest could not be completed\. Check the configured endpoint and encryption settings\./)
    assert.match(source, /anyFailed \? lastFailure : null/)
    assert.match(source, /e\.owner_player_id = \? AND e\.created_at <= \? AND CASE e\.severity/)
    assert.match(source, /d\.status = 'delivered' AND d\.detail LIKE 'Daily digest%'/)
    assert.doesNotMatch(source, /d\.event_id = e\.event_id AND d\.status = 'delivered'\) ORDER BY e\.created_at/)
  })

  await test("webhook digest preferences are independent from browser notification delivery", () => {
    const source = readFileSync(join(root, "src/components/floor/alerts-panel.tsx"), "utf8")
    assert.match(source, /digestMode: "instant" \| "daily" \| "both" \| "off"/)
    assert.match(source, /Daily summary only/)
    assert.match(source, /Webhook delivery mode/)
    assert.match(source, /browserNotificationsEnabled: enabled \}\)\)/)
    assert.doesNotMatch(source, /preferences\.browserNotificationsEnabled \|\| preferences\.digestMode === "off"/)
  })

  await test("accepts only public HTTPS webhook destinations", () => {
    assert.equal(normalizeWebhookUrl("https://hooks.example.com/alert"), "https://hooks.example.com/alert")
    assert.equal(normalizeWebhookUrl("http://hooks.example.com/alert"), null)
    assert.equal(normalizeWebhookUrl("https://localhost/alert"), null)
    assert.equal(normalizeWebhookUrl("https://127.0.0.1/alert"), null)
    assert.equal(normalizeWebhookUrl("https://192.168.1.10/alert"), null)
    assert.equal(normalizeWebhookUrl("https://user:secret@hooks.example.com/alert"), null)
    assert.equal(normalizeWebhookUrl("https://[::1]/alert"), null)
    for (const address of ["0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.254", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1"]) assert.equal(normalizeWebhookUrl(`https://${address}/alert`), null, `${address} must not be accepted as a public webhook host`)
    assert.equal(normalizeWebhookUrl("https://8.8.8.8/alert"), "https://8.8.8.8/alert")
    // WHATWG URL parsing canonicalizes shortened, integer, octal, and hexadecimal IPv4 forms.
    for (const host of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0x7f.0.0.1", "10.1", "0x0a000001"]) {
      assert.equal(normalizeWebhookUrl(`https://${host}/alert`), null, `${host} must not bypass private-address checks`)
    }
    for (const host of ["256.1.1.1", "1.2.3.4.5", "999999999999", "1..2.3"]) {
      assert.equal(normalizeWebhookUrl(`https://${host}/alert`), null, `${host} is not a valid public IPv4 host`)
    }
    assert.equal(normalizeWebhookUrl("https://hooks.example.com:8443/alert"), null)
    assert.equal(normalizeWebhookUrl("https://hooks.example.com:443/alert"), "https://hooks.example.com/alert")
  })

  await test("webhook delivery never follows redirects to unvalidated destinations", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /fetch\(endpoint, \{ method: "POST", redirect: "manual"/)
  })

  await test("Discord webhooks receive native alert, digest, and test message payloads", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /function buildWebhookPayload\(/)
    assert.match(workerSource, /url\.hostname === "discord\.com" \|\| url\.hostname === "discordapp\.com"/)
    assert.match(workerSource, /allowed_mentions: \{ parse: \[\] \}/)
    assert.match(workerSource, /Naughty Company Dashboard daily summary/)
    assert.match(workerSource, /Discord is connected and ready for alerts and summaries/)
    assert.match(workerSource, /const webhookTestPath = url\.pathname === "\/api\/me\/automation-webhook\/test"/)
    assert.match(workerSource, /sendWebhookTest\(env, session\.player_id, kind\)/)
    const uiSource = readFileSync(join(root, "src/components/floor/alerts-panel.tsx"), "utf8")
    assert.match(uiSource, /Test connection/)
    assert.match(uiSource, /automation-webhook\/test/)
  })

  await test("normalizes company profile and employee role fit", () => {
    const catalog = { companies: { "Test Shop": [
      { rank: "Manager", primary: "INT", primaryMin: 100, secondary: "END", secondaryMin: 50, special: null },
    ] } }
    const profile = { profile: {
      id: 77, name: "Sample Shop", type: { id: 1, name: "Test Shop" }, rating: 5,
      director: { name: "Director" }, employees: { hired: 2, capacity: 5 },
      income: { daily: 123, weekly: 861 }, customers: { daily: 10, weekly: 70 },
      applications_allowed: true,
    } }
    const employees = { employees: [
      { id: 1, name: "Ada", position: { id: 1, name: "Manager" }, days_in_company: 10,
        stats: { manual_labor: 20, intelligence: 150, endurance: 70 }, effectiveness: { total: 98 } },
      { id: 2, name: "Ben", position: { id: 1, name: "Manager" }, days_in_company: 3 },
    ] }
    const model = runEngine(profile, employees, catalog)
    assert.equal(model.company.name, "Sample Shop")
    assert.equal(model.employees.length, 2)
    assert.equal(model.employeesMeetingRequirements, 1)
    assert.equal(model.employeesWithUnknownFit, 1)
    assert.equal(model.employees[1].stats, null)
    assert.equal(model.employees[1].fit, "unknown")
  })

  await test("uses the primary company profile endpoint without a path company ID", async () => {
    let requestedUrl = ""
    const client = new TornApiClient({ apiKey: "test", fetcher: async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({ company: { id: 77 } }))
    } })
    const response = await client.getCompanyProfile()
    assert.equal(requestedUrl, "https://api.torn.com/v2/company/profile")
    assert.equal(response.company.id, 77)
  })

  await test("binds the default fetch to the Worker global scope", async () => {
    const originalFetch = globalThis.fetch
    let receiver
    globalThis.fetch = function (input, init) {
      receiver = this
      return Promise.resolve(new Response(JSON.stringify({ company: { id: 77 } })))
    }
    try {
      const client = new TornApiClient({ apiKey: "test" })
      const response = await client.getCompanyProfile()
      assert.equal(receiver, globalThis)
      assert.equal(response.company.id, 77)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("fetches company profile, employees, and stock in one combined Torn request", async () => {
    let requestedUrl = ""
    const client = new TornApiClient({ apiKey: "test", fetcher: async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        timestamp: 1791845111,
        employees: [{ id: 1, name: "Employee" }],
        stock: [{ id: 173, name: "Oil (Barrel)" }],
        profile: { id: 77, name: "Sample Oil Rig", type: { id: 28, name: "Oil Rig" } },
      }))
    } })
    const response = await client.getCompanySelections()
    assert.equal(requestedUrl, "https://api.torn.com/v2/company?selections=timestamp%2Cprofile%2Cstock%2Cemployees")
    assert.equal(response.timestamp, 1791845111)
    assert.equal(response.profile.profile.id, 77)
    assert.equal(response.employees.employees.length, 1)
    assert.equal(response.stock.stock.length, 1)
  })

  await test("normalizes Torn combined company responses that retain OpenAPI response wrappers", async () => {
    const client = new TornApiClient({ apiKey: "test", fetcher: async () => new Response(JSON.stringify({
      timestamp: 1791845000,
      profile: { profile: { id: 78, name: "Wrapped Company", type: { id: 28, name: "Oil Rig" } } },
      employees: { employees: [{ id: 2, name: "Wrapped Employee" }] },
      stock: { stock: [{ id: 173, name: "Oil (Barrel)" }] },
    })) })
    const response = await client.getCompanySelections()
    assert.equal(response.timestamp, 1791845000)
    assert.equal(response.profile.profile.id, 78)
    assert.equal(response.employees.employees.length, 1)
    assert.equal(response.stock.stock.length, 1)
  })

  await test("uses the OpenAPI faction member, user job-by-ID, and company profile-by-ID endpoints", async () => {
    const requested = []
    const client = new TornApiClient({ apiKey: "test", fetcher: async (input) => {
      requested.push(String(input))
      return new Response(JSON.stringify({ members: [], job: { position: "Director" }, profile: { id: 99 } }))
    } })
    await client.getFactionMembers()
    await client.getFactionMembersForRoster()
    await client.getFactionGymEnergyContributors()
    await client.getUserJobFor(12345)
    await client.getCompanyProfileById(96639)
    assert.deepEqual(requested, [
      "https://api.torn.com/v2/faction/members",
      "https://api.torn.com/v2/faction/members?striptags=true",
      "https://api.torn.com/v2/faction/contributors?stat=gymenergy",
      "https://api.torn.com/v2/user/12345/job",
      "https://api.torn.com/v2/company/96639/profile",
    ])
  })

  await test("decodes all current personalstats response variants using guarded runtime paths", () => {
    const cases = [
      ["full", { kind: "all" }, 20, 14],
      ["fullPublic", { kind: "all" }, 10, 4],
      ["popular", { kind: "popular" }, 7, 10],
    ]
    for (const [fixtureName, request, expectedXanax, expectedLsd] of cases) {
      const decoded = decodePersonalStatsResponse(personalStatsFixtures[fixtureName], request)
      assert.equal(decoded.kind, "current")
      assert.equal(decoded.metrics.xantaken, expectedXanax)
      assert.equal(decoded.metrics.lsdtaken, expectedLsd)
      assert.equal(decoded.metrics.drugsused, fixtureName === "full" ? 145 : fixtureName === "fullPublic" ? 55 : 17)
      assert.equal(decoded.metrics.alcoholused, fixtureName === "full" ? 22 : fixtureName === "fullPublic" ? 12 : 5)
      assert.equal(decoded.metrics.energydrinkused, fixtureName === "full" ? 23 : fixtureName === "fullPublic" ? 13 : 6)
      assert.equal(decoded.metrics.refills, fixtureName === "full" ? 25 : fixtureName === "fullPublic" ? 15 : 2)
      assert.equal(decoded.metrics.networth, fixtureName === "full" ? 260000000 : fixtureName === "fullPublic" ? 160000000 : 180000000)
      assert.equal(decoded.missingMetrics.length, 0)
    }
  })

  await test("live sanitized Popular fixture contains every required dashboard metric", () => {
    const decoded = decodePersonalStatsResponse(livePersonalStatsFixtures.popular, { kind: "popular" })
    assert.equal(decoded.kind, "current")
    assert.equal(decoded.missingMetrics.length, 0)
    assert.equal(decoded.metrics.xantaken, 0)
    assert.equal(decoded.metrics.lsdtaken, 0)
    assert.equal(Object.values(decoded.metrics).filter((value) => value !== null).length, 18)
    assert.ok(livePersonalStatsFixtures.capture.popularMetricCount === 18)
    assert.equal(livePersonalStatsFixtures.capture.popularMissingMetricCount, 0)

    const differentiated = structuredClone(livePersonalStatsFixtures.popular)
    differentiated.personalstats.items.used.energy = 999
    differentiated.personalstats.items.used.energy_drinks = 123
    assert.equal(
      decodePersonalStatsResponse(differentiated, { kind: "popular" }).metrics.energydrinkused,
      123,
      "the separate items.used.energy_drinks field is the energy-drink metric, not items.used.energy",
    )
  })

  await test("faction roster parser rejects redacted placeholder identifiers in sanitized fixtures", () => {
    const parsed = parseFactionRosterResponse(livePersonalStatsFixtures.factionRoster)
    assert.equal(parsed.length, 0, "sanitized fixture IDs are intentionally invalid and must never be mistaken for real members")
  })

  await test("faction roster parser normalizes nested last-action/status fields and only official revive enums", () => {
    const payload = {
      members: [{
        id: 123456,
        name: "Example",
        position: "Member",
        level: 75,
        days_in_faction: 40,
        last_action: { status: "Online", timestamp: 1794000000, relative: "just now" },
        status: { description: "Okay", details: null, state: "Okay", until: null, color: "green" },
        is_revivable: true,
        revive_setting: "Friends & faction",
        is_on_wall: false,
        is_in_oc: false,
        has_early_discharge: false,
      }, {
        id: "123457",
        name: "Unknown fields",
        last_action: { status: "Unavailable", timestamp: "not-a-time" },
        status: {},
        is_revivable: false,
        revive_setting: "Friends only",
      }],
    }
    const members = parseFactionRosterResponse(payload)
    assert.equal(members.length, 2)
    assert.equal(members[0].lastActionStatus, "Online")
    assert.equal(members[0].lastActionTimestamp, 1794000000)
    assert.equal(members[0].isRevivable, true)
    assert.equal(members[0].reviveSetting, "Friends & faction")
    assert.equal(members[1].lastActionStatus, null)
    assert.equal(members[1].lastActionTimestamp, null)
    assert.equal(members[1].isRevivable, false)
    assert.equal(members[1].reviveSetting, "Unknown", "do not invent unsupported revive enum members")
    assert.throws(() => parseFactionRosterResponse({}), /members array/)
  })

  await test("gym-energy parser rejects missing values as unknown and deduplicates contributor IDs", () => {
    const contributors = parseFactionGymEnergyResponse({
      contributors: [
        { id: 123, username: "Member A", value: 5000, in_faction: true },
        { id: "124", username: "Member B", value: "500", in_faction: false },
        { id: 123, username: "Duplicate", value: 9000, in_faction: true },
      ],
    })
    assert.deepEqual(contributors, [
      { userId: "123", username: "Member A", value: 5000, inFaction: true },
      { userId: "124", username: "Member B", value: null, inFaction: false },
    ])
    assert.throws(() => parseFactionGymEnergyResponse({}), /contributors array/)
  })

  await test("Popular public-stat parser returns 18 distinct metrics and preserves missing values", () => {
    const parsed = parseFactionPublicStatsResponse(livePersonalStatsFixtures.targetMemberPopular)
    assert.equal(countCompletePublicMetrics(parsed), 18)
    assert.equal(parsed.xantaken, 0)
    assert.equal(parsed.lsdtaken, 0)
    assert.deepEqual(parsed.missingMetrics, [])
    const partial = parseFactionPublicStatsResponse({ personalstats: { drugs: { xanax: 7 } } })
    assert.equal(partial.xantaken, 7)
    assert.equal(partial.lsdtaken, null)
    assert.ok(partial.missingMetrics.includes("lsdtaken"))
    assert.equal(countCompletePublicMetrics(partial), 1)
  })

  await test("live sanitized target-member responses confirm the public personalstats route shape", () => {
    const decoded = decodePersonalStatsResponse(livePersonalStatsFixtures.targetMemberPopular, { kind: "popular" })
    assert.equal(decoded.kind, "current")
    assert.equal(decoded.missingMetrics.length, 0)
    assert.equal(Object.values(decoded.metrics).filter((value) => value !== null).length, 18)
    assert.equal(livePersonalStatsFixtures.capture.targetMemberSampleCount, 2)
    assert.equal(livePersonalStatsFixtures.capture.targetMemberPopularMetricCount, 18)
  })

  await test("live sanitized faction roster and gym-energy fixtures confirm collection field names", () => {
    const members = livePersonalStatsFixtures.factionRoster.members
    assert.equal(livePersonalStatsFixtures.capture.factionRosterMemberCount, 100)
    assert.deepEqual(
      Object.keys(members[0]).sort(),
      ["days_in_faction", "has_early_discharge", "id", "is_in_oc", "is_on_wall", "is_revivable", "last_action", "level", "name", "position", "revive_setting", "status"].sort(),
    )
    assert.deepEqual(
      Object.keys(members[0].last_action).sort(),
      ["relative", "status", "timestamp"],
    )
    assert.deepEqual(
      Object.keys(members[0].status).sort(),
      ["color", "description", "details", "state", "until"],
    )
    const contributors = livePersonalStatsFixtures.gymEnergyContributors.contributors
    assert.equal(livePersonalStatsFixtures.capture.gymEnergyContributorCount, 100)
    assert.deepEqual(Object.keys(contributors[0]).sort(), ["id", "in_faction", "username", "value"])
  })

  await test("live sanitized category fixtures confirm required nested category paths", () => {
    const drugs = decodePersonalStatsResponse(livePersonalStatsFixtures.categoryDrugs, { kind: "category", category: "drugs" })
    assert.equal(drugs.metrics.xantaken, 0)
    assert.equal(drugs.metrics.lsdtaken, 0)
    assert.equal(drugs.metrics.cantaken, 0)
    assert.equal(drugs.missingMetrics.length, 6)

    const items = decodePersonalStatsResponse(livePersonalStatsFixtures.categoryItems, { kind: "category", category: "items" })
    assert.equal(items.metrics.alcoholused, 0)
    assert.equal(items.metrics.boostersused, 0)
    assert.equal(items.metrics.energydrinkused, 0)
    assert.equal(items.metrics.statenhancersused, 0)

    const other = decodePersonalStatsResponse(livePersonalStatsFixtures.categoryOther, { kind: "category", category: "other" })
    assert.equal(other.metrics.refills, 0)

    const networth = decodePersonalStatsResponse(livePersonalStatsFixtures.categoryNetworth, { kind: "category", category: "networth" })
    assert.equal(networth.metrics.networth, 0)
    assert.ok(livePersonalStatsFixtures.capture.ownerNetworthBreakdownKeys.includes("wallet"))
  })

  await test("live sanitized historic fixtures confirm name/value/timestamp records", () => {
    const decoded = decodePersonalStatsResponse(livePersonalStatsFixtures.historicBatch1, {
      kind: "historic",
      stats: ["xantaken", "lsdtaken"],
      timestamp: 1794000000,
    })
    assert.equal(decoded.kind, "historic")
    assert.deepEqual(decoded.stats, [
      { name: "xantaken", value: 0, timestamp: 1794000000 },
      { name: "lsdtaken", value: 0, timestamp: 1794000000 },
    ])
    assert.deepEqual(decoded.missingStats, [])
    assert.deepEqual(livePersonalStatsFixtures.capture.ownerAllTopLevelKeys.slice(0, 5), [
      "attacking", "battle_stats", "jobs", "trading", "jail",
    ])
    assert.equal(livePersonalStatsFixtures.capture.keyAccessLevel, 4)
    assert.equal(livePersonalStatsFixtures.capture.keyAccessType, "Full Access")
  })

  await test("decodes category-specific nested personalstats and proposes only required category fallbacks", () => {
    const drugs = decodePersonalStatsResponse(personalStatsFixtures.categoryDrugs, { kind: "category", category: "drugs" })
    assert.equal(drugs.kind, "current")
    assert.equal(drugs.category, "drugs")
    assert.equal(drugs.metrics.xantaken, 20)
    assert.equal(drugs.metrics.lsdtaken, 14)
    assert.equal(drugs.metrics.alcoholused, null, "fields outside the requested category remain unknown")
    assert.ok(drugs.missingMetrics.includes("alcoholused"))

    const items = decodePersonalStatsResponse(personalStatsFixtures.categoryItems, { kind: "category", category: "items" })
    assert.equal(items.metrics.alcoholused, 22)
    assert.equal(items.metrics.boostersused, 21)
    assert.equal(items.metrics.energydrinkused, 23)
    assert.equal(items.metrics.statenhancersused, 24)

    const other = decodePersonalStatsResponse(personalStatsFixtures.categoryOther, { kind: "category", category: "other" })
    assert.equal(other.metrics.refills, 25)

    const networth = decodePersonalStatsResponse(personalStatsFixtures.categoryNetworth, { kind: "category", category: "networth" })
    assert.equal(networth.metrics.networth, 260000000)

    assert.deepEqual(
      categoriesForMissingPersonalStats(["energydrinkused", "refills", "networth"]),
      ["items", "other", "networth"],
      "fallback selection should request only the categories needed by missing metrics",
    )
  })

  await test("decodes historic stat arrays, preserves per-stat timestamps, and marks omitted stats unknown", () => {
    const decoded = decodePersonalStatsResponse(personalStatsFixtures.historic, {
      kind: "historic",
      stats: ["xantaken", "lsdtaken", "overdosed"],
      timestamp: 1794000000,
    })
    assert.equal(decoded.kind, "historic")
    assert.deepEqual(decoded.stats.slice(0, 2), [
      { name: "xantaken", value: 247, timestamp: 1794000000 },
      { name: "lsdtaken", value: 390, timestamp: 1794000015 },
    ])
    assert.deepEqual(decoded.missingStats, ["overdosed"], "a stat omitted by Torn must not become zero")
    assert.equal(decoded.stats[2].name, "new_stat_not_requested", "unknown future stat names are retained rather than discarded")
  })

  await test("builds valid personalstats request paths and enforces the historical ten-stat limit", () => {
    assert.equal(buildPersonalStatsPath(12345, { kind: "popular" }), "/user/12345/personalstats?cat=popular")
    assert.equal(buildPersonalStatsPath("12345", { kind: "all" }), "/user/12345/personalstats?cat=all")
    assert.equal(buildPersonalStatsPath(12345, { kind: "category", category: "drugs" }), "/user/12345/personalstats?cat=drugs")
    assert.equal(buildPersonalStatsPath(null, { kind: "popular" }), "/user/personalstats?cat=popular")
    assert.equal(buildPersonalStatsPath(null, { kind: "all" }), "/user/personalstats?cat=all")
    const historicPath = buildPersonalStatsPath(12345, {
      kind: "historic",
      stats: ["xantaken", "lsdtaken"],
      timestamp: 1794000000,
    })
    const historicUrl = new URL(historicPath, "https://api.torn.com/v2")
    assert.equal(historicUrl.searchParams.get("stat"), "xantaken,lsdtaken")
    assert.equal(historicUrl.searchParams.get("timestamp"), "1794000000")
    assert.throws(() => buildPersonalStatsPath(0, { kind: "popular" }), /Player ID/)
    assert.throws(() => buildPersonalStatsPath(12345, {
      kind: "historic",
      stats: PERSONAL_STATS_HISTORIC_NAMES_FOR_TEST,
      timestamp: 1794000000,
    }), /between 1 and 10/)
    assert.throws(() => buildPersonalStatsPath(12345, {
      kind: "historic",
      stats: ["xantaken"],
      timestamp: 0,
    }), /Unix timestamp/)
  })

  await test("rejects invalid current and historical personalstats payloads rather than casting unknown data", () => {
    assert.throws(() => decodePersonalStatsResponse({}, { kind: "popular" }), /missing its personalstats/)
    assert.throws(() => decodePersonalStatsResponse({ personalstats: [] }, { kind: "popular" }), /must contain a personalstats object/)
    assert.throws(() => decodePersonalStatsResponse({ personalstats: { items: {} } }, { kind: "category", category: "drugs" }), /did not include the requested drugs/)
    assert.throws(() => decodePersonalStatsResponse({ personalstats: {} }, {
      kind: "historic", stats: ["xantaken"], timestamp: 1794000000,
    }), /must contain a personalstats array/)
    assert.throws(() => decodePersonalStatsResponse({ personalstats: [{ name: "xantaken", value: "7", timestamp: 1794000000 }] }, {
      kind: "historic", stats: ["xantaken"], timestamp: 1794000000,
    }), /invalid name, value or timestamp/)
  })

  await test("requests a member's personalstats with the requested selection and Authorization header", async () => {
    let requestedUrl = ""
    let authorization = ""
    const client = new TornApiClient({
      apiKey: "personalstats-test-key",
      fetcher: async (input, init) => {
        requestedUrl = String(input)
        authorization = new Headers(init?.headers).get("Authorization") ?? ""
        return new Response(JSON.stringify(personalStatsFixtures.popular))
      },
    })
    const response = await client.getUserPersonalStatsFor(12345, { kind: "popular" })
    assert.equal(requestedUrl, "https://api.torn.com/v2/user/12345/personalstats?cat=popular")
    assert.equal(authorization, "ApiKey personalstats-test-key")
    assert.equal(decodePersonalStatsResponse(response, { kind: "popular" }).metrics.xantaken, 7)
  })

  await test("requests owner personalstats without a player ID while preserving Authorization", async () => {
    let requestedUrl = ""
    let authorization = ""
    const client = new TornApiClient({
      apiKey: "owner-personalstats-test-key",
      fetcher: async (input, init) => {
        requestedUrl = String(input)
        authorization = new Headers(init?.headers).get("Authorization") ?? ""
        return new Response(JSON.stringify(personalStatsFixtures.popular))
      },
    })
    const response = await client.getMyPersonalStats({ kind: "popular" })
    assert.equal(requestedUrl, "https://api.torn.com/v2/user/personalstats?cat=popular")
    assert.equal(authorization, "ApiKey owner-personalstats-test-key")
    assert.equal(decodePersonalStatsResponse(response, { kind: "popular" }).metrics.xantaken, 7)
  })

  await test("sends the Torn key in Authorization, never in the URL", async () => {
    let requestedUrl = ""
    let authorization = ""
    const client = new TornApiClient({
      apiKey: " sample-key ",
      fetcher: async (input, init) => {
        requestedUrl = String(input)
        authorization = new Headers(init?.headers).get("Authorization") ?? ""
        return new Response(JSON.stringify({ profile: { id: 77 } }), { status: 200 })
      },
    })
    const response = await client.getCompanyProfile()
    assert.equal(requestedUrl, "https://api.torn.com/v2/company/profile")
    assert.equal(authorization, "ApiKey sample-key")
    assert.equal(response.profile.id, 77)
  })

  await test("maps Torn rate-limit code 9 to HTTP 429", async () => {
    const client = new TornApiClient({
      apiKey: "test",
      fetcher: async () => new Response(JSON.stringify({
        error: { code: 9, error: "Too many requests" },
      }), { status: 200 }),
    })
    await assert.rejects(() => client.getCompanyEmployees(), (error) =>
      error instanceof TornApiClientError &&
      error.status === 429 &&
      error.message.includes("rate limit"))
  })

  await test("sign-in verifies faction membership without probing company or director access", async () => {
    const originalFetch = globalThis.fetch
    const apiKeys = new Map()
    const players = new Map()
    const sessions = new Map()
    const tornPaths = []
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async run() {
            const lower = sql.toLowerCase()
            if (lower.includes("insert into players")) players.set(String(values[0]), { player_id: String(values[0]), player_name: values[1] })
            if (lower.includes("insert into api_keys")) apiKeys.set(String(values[0]), { last_four: values[3], updated_at: values[5], ciphertext: values[1], iv: values[2] })
            if (lower.includes("insert into sessions")) sessions.set(String(values[0]), { player_id: String(values[1]), expires_at: Number(values[2]) })
            return { success: true, meta: { changes: 1 } }
          },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from api_keys")) return apiKeys.get(String(values[0])) ?? null
            if (lower.includes("from sessions s join players p")) {
              const saved = sessions.get(String(values[0]))
              if (!saved || saved.expires_at <= Number(values[1])) return null
              return { player_id: saved.player_id, player_name: "Faction Member", is_admin: 0 }
            }
            return null
          },
          async all() { return { results: [] } },
        }
      },
    }
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname
      tornPaths.push(path)
      if (path.endsWith("/v2/user/profile")) return new Response(JSON.stringify({ profile: { id: 777, name: "Faction Member" } }))
      if (path.endsWith("/v2/user/faction")) return new Response(JSON.stringify({ faction: { id: 8317, name: "Naughty Souls" } }))
      throw new Error(`Unexpected Torn request during sign-in: ${path}`)
    }
    try {
      const response = await worker.fetch(new Request("https://worker.test/api/auth/sign-in", {
        method: "POST",
        headers: { Origin: "https://naughty-company-dashboard.pages.dev", "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "member-login-key-7777" }),
      }), { DB: db, KEY_ENCRYPTION_SECRET: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" })
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.player.id, "777")
      assert.equal(payload.player.name, "Faction Member")
      assert.equal(payload.isAdmin, false)
      assert.equal(payload.company, undefined, "company permissions are not part of the login response")
      assert.deepEqual(tornPaths, ["/v2/user/profile", "/v2/user/faction"])
      assert.equal(apiKeys.get("777").last_four, "7777")
      assert.equal(sessions.size, 1)

      const session = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: `Bearer ${payload.token}` },
      }), { DB: db, KEY_ENCRYPTION_SECRET: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" })
      assert.equal(session.status, 200)
      const sessionPayload = await session.json()
      assert.equal(sessionPayload.isAdmin, false)
      assert.equal(sessionPayload.key.saved, true)
      assert.equal(sessionPayload.company, undefined)
      assert.deepEqual(tornPaths, ["/v2/user/profile", "/v2/user/faction"], "restoring a member session makes no additional Torn requests")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("persists per-recipient sharing permissions independently on the server", async () => {
    const token = "sharing-preferences-test-token"
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    const sharing = new Map()
    const members = [
      { playerId: "888", directorName: "Peer Director", companyName: "Peer Oil Rig", companyType: "Oil Rig" },
      { playerId: "889", directorName: "Second Director", companyName: "Second Shop", companyType: "Grocery Store" },
    ]
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async run() {
            if (sql.toLowerCase().includes("insert into company_sharing_recipients")) {
              sharing.set(`${values[0]}:${values[1]}`, { shareFinancialData: Number(values[2]), shareEmployeeData: Number(values[3]), shareTrendData: Number(values[4]), updatedAt: values[5] })
            }
            return { success: true, meta: { changes: 1 } }
          },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from sessions s join players p")) {
              return values[0] === tokenHash && Number(values[1]) < Math.floor(Date.now() / 1000) + 60
                ? { player_id: "777", player_name: "Test Director" }
                : null
            }
            if (lower.includes("from players where player_id = ?")) return members.some((member) => member.playerId === String(values[0])) ? { player_id: String(values[0]) } : null
            return null
          },
          async all() {
            const lower = sql.toLowerCase()
            if (lower.includes("from players p left join company_sharing_recipients")) {
              return { results: members.map((member) => ({
                ...member,
                ...(sharing.get(`777:${member.playerId}`) || { shareFinancialData: 0, shareEmployeeData: 0, shareTrendData: 0 }),
              })) }
            }
            return { results: [] }
          },
        }
      },
    }
    const env = { DB: db }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: `Bearer ${token}` }
    const initial = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", { headers }), env)
    assert.equal(initial.status, 200)
    const initialPayload = await initial.json()
    assert.equal(initialPayload.recipients.length, 2)
    assert.deepEqual(
      [initialPayload.recipients[0].shareFinancialData, initialPayload.recipients[0].shareEmployeeData, initialPayload.recipients[0].shareTrendData],
      [false, false, false],
    )

    const saved = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ recipientId: "888", shareFinancialData: true, shareEmployeeData: false, shareTrendData: true }),
    }), env)
    assert.equal(saved.status, 200)
    assert.deepEqual((await saved.json()).recipient, { playerId: "888", shareFinancialData: true, shareEmployeeData: false, shareTrendData: true })

    const otherSaved = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ recipientId: "889", shareFinancialData: false, shareEmployeeData: true, shareTrendData: false }),
    }), env)
    assert.equal(otherSaved.status, 200)
    const restored = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", { headers }), env)
    const recipients = (await restored.json()).recipients
    assert.deepEqual(
      [recipients[0].shareFinancialData, recipients[0].shareEmployeeData, recipients[0].shareTrendData],
      [true, false, true],
    )
    assert.deepEqual(
      [recipients[1].shareFinancialData, recipients[1].shareEmployeeData, recipients[1].shareTrendData],
      [false, true, false],
    )
  })

  await test("public income comparisons remain available while private chart history follows recipient permissions", async () => {
    const token = "chart-sharing-test-token"
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    let permission = { shareFinancialData: 0, shareTrendData: 0 }
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async run() { return { success: true, meta: { changes: 1 } } },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from sessions s join players p")) {
              return values[0] === tokenHash && Number(values[1]) < Math.floor(Date.now() / 1000) + 60
                ? { player_id: "777", player_name: "Test Director" }
                : null
            }
            if (lower.includes("from faction_member_cache")) return {
              playerId: "888", directorName: "Peer Director", companyId: "96639", companyName: "Peer Oil Rig",
              companyType: "Oil Rig", companyTypeId: 28, starRating: 5, dailyIncome: 123, weeklyIncome: 861, fetchedAt: "2026-10-09T18:10:00.000Z",
            }
            if (lower.includes("from company_sharing_recipients where owner_player_id")) return permission
            return null
          },
          async all() {
            if (sql.toLowerCase().includes("from faction_director_snapshots")) return { results: [{
              day: "2026-10-09",
              profileJson: JSON.stringify({ profile: { id: 96639, name: "Peer Oil Rig", income: { daily: 123, weekly: 861 }, profit: { daily: 23 } } }),
              stockJson: JSON.stringify({ stock: [{ name: "Barrel", in_stock: 2, cost: 3 }] }),
              fetchedAt: "2026-10-09T18:10:00.000Z",
            }] }
            return { results: [] }
          },
        }
      },
    }
    const env = { DB: db }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: `Bearer ${token}` }
    const readComparison = () => worker.fetch(new Request("https://worker.test/api/faction/compare?playerId=888", { headers }), env)

    const privateResponse = await readComparison()
    assert.equal(privateResponse.status, 200)
    const privatePayload = await privateResponse.json()
    assert.equal(privatePayload.history[0].dailyIncome, 123)
    assert.equal(privatePayload.history[0].weeklyIncome, 861)
    assert.equal(privatePayload.history[0].dailyProfit, null)
    assert.equal(privatePayload.history[0].stock, null)
    assert.equal(privatePayload.history[0].stockQuantity, null)

    permission = { shareFinancialData: 1, shareTrendData: 1 }
    const sharedResponse = await readComparison()
    assert.equal(sharedResponse.status, 200)
    const sharedPayload = await sharedResponse.json()
    assert.equal(sharedPayload.history[0].dailyIncome, 123)
    assert.equal(sharedPayload.history[0].dailyProfit, 23)
    assert.equal(sharedPayload.history[0].stockQuantity, 2)
    assert.equal(sharedPayload.stockHistoryAvailable, true)
  })

  await test("Worker health endpoint applies dashboard CORS", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev" },
    }), { DB: { prepare() { return { bind() { return this }, async first() { return { ok: 1 } }, async all() { return { results: [] } }, async run() { return { success: true } } } } } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("access-control-allow-origin"), "https://naughty-company-dashboard.pages.dev")
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.service, "naughty-company-api")
    assert.equal(payload.database, "ok")
    assert.ok(payload.checkedAt)

    const portalResponse = await worker.fetch(new Request("https://worker.test/health", {
      headers: { Origin: "https://naughtyfamily.pages.dev" },
    }), { DB: { prepare() { return { bind() { return this }, async first() { return { ok: 1 } }, async all() { return { results: [] } }, async run() { return { success: true } } } } } })
    assert.equal(portalResponse.status, 200)
    assert.equal(portalResponse.headers.get("access-control-allow-origin"), "https://naughtyfamily.pages.dev")
  })

  await test("company intelligence routes are registered and require authentication", async () => {
    const paths = [
      "/api/me/health",
      "/api/me/companies/96639/history?days=30",
      "/api/me/member-insights",
      "/api/me/dashboard-layout",
    ]
    for (const path of paths) {
      const response = await worker.fetch(new Request(`https://worker.test${path}`), {})
      assert.equal(response.status, 401, `${path} should be registered and require a session`)
      assert.doesNotMatch((await response.text()), /Route not found/i, `${path} must not fall through to the generic router`)
    }
  })

  await test("authenticated health uses the daily 18:10 UTC freshness boundary and complete stale counts", async () => {
    const now = new Date()
    const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18, 10, 0, 0))
    if (now.getTime() < boundary.getTime()) boundary.setUTCDate(boundary.getUTCDate() - 1)
    const cutoff = boundary.toISOString()
    const justBeforeBoundary = new Date(boundary.getTime() - 60 * 1000).toISOString()
    const latest = now.toISOString()
    const rows = [
      { companyId: "fresh", companyName: "Fresh Co", companyType: "Grocery Store", fetchedAt: latest, snapshotCount: 5 },
      { companyId: "boundary", companyName: "Boundary Co", companyType: "Grocery Store", fetchedAt: cutoff, snapshotCount: 3 },
      { companyId: "stale", companyName: "Stale Co", companyType: "Grocery Store", fetchedAt: justBeforeBoundary, snapshotCount: 8 },
      { companyId: "never", companyName: "Never Synced Co", companyType: "Grocery Store", fetchedAt: null, snapshotCount: 0 },
    ]
    const queries = []
    const db = { prepare(sql) {
      queries.push(sql)
      const normalized = sql.toLowerCase()
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "Health Tester" }
          if (normalized.includes("as stalecompanies")) {
            assert.equal(values.length, 6, "summary must bind every owner-scoped query parameter and freshness cutoff")
            assert.ok(normalized.includes("max(s.fetched_at)"), "freshness must use saved snapshots, not the mutable current company row")
            assert.ok(normalized.includes("fetchedat < ?"), "stale totals must use the exclusive daily boundary")
            assert.equal(values[5], cutoff, "summary cutoff must be today's 18:10 UTC boundary or the previous day's if it has not occurred yet")
            return { companyCount: 105, snapshotCount: 208, latestSnapshotAt: latest, staleCompanies: 43 }
          }
          return null
        },
        async all() {
          if (normalized.includes("snapshot_stats as")) {
            assert.equal(values.length, 3)
            assert.ok(normalized.includes("where player_id = ?"))
            return { results: rows }
          }
          return { results: [] }
        },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/health", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer health-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.worker.status, "ok")
    assert.equal(payload.database.status, "ok")
    assert.equal(payload.summary.companyCount, 105)
    assert.equal(payload.summary.snapshotCount, 208)
    assert.equal(payload.summary.staleCompanies, 43, "stale count must cover all connected companies, not only the displayed rows")
    assert.equal(payload.companies.find((company) => company.companyId === "fresh").freshness, "fresh")
    assert.equal(payload.companies.find((company) => company.companyId === "boundary").freshness, "fresh", "a snapshot exactly at 18:10 UTC is fresh")
    assert.equal(payload.companies.find((company) => company.companyId === "stale").freshness, "stale", "a snapshot before 18:10 UTC is stale")
    assert.equal(payload.companies.find((company) => company.companyId === "never").freshness, "never")
    assert.ok(!payload.companies.some((company) => company.freshness === "aging"), "there must be no intermediate aging state")
    assert.ok(queries.filter((sql) => sql.toLowerCase().includes("with connected as")).every((sql) => sql.includes("player_id = ?")), "all company and snapshot queries must be owner-scoped")
    assert.doesNotMatch(JSON.stringify(payload), /ciphertext|api.?key|secret|session.?token/i)
  })

  await test("authenticated health returns a safe storage error when the database probe fails", async () => {
    const db = { prepare(sql) { const normalized = sql.toLowerCase(); return {
      bind() { return this },
      async first() {
        if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "Health Tester" }
        if (normalized.includes("as stalecompanies")) throw new Error("private database diagnostic")
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/health", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer health-session" },
    }), { DB: db })
    assert.equal(response.status, 200, "the authenticated payload must let the UI render component health states")
    const payload = await response.json()
    assert.equal(payload.worker.status, "ok")
    assert.equal(payload.database.status, "error")
    assert.equal(payload.error, "The health check could not query dashboard storage.")
    assert.doesNotMatch(JSON.stringify(payload), /private database diagnostic/)
  })

  await test("public health returns service unavailable when D1 is unreachable", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev" },
    }), { DB: { prepare() { return { async first() { throw new Error("private database diagnostic") } } } } })
    assert.equal(response.status, 503)
    const payload = await response.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.database, "error")
    assert.doesNotMatch(JSON.stringify(payload), /private database diagnostic/)
  })

  await test("Worker rejects untrusted browser origins", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health", {
      headers: { Origin: "https://untrusted.example" },
    }), {})
    assert.equal(response.status, 403)
  })

  await test("administrator access uses active player-ID roles rather than password step-up", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const appSource = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const roleMigration = readFileSync(join(root, "migrations/auth/0012_administrator_registry.sql"), "utf8")
    assert.match(workerSource, /LEFT JOIN administrators a ON a\.player_id = p\.player_id AND a\.revoked_at IS NULL/)
    assert.match(workerSource, /if \(session\.is_admin !== 1\)/)
    assert.match(workerSource, /INSERT INTO administrators \(player_id, granted_by, granted_at/)
    assert.match(workerSource, /administrator\.granted/)
    assert.match(workerSource, /administrator\.revoked/)
    assert.match(roleMigration, /CREATE TABLE IF NOT EXISTS administrators/)
    assert.match(roleMigration, /WHERE player_id = '351311'/)
    assert.doesNotMatch(workerSource, /ADMIN_USERNAME|ADMIN_PASSWORD_HASH|isAdminElevated|admin_elevated_until/)
    assert.doesNotMatch(appSource, /Unlock administration|\/api\/auth\/admin\/elevate|adminPassword|adminUsername/)
    const adminPanelSource = readFileSync(join(root, "src/components/floor/admin-panel.tsx"), "utf8")
    const adminHandlerStart = workerSource.indexOf("async function handleAdminRequest")
    const adminHandlerEnd = workerSource.indexOf("\nasync function ", adminHandlerStart + 30)
    const weeklyDiagnosticsStart = workerSource.indexOf('if (url.pathname === "/api/admin/faction/weekly-boundaries"')
    const weeklyRecoveryStart = workerSource.indexOf('if (url.pathname === "/api/admin/faction/weekly-boundaries/recover"')
    const adminGate = workerSource.indexOf("if (session.is_admin !== 1)", adminHandlerStart)
    assert.ok(adminHandlerStart >= 0 && weeklyDiagnosticsStart > adminGate && weeklyDiagnosticsStart < adminHandlerEnd,
      "weekly boundary diagnostics must remain inside the authenticated administrator handler")
    assert.ok(weeklyRecoveryStart > weeklyDiagnosticsStart && weeklyRecoveryStart < adminHandlerEnd,
      "weekly boundary recovery must remain inside the authenticated administrator handler")
    assert.match(workerSource, /week_start_at AS weekStartAt, week_end_at AS weekEndAt/)
    assert.match(workerSource, /ageMs > DAY \* 1000/, "a missing boundary can only be reconstructed during the first 24 hours")
    assert.match(workerSource, /ageMs > 8 \* DAY \* 1000/, "existing frozen runs have a bounded eight-day recovery window")
    assert.match(workerSource, /weekly report references this Sunday boundary/i)
    assert.match(workerSource, /status = 'queued', next_index = 0/)
    assert.match(workerSource, /WHERE run_id = \? AND status = \? AND updated_at = \?/, "recovery must use an optimistic status/timestamp claim")
    assert.match(workerSource, /faction\.weekly_boundary\.recovered/)
    assert.match(adminPanelSource, /weekly-boundaries/)
    assert.match(adminPanelSource, /!actionsArmed \|\| !boundary\.recoverable/,
      "recovery controls must stay disabled until admin actions are explicitly enabled")
  })

  await test("admin registry rejects non-administrator sessions and allows active role sessions", async () => {
    const makeDb = (isAdmin) => ({ prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind() { return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: isAdmin ? "351311" : "777", player_name: "Registry Tester", is_admin: isAdmin ? 1 : 0 }
          return null
        },
        async all() {
          if (normalized.includes("from administrators a join players p")) return { results: [{ playerId: "351311", playerName: "Registry Tester", grantedBy: "351311", grantedAt: "2026-11-02T00:00:00.000Z", revokedAt: null }] }
          return { results: [] }
        },
        async run() { return { success: true, meta: { changes: 1 } } },
      }
    } })
    const denied = await worker.fetch(new Request("https://worker.test/api/admin/administrators", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session" },
    }), { DB: makeDb(false) })
    assert.equal(denied.status, 403)
    assert.match((await denied.json()).error, /administrator access/i)

    const allowed = await worker.fetch(new Request("https://worker.test/api/admin/administrators", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer admin-session" },
    }), { DB: makeDb(true) })
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).administrators[0].playerId, "351311")
  })

  await test("administrators cannot grant themselves or revoke their own role", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "Owner", is_admin: 1 }; return null },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-session", "Content-Type": "application/json" }
    const grant = await worker.fetch(new Request("https://worker.test/api/admin/administrators/grant", { method: "POST", headers, body: JSON.stringify({ playerId: "351311" }) }), { DB: db })
    assert.equal(grant.status, 409)
    const revoke = await worker.fetch(new Request("https://worker.test/api/admin/administrators/revoke", { method: "POST", headers, body: JSON.stringify({ playerId: "351311" }) }), { DB: db })
    assert.equal(revoke.status, 409)
  })

  await test("admin automation insights aggregate runs for the selected time window", async () => {
    const prepared = []
    const db = { prepare(sql) {
      prepared.push(sql)
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          const normalized = sql.toLowerCase()
          if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", is_admin: 1 }
          if (normalized.includes("count(*) as totalruns")) return { totalRuns: 4, succeededRuns: 2, failedRuns: 1, partialRuns: 1, runningRuns: 0, completedRuns: 4, avgDurationSeconds: 65.2, companiesFailed: 3, alertsCreated: 5, latestRunAt: "2026-10-10T18:00:00.000Z" }
          return null
        },
        async all() {
          const normalized = sql.toLowerCase()
          if (normalized.includes("group by error_summary")) return { results: [{ errorSummary: "Torn API timeout", occurrences: 2 }] }
          if (normalized.includes("select run_id as runid")) return { results: [{ runId: "run-1", triggerName: "scheduled", status: "failed", startedAt: "2026-10-10T18:00:00.000Z", finishedAt: "2026-10-10T18:01:00.000Z", companiesChecked: 3, companiesFailed: 2, alertsCreated: 1, errorSummary: "Torn API timeout" }] }
          return { results: [] }
        },
        async run() { return { success: true, meta: { changes: 1 } } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/admin/automation/runs?days=7&limit=100", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer admin-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.range, "7")
    assert.equal(payload.insights.totalRuns, 4)
    assert.equal(payload.insights.successRate, 50)
    assert.equal(payload.insights.avgDurationSeconds, 65)
    assert.equal(payload.insights.companiesFailed, 3)
    assert.equal(payload.insights.recurringFailures[0].occurrences, 2)
    assert.equal(payload.runs[0].runId, "run-1")
    assert.ok(prepared.some((sql) => sql.includes("WHERE started_at >= ?")))
  })

  await test("admin settings reject malformed multi-setting updates before writing any setting", async () => {
    const writes = []
    const db = { prepare(sql) { let values = []; return {
      bind(...args) { values = args; return this },
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", is_admin: 1 }; return null },
      async all() { return { results: [] } },
      async run() { if (sql.toLowerCase().includes("insert into admin_settings")) writes.push(values); return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/admin/settings", {
      method: "POST",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { maintenanceMode: true, manualRefreshEnabled: "not-a-boolean" } }),
    }), { DB: db })
    assert.equal(response.status, 400)
    assert.equal(writes.length, 0)
  })

  await test("admin panel cannot disable its primary administrator account", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", is_admin: 1 }; return null },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/admin/members/351311/status", {
      method: "POST",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true, reason: "test" }),
    }), { DB: db })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /cannot be disabled/i)
  })

  await test("admin restore confirmation header is allowed by CORS preflight", async () => {
    const response = await worker.fetch(new Request("https://worker.test/api/admin/history/restore?playerId=777", {
      method: "OPTIONS",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", "Access-Control-Request-Headers": "authorization,content-type,x-admin-confirm-restore" },
    }), {})
    assert.equal(response.status, 204)
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /x-admin-confirm-restore/i)
  })

  await test("Worker requires a caller-supplied Torn key", async () => {
    const response = await worker.fetch(new Request("https://worker.test/api/company/profile", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev" },
    }), {})
    assert.equal(response.status, 401)
    assert.match((await response.json()).error, /API key is required/)
  })

  await test("Worker forwards key to Torn and returns profile data", async () => {
    const originalFetch = globalThis.fetch
    let authorization = ""
    globalThis.fetch = async (input, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? ""
      return new Response(JSON.stringify({ profile: { id: 77, name: "Sample Shop" } }), { status: 200 })
    }
    try {
      const response = await worker.fetch(new Request("https://worker.test/api/company/profile", {
        headers: {
          Origin: "https://naughty-company-dashboard.pages.dev",
          Authorization: "ApiKey test-key",
        },
      }), {})
      assert.equal(response.status, 200)
      assert.equal(authorization, "ApiKey test-key")
      assert.deepEqual(await response.json(), { profile: { id: 77, name: "Sample Shop" } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("uses sequential company ranks when weekly income is tied", () => {
    const companies = [
      { companyId: "10", companyType: "Oil Rig", companyTypeId: 28, starRating: 10, weeklyIncome: 500 },
      { companyId: "11", companyType: "Oil Rig", companyTypeId: 28, starRating: 10, weeklyIncome: 500 },
      { companyId: "12", companyType: "Oil Rig", companyTypeId: 28, starRating: 9, weeklyIncome: 400 },
    ]
    assert.equal(placement(companies[0], "type", companies), "1/3")
    assert.equal(placement(companies[1], "type", companies), "2/3")
    assert.equal(placement(companies[2], "type", companies), "3/3")
  })

  await test("exports a personal master backup without API keys or session tokens", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() { return this },
          async run() { return { success: true, meta: { changes: 1 } } },
          async first() {
            if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "777", player_name: "Backup Tester" }
            return null
          },
          async all() { return { results: [] } },
        }
      },
    }
    const response = await worker.fetch(new Request("https://worker.test/api/me/data-backup", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer test-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const backup = await response.json()
    assert.equal(backup.format, "naughty-company-dashboard-backup")
    assert.equal(backup.player.id, "777")
    assert.ok(backup.pages.company)
    assert.ok(backup.pages.employees)
    assert.ok(backup.pages.charts)
    assert.ok(backup.pages.settings)
    assert.deepEqual(backup.storage.companies, [])
    assert.deepEqual(backup.excluded, ["Torn API keys and session tokens are intentionally never exported."])
    assert.equal(JSON.stringify(backup).includes("ciphertext"), false)
  })

  await test("imports the established company history JSON format into the signed-in account", async () => {
    const saved = new Map()
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async run() {
            if (sql.toLowerCase().includes("insert into user_page_data")) saved.set(`${values[0]}:${values[1]}`, JSON.parse(values[2]))
            return { success: true, meta: { changes: 1 } }
          },
          async first() {
            if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "777", player_name: "Backup Tester" }
            return null
          },
          async all() { return { results: [] } },
        }
      },
    }
    const history = { sourceSnapshotCreatedAt: "2026-10-01T18:00:00Z", companies: [{ companyId: "96639", name: "Knotty Oil", typeName: "Oil Rig", typeId: 28, history: [{ day: "2026-10-01", period: 1790877600000, dailyIncome: 1200000, rating: 10, companyRank: 34 }] }] }
    const response = await worker.fetch(new Request("https://worker.test/api/me/data-backup", {
      method: "POST",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer test-session", "Content-Type": "application/json" },
      body: JSON.stringify({ pageKey: "charts", data: history }),
    }), { DB: db })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).imported, true)
    assert.deepEqual(saved.get("777:charts"), history)
  })

  await test("automation income-drop rules trigger only after a valid threshold crossing", () => {
    assert.deepEqual(evaluateIncomeDrop(100, 80, 15), { changePercent: -20 })
    assert.equal(evaluateIncomeDrop(100, 90, 15), null)
    assert.equal(evaluateIncomeDrop(0, 0, 15), null)
    assert.equal(evaluateIncomeDrop(null, 0, 15), null)
  })

  await test("automation thresholds and cooldowns are bounded", () => {
    assert.equal(normalizeAlertThreshold(200), 90)
    assert.equal(normalizeAlertThreshold(-3), 1)
    assert.equal(normalizeCooldownHours(0), 1)
    assert.equal(normalizeCooldownHours(999), 168)
  })

  await test("automation stale-data checks ignore invalid timestamps and respect the configured age", () => {
    const now = Date.parse("2026-10-10T18:00:00.000Z")
    assert.equal(isSnapshotStale("2026-10-09T06:00:00.000Z", now, 36), true)
    assert.equal(isSnapshotStale("2026-10-10T06:00:00.000Z", now, 36), false)
    assert.equal(isSnapshotStale("not-a-date", now, 1), false)
  })

  await test("personal automation rules are created only for the authenticated owner's connected company", async () => {
    const writes = []
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Alert Tester" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            if (query.includes("from companies where player_id = ? and company_id = ?")) return { company_id: values[1] }
            return null
          },
          async all() { return { results: [] } },
          async run() { writes.push({ sql, values }); return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const response = await worker.fetch(new Request("https://worker.test/api/me/alert-rules", {
      method: "POST", headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer test-session", "Content-Type": "application/json" },
      body: JSON.stringify({ ruleType: "income_drop", companyId: "123", thresholdPercent: 15, cooldownHours: 24 }),
    }), { DB: db })
    assert.equal(response.status, 201)
    const payload = await response.json()
    assert.ok(payload.ruleId)
    const insert = writes.find((item) => item.sql.includes("INSERT INTO alert_rules"))
    assert.ok(insert)
    assert.equal(insert.values[1], "777")
    assert.equal(insert.values[2], "123")
    assert.equal(insert.values[3], "income_drop")
    assert.equal(writes.some((item) => item.sql.toLowerCase().includes("company_sharing_recipients")), false)
  })

  await test("personal dashboard layout accepts all eight widgets for a regular signed-in member", async () => {
    const writes = []
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Member" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            return null
          },
          async all() { return { results: [] } },
          async run() { writes.push({ sql, values }); return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const widgets = ["company-health", "income-performance", "roster-overview", "recent-trends", "actionable-insights", "automation-status", "alerts", "rankings"].map((id) => ({ id, visible: true }))
    const response = await worker.fetch(new Request("https://worker.test/api/me/dashboard-layout", {
      method: "POST", headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session", "Content-Type": "application/json" },
      body: JSON.stringify({ widgets, dashboardPreferences: { density: "comfortable", contentWidth: "wide" } }),
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.layout.widgets.length, 8)
    assert.ok(payload.layout.widgets.some((item) => item.id === "actionable-insights"))
    assert.ok(writes.some((item) => item.sql.includes("INSERT INTO user_page_data") && item.values[0] === "777"))
  })

  await test("personal dashboard layout GET is scoped to the authenticated member", async () => {
    const savedLayout = { widgets: [{ id: "alerts", visible: false, order: 0 }], dashboardPreferences: { density: "compact", contentWidth: "wide" } }
    const reads = []
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Member" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            if (query.includes("from user_page_data where player_id = ? and page_key = ?")) {
              reads.push({ sql, values })
              return { dataJson: JSON.stringify(savedLayout), updatedAt: "2026-10-10T00:00:00.000Z" }
            }
            return null
          },
          async all() { return { results: [] } },
          async run() { return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const response = await worker.fetch(new Request("https://worker.test/api/me/dashboard-layout", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.layout, savedLayout)
    assert.equal(reads.length, 1)
    assert.deepEqual(reads[0].values, ["777", "dashboard-layout"])
  })

  await test("personal dashboard layout rejects unknown and duplicate widgets without persisting", async () => {
    const writes = []
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Member" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            return null
          },
          async all() { return { results: [] } },
          async run() { writes.push({ sql, values }); return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const invalidLayouts = [
      [{ id: "not-a-widget", visible: true }],
      [{ id: "alerts", visible: true }, { id: "alerts", visible: false }],
    ]
    for (const widgets of invalidLayouts) {
      const response = await worker.fetch(new Request("https://worker.test/api/me/dashboard-layout", {
        method: "POST", headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session", "Content-Type": "application/json" },
        body: JSON.stringify({ widgets }),
      }), { DB: db })
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /unknown or duplicate widget/i)
    }
    assert.equal(writes.some((item) => item.sql.includes("INSERT INTO user_page_data")), false)
  })

  await test("persists insight statuses per signed-in owner and connected company", async () => {
    const writes = []
    const saved = new Map()
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Member" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            if (query.includes("from companies where player_id = ? and company_id = ?")) { assert.deepEqual(values, ["777", "123"]); return { companyId: "123" } }
            if (query.includes("from company_api_keys where player_id = ? and company_id = ?")) return null
            if (query.includes("from user_page_data where player_id = ? and page_key = ?")) { assert.deepEqual(values, ["777", "insight-states:123"]); const row = saved.get(values[1]); return row ? { dataJson: JSON.stringify(row), updatedAt: "2026-10-10T00:00:00.000Z" } : null }
            return null
          },
          async all() { return { results: [] } },
          async run() { writes.push({ sql, values }); if (sql.includes("INSERT INTO user_page_data")) saved.set(values[1], JSON.parse(values[2])); return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session", "Content-Type": "application/json" }
    const post = await worker.fetch(new Request("https://worker.test/api/me/insight-states?companyId=123", { method: "POST", headers, body: JSON.stringify({ states: { "income-drop-2026-10-10": { status: "monitoring", updatedAt: "2026-10-10T00:00:00.000Z" } } }) }), { DB: db })
    assert.equal(post.status, 200)
    assert.equal((await post.json()).states["income-drop-2026-10-10"].status, "monitoring")
    assert.ok(writes.some((item) => item.sql.includes("INSERT INTO user_page_data") && item.values[0] === "777" && item.values[1] === "insight-states:123"))
    const get = await worker.fetch(new Request("https://worker.test/api/me/insight-states?companyId=123", { headers }), { DB: db })
    assert.equal(get.status, 200)
    assert.equal((await get.json()).states["income-drop-2026-10-10"].status, "monitoring")
  })

  await test("insight statuses reject invalid values and unowned company IDs", async () => {
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Member" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            if (query.includes("from companies where player_id = ? and company_id = ?")) return null
            if (query.includes("from company_api_keys where player_id = ? and company_id = ?")) return null
            return null
          },
          async all() { return { results: [] } },
          async run() { return { success: true, meta: { changes: 1 } } },
        }
      },
    }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session", "Content-Type": "application/json" }
    const unowned = await worker.fetch(new Request("https://worker.test/api/me/insight-states?companyId=123", { method: "POST", headers, body: JSON.stringify({ states: {} }) }), { DB: db })
    assert.equal(unowned.status, 404)
    const invalid = await worker.fetch(new Request("https://worker.test/api/me/insight-states?companyId=123", { method: "POST", headers, body: JSON.stringify({ states: { x: { status: "delete-everything" } } }) }), { DB: { prepare(sql) { return { bind() { return this }, async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "777", player_name: "Member" }; if (sql.toLowerCase().includes("from companies where player_id = ? and company_id = ?")) return { companyId: "123" }; return null }, async run() { return { success: true } } } } } })
    assert.equal(invalid.status, 400)
  })

  await test("alert acknowledgment cannot access another owner's event", async () => {
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Alert Tester" }
            if (query.includes("from admin_settings")) return null
            if (query.includes("from dashboard_member_status")) return null
            if (query.includes("select event_id from alert_events where event_id = ? and owner_player_id = ?")) { assert.equal(values[1], "777"); return null }
            return null
          },
          async all() { return { results: [] } },
          async run() { return { success: true, meta: { changes: 0 } } },
        }
      },
    }
    const response = await worker.fetch(new Request("https://worker.test/api/me/alerts/00000000-0000-4000-8000-000000000000/acknowledge", {
      method: "POST", headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer test-session" },
    }), { DB: db })
    assert.equal(response.status, 404)
  })

  await test("alert history cursor pagination is owner-scoped and preserves newest-first default behavior", async () => {
    const calls = []
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer alert-cursor-session" }
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const query = sql.toLowerCase()
            if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Cursor Tester" }
            if (query.includes("from dashboard_member_status") || query.includes("from admin_settings")) return null
            if (query.includes("select count(*) as count from alert_events")) return { count: 0 }
            return null
          },
          async all() {
            if (sql.includes("SELECT e.event_id AS eventId")) {
              calls.push({ sql, values: [...values] })
              return { results: [{
                eventId: "12345678-1234-4234-8234-123456789abc",
                createdAt: "2026-10-02T00:00:00.000Z",
                severity: "warning",
                title: "Cursor test alert",
                message: "test",
                companyName: "Test Company"
              }] }
            }
            return { results: [] }
          },
          async run() { return { success: true, meta: { changes: 1 } } }
        }
      }
    }
    const after = "2026-10-01T00:00:00.000Z"
    const afterEventId = "12345678-1234-4234-8234-123456789abc"
    const cursorResponse = await worker.fetch(new Request(
      "https://worker.test/api/me/alerts?limit=100&after=" + encodeURIComponent(after) + "&afterEventId=" + afterEventId,
      { headers }
    ), { DB: db })
    assert.equal(cursorResponse.status, 200)
    assert.equal((await cursorResponse.json()).events.length, 1)
    const cursorCall = calls[0]
    assert.match(cursorCall.sql, /e\.created_at > \? OR \(e\.created_at = \? AND e\.event_id > \?\)/)
    assert.match(cursorCall.sql, /ORDER BY e\.created_at ASC, e\.event_id ASC LIMIT \?/)
    assert.deepEqual(cursorCall.values, ["777", after, after, afterEventId, 100])

    const newestFirstResponse = await worker.fetch(new Request("https://worker.test/api/me/alerts?limit=25", { headers }), { DB: db })
    assert.equal(newestFirstResponse.status, 200)
    assert.match(calls[1].sql, /ORDER BY e\.created_at DESC LIMIT \?/)
    assert.deepEqual(calls[1].values, ["777", 25])

    const invalidCursor = await worker.fetch(new Request("https://worker.test/api/me/alerts?after=not-a-timestamp", { headers }), { DB: db })
    assert.equal(invalidCursor.status, 400)
  })

  await test("Discord alert poll health reports are authenticated, linked-account scoped, and retain bounded history", async () => {
    const token = "discord-poll-health-session"
    const tokenDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    const tokenHash = Array.from(new Uint8Array(tokenDigest), byte => byte.toString(16).padStart(2, "0")).join("")
    const discordUserId = "123456789012345678"
    const ownerId = "777"
    let currentHealth = {
      status: "error",
      consecutiveFailures: 2,
      lastSuccessAt: "2026-10-18T18:10:00.000Z"
    }
    const historyRows = []
    const writes = []
    const link = { discordUserId, alertsEnabled: 1 }
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from sessions s join players p")) return values[0] === tokenHash ? { player_id: ownerId, player_name: "Poll Tester" } : null
            if (lower.includes("from dashboard_member_status") || lower.includes("from admin_settings")) return null
            if (lower.includes("from discord_account_links where owner_player_id = ?")) return link
            if (lower.includes("from discord_alert_poll_health")) {
              if (currentHealth && values[0] === ownerId && values[1] === discordUserId) return currentHealth
              return null
            }
            return null
          },
          async all() {
            if (sql.includes("FROM discord_alert_poll_history")) return { results: historyRows.filter(row => row.ownerPlayerId === values[0] && row.discordUserId === values[1]) }
            return { results: [] }
          },
          async run() {
            writes.push({ sql, values: [...values] })
            if (sql.includes("INSERT INTO discord_alert_poll_health")) {
              const [playerId, userId, startedAt, completedAt, lastSuccessAt, status, errorCode, errorAt, consecutiveFailures, pageCount, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, exhaustedDeliveries, staleClaims, updatedAt] = values
              currentHealth = { ownerPlayerId: playerId, discordUserId: userId, pollStartedAt: startedAt, pollCompletedAt: completedAt, lastSuccessAt, status, errorCode, errorAt, consecutiveFailures, pageCount, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, exhaustedDeliveries, staleClaims, updatedAt }
            } else if (sql.includes("INSERT INTO discord_alert_poll_history")) {
              const [reportId, ownerPlayerId, discordUserIdValue, startedAt, completedAt, status, errorCode, consecutiveFailures, pageCount, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, exhaustedDeliveries, staleClaims] = values
              historyRows.unshift({ reportId, ownerPlayerId, discordUserId: discordUserIdValue, pollStartedAt: startedAt, pollCompletedAt: completedAt, status, errorCode, consecutiveFailures, pageCount, eventsSeen, delivered, filtered, failed, exhausted, staleRecovered, exhaustedDeliveries, staleClaims })
            }
            return { success: true, meta: { changes: 1 } }
          }
        }
      }
    }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer " + token, "Content-Type": "application/json" }
    const payload = {
      discordUserId, startedAt: "2026-10-19T18:00:00.000Z", completedAt: "2026-10-19T18:00:05.000Z",
      status: "error", errorCode: "dashboard_alerts_http_503", pages: 1, eventsSeen: 100,
      delivered: 0, filtered: 0, failed: 0, exhausted: 0, staleRecovered: 0, exhaustedDeliveries: 2, staleClaims: 1
    }
    const posted = await worker.fetch(new Request("https://worker.test/api/me/discord-alert-poll-health", { method: "POST", headers, body: JSON.stringify(payload) }), { DB: db })
    assert.equal(posted.status, 200)
    const postResult = await posted.json()
    assert.equal(postResult.recorded, true)
    assert.equal(postResult.consecutiveFailures, 3, "repeated poll errors should trip the stored warning threshold")
    assert.equal(currentHealth.errorCode, "dashboard_alerts_http_503")
    assert.equal(currentHealth.exhaustedDeliveries, 2)
    assert.equal(historyRows.length, 1)

    const fetched = await worker.fetch(new Request("https://worker.test/api/me/discord-alert-poll-health", { headers }), { DB: db })
    assert.equal(fetched.status, 200)
    const fetchedPayload = await fetched.json()
    assert.equal(fetchedPayload.linked, true)
    assert.equal(fetchedPayload.health.consecutiveFailures, 3)
    assert.equal(fetchedPayload.history.length, 1)
    assert.equal(fetchedPayload.history[0].status, "error")

    const writesBeforeSpoof = writes.filter(item => item.sql.includes("INSERT INTO discord_alert_poll_health")).length
    const spoofed = await worker.fetch(new Request("https://worker.test/api/me/discord-alert-poll-health", {
      method: "POST", headers, body: JSON.stringify({ ...payload, discordUserId: "223456789012345678" })
    }), { DB: db })
    assert.equal(spoofed.status, 403, "a signed-in user cannot report health for another Discord account")
    assert.equal(writes.filter(item => item.sql.includes("INSERT INTO discord_alert_poll_health")).length, writesBeforeSpoof)
  })

  await test("session revocation routes are present", () => {
    const source = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(source, /sign-out-all/)
    assert.match(source, /DELETE FROM sessions WHERE player_id = \?/)
  })

  await test("company-key deletion validates the company ID and keeps access scoped to the signed-in player", async () => {
    const db = { prepare(sql) { let values = []; return { bind(...args) { values = args; return this }, async first() { const query = sql.toLowerCase(); if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Key Tester" }; if (query.includes("from dashboard_member_status") || query.includes("from admin_settings")) return null; if (query.includes("from company_api_keys where player_id = ? and company_id = ?")) { assert.deepEqual(values, ["777", "123"]); return null } return null }, async run() { return { success: true, meta: { changes: 0 } } } } } }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer company-key-session" }
    const invalid = await worker.fetch(new Request("https://worker.test/api/auth/company-key?companyId=not-a-number", { method: "DELETE", headers }), { DB: db })
    assert.equal(invalid.status, 400)
    const missing = await worker.fetch(new Request("https://worker.test/api/auth/company-key?companyId=123", { method: "DELETE", headers }), { DB: db })
    assert.equal(missing.status, 404)
  })

  await test("company-key deletion removes only the selected credential and retains company history", async () => {
    const secret = "test-encryption-secret-that-is-long-enough"
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
    const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode("secondary-company-key"))
    const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    const encrypted = { ciphertext: toBase64(cipher), iv: toBase64(iv) }
    const writes = []
    const db = { prepare(sql) { let values = []; return { bind(...args) { values = args; return this }, async first() { const query = sql.toLowerCase(); if (query.includes("from sessions s join players p")) return { player_id: "777", player_name: "Key Tester" }; if (query.includes("from dashboard_member_status") || query.includes("from admin_settings")) return null; if (query.includes("select ciphertext, iv from company_api_keys where player_id = ? and company_id = ?")) return values[1] === "123" ? encrypted : null; if (query.includes("select company_id from company_api_keys where player_id = ? and company_id != ? limit 1")) return { company_id: "456" }; if (query.includes("select last_four, updated_at from company_api_keys where player_id = ? order by updated_at desc limit 1")) return { last_four: "9876", updated_at: "2026-10-10T00:00:00.000Z" }; return null }, async run() { writes.push({ sql, values }); return { success: true, meta: { changes: 1 } } } } } }
    const response = await worker.fetch(new Request("https://worker.test/api/auth/company-key?companyId=123", { method: "DELETE", headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer company-key-session" } }), { DB: db, KEY_ENCRYPTION_SECRET: secret })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true, companyId: "123", companyDataRetained: true, companyKeySaved: true, portalKeyStillProvidesAccess: false })
    assert.equal(writes.length, 1)
    assert.match(writes[0].sql, /DELETE FROM company_api_keys WHERE player_id = \? AND company_id = \?/)
    assert.deepEqual(writes[0].values, ["777", "123"])
    assert.equal(writes.some((write) => /DELETE FROM (companies|company_snapshots|company_financials)/i.test(write.sql)), false)
  })

  await test("company connection settings reuse the portal key and allow optional secondary company keys", () => {
    const source = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const settings = readFileSync(join(root, "src/components/portal/workspaces.tsx"), "utf8")
    assert.match(source, /Your single saved portal key is reused for company data/)
    assert.match(source, /Your portal API key could not connect a company/)
    assert.match(source, /\/api\/auth\/company-key/)
    assert.match(settings, /settings-secondary-company-key/)
    assert.match(settings, /Validate & add secondary key/)
    assert.match(settings, /removeCompanyKey/)
    assert.match(settings, /can_remove_key/)
    assert.match(settings, /uses_portal_key/)
    assert.match(readFileSync(join(root, "src/worker/index.ts"), "utf8"), /if \(isSecondary\) await validatePrivateLiveKeyOwner\(env, apiKey, session\.player_id\)/)
  })

  await test("historical company trends are owner-scoped, ordered, and summarize period changes", async () => {
    const queries = []
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      queries.push({ sql, normalized, get values() { return values } })
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "History Tester" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) {
            assert.deepEqual(values, ["777", "123"])
            return { companyId: "123", companyName: "History Co", companyType: "Oil Rig" }
          }
          return null
        },
        async all() {
          if (normalized.includes("from faction_director_snapshots")) {
            assert.deepEqual(values.slice(0, 2), ["777", "123"], "official stock history must filter by authenticated owner and selected company")
            assert.equal(values.length, 3, "official stock history must bind the selected range cutoff")
            return { results: [
              { day: "2026-10-08", stockJson: JSON.stringify({ stock: [{ name: "Oil", in_stock: 100 }] }), snapshotKind: "lock-in", fetchedAt: "2026-10-08T18:10:00.000Z" },
              { day: "2026-10-10", stockJson: JSON.stringify({ stock: [{ name: "Tealight", in_stock: 10 }, { name: "Restricted", cost: "Cannot be ordered" }] }), snapshotKind: "legacy", fetchedAt: "2026-10-10T18:10:00.000Z" },
            ] }
          }
          if (normalized.includes("from company_financial_snapshots")) {
            assert.deepEqual(values.slice(0, 2), ["777", "123"], "historical stock costs must filter by authenticated owner and selected company")
            assert.equal(values.length, 3, "a selected range must bind its cutoff")
            return { results: [
              { day: "2026-10-08", stockJson: JSON.stringify({ Oil: { cost: 10, in_stock: 100, on_order: 0 } }) },
              { day: "2026-10-10", stockJson: JSON.stringify({ Tealight: { cost: 10, in_stock: 10, on_order: 2 } }) },
            ] }
          }
          if (normalized.includes("row_number() over (partition by date(fetched_at, '-18 hours')")) {
            assert.deepEqual(values.slice(0, 2), ["777", "123"], "history queries must filter by authenticated owner and selected company")
            assert.equal(values.length, 3, "a selected range must bind its cutoff")
            return { results: [
              { snapshotId: "old", fetchedAt: "2026-10-08T18:10:00.000Z", profileJson: JSON.stringify({ company: { id: 123, income: { daily: 100, weekly: 700 }, profit: { daily: 40 }, rating: 3, advertisement_budget: 20 } }), employeesJson: JSON.stringify({ employees: [{ id: 1, wage: 10 }] }) },
              { snapshotId: "latest", fetchedAt: "2026-10-10T18:10:00.000Z", profileJson: JSON.stringify({ company: { id: 123, income: { daily: 150, weekly: 1050 }, profit: { daily: 75 }, rating: 4, advertisement_budget: 25 } }), employeesJson: JSON.stringify({ employees: [{ id: 1, wage: 100 }, { id: 2, wage: 200 }] }) },
            ] }
          }
          return { results: [] }
        },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/companies/123/history?days=30", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer history-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.company.companyName, "History Co")
    assert.equal(payload.range, "30")
    assert.deepEqual(payload.history.map((point) => point.day), ["2026-10-08", "2026-10-10"])
    assert.equal(payload.history[0].stockQuantity, 100, "complete stock rows should produce an exact daily total")
    assert.equal(payload.history[0].stockSnapshotKind, "lock-in", "history must expose the official stock snapshot kind")
    assert.equal(payload.history[0].stockSnapshotFetchedAt, "2026-10-08T18:10:00.000Z", "history must expose the saved canonical stock timestamp")
    assert.equal(payload.history[1].stockQuantity, null, "a missing/restricted item's quantity must not be silently counted as zero")
    assert.equal(payload.history[1].stockSnapshotKind, "legacy", "legacy stock rows must remain distinguishable from official lock-ins")
    assert.equal(payload.history[1].stockSnapshotFetchedAt, "2026-10-10T18:10:00.000Z", "legacy rows must retain their saved timestamp")
    assert.equal(payload.history[0].dailyProfit, 40)
    assert.equal(payload.history[0].dailyProfitSource, "reported")
    assert.equal(payload.history[0].calculatedDailyProfit, 70)
    assert.equal(payload.history[0].profitReconciliationDelta, -30, "reported profit must be compared with the complete cost-based estimate")
    assert.equal(payload.history[1].dailyIncome, 150)
    assert.equal(payload.history[1].dailyProfit, 75)
    assert.equal(payload.history[1].dailyProfitSource, "reported")
    assert.equal(payload.history[1].calculatedDailyProfit, -195)
    assert.equal(payload.history[1].profitReconciliationDelta, 270)
    assert.equal(payload.history[1].employeeCount, 2)
    assert.equal(payload.history[1].advertisingBudget, 25)
    assert.equal(payload.history[1].employeeWages, 300)
    assert.equal(payload.history[1].stockOrderExpense, 20)
    assert.equal(payload.summary.snapshotCount, 2)
    assert.equal(payload.summary.dailyIncomeChange, 50)
    assert.equal(payload.summary.dailyIncomeChangePercent, 50)
    assert.equal(payload.summary.weeklyIncomeChange, 350)
    assert.equal(payload.summary.ratingChange, 1)
    assert.equal(payload.summary.employeeCountChange, 1)
    assert.ok(queries.some((query) => query.normalized.includes("where player_id = ? and company_id = ?")))
  })

  await test("historical profit stays incomplete when any required cost input is missing", async () => {
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "History Tester" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) {
            assert.deepEqual(values, ["777", "123"])
            return { companyId: "123", companyName: "History Co", companyType: "Oil Rig" }
          }
          return null
        },
        async all() {
          if (normalized.includes("from faction_director_snapshots")) return { results: [] }
          if (normalized.includes("from company_financial_snapshots")) return { results: [] }
          if (normalized.includes("row_number() over (partition by date(fetched_at, '-18 hours')")) {
            return { results: [{
              snapshotId: "missing-costs",
              fetchedAt: "2026-10-10T18:10:00.000Z",
              profileJson: JSON.stringify({ company: { id: 123, income: { daily: 100, weekly: 700 }, profit: {}, advertisement_budget: 20, rating: 3 } }),
              employeesJson: JSON.stringify({ employees: [{ id: 1, wage: null }] })
            }] }
          }
          return { results: [] }
        },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/companies/123/history?days=30", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer history-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.history.length, 1)
    assert.equal(payload.history[0].dailyProfit, null, "missing wages and stock-order inputs must not be substituted with zero")
    assert.equal(payload.history[0].dailyProfitSource, "incomplete")
    assert.equal(payload.history[0].calculatedDailyProfit, null)
    assert.equal(payload.history[0].profitReconciliationDelta, null)
    assert.equal(payload.history[0].employeeWages, null)
    assert.equal(payload.history[0].stockOrderExpense, null)
  })

  await test("reconstructed historical wage aggregates reconcile to documented inputs", async () => {
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind() { return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "History Tester" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) return { companyId: "96639", companyName: "Knotty Oil [Hiring]", companyType: "Oil Rig" }
          return null
        },
        async all() {
          if (normalized.includes("from company_financial_snapshots")) {
            return { results: [{ day: "2026-10-01", stockJson: JSON.stringify({ reconstructed: true, stock: [{ name: "Oil (Barrel)", cost: 0, in_stock: 1042659, on_order: 0 }] }) }] }
          }
          if (normalized.includes("from faction_director_snapshots")) return { results: [] }
          if (normalized.includes("row_number() over (partition by date(fetched_at, '-18 hours')")) {
            return { results: [{
              snapshotId: 117,
              fetchedAt: "2026-10-01T19:06:57.429Z",
              profileJson: JSON.stringify({ profile: {
                id: 96639, name: "Knotty Oil [Hiring]", type: { id: 28, name: "Oil Rig" }, rating: 9,
                income: { daily: 119113440, weekly: 864327250 }, employees: { hired: 30, capacity: 30 },
                advertisement_budget: 5200000
              } }),
              employeesJson: JSON.stringify({
                reconstructed: true, employee_count: 30, reporting_day: "2026-10-01",
                wage_reconstruction: {
                  total_wages: 78744770, daily_income: 119113440, daily_profit: 35168670,
                  advertising_budget: 5200000, stock_order_expense: 0,
                  method: "daily-income-minus-daily-profit-minus-advertising-budget-minus-stock-order-expense",
                  source: "Yata.yt logs supplied by the user and uploaded dashboard backup"
                }
              })
            }] }
          }
          return { results: [] }
        },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/companies/96639/history?days=30", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer history-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.history.length, 1)
    assert.equal(payload.history[0].day, "2026-10-01")
    assert.equal(payload.history[0].employeeCount, 30)
    assert.equal(payload.history[0].advertisingBudget, 5200000)
    assert.equal(payload.history[0].employeeWages, 78744770)
    assert.equal(payload.history[0].stockOrderExpense, 0)
    assert.equal(payload.history[0].dailyProfit, 35168670)
    assert.equal(payload.history[0].dailyProfitSource, "reconstructed", "fallback profit must disclose that it was derived from saved costs")
    assert.equal(payload.history[0].calculatedDailyProfit, 35168670)
    assert.equal(payload.history[0].profitReconciliationDelta, null, "derived profit must not present its own calculation as an independent reconciliation")
    assert.equal(payload.history[0].stockSnapshotKind, null, "missing canonical stock provenance must remain unknown")
    assert.equal(payload.history[0].stockSnapshotFetchedAt, null, "a historical point without a stock row must not borrow a profile timestamp")
  })

  await test("historical company trends refuse to disclose an unowned company", async () => {
    let historyRead = false
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "History Tester" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) { assert.deepEqual(values, ["777", "999"]); return null }
          return null
        },
        async all() { if (normalized.includes("row_number() over")) historyRead = true; return { results: [] } },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/companies/999/history?days=30", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer history-session" },
    }), { DB: db })
    assert.equal(response.status, 404)
    assert.match((await response.json()).error, /not connected to your account/i)
    assert.equal(historyRead, false, "history must not be queried before company ownership is confirmed")
  })

  await test("roster insights calculate known employee averages and use only the selected owner's company", async () => {
    const queries = []
    const company = {
      companyId: "123", companyName: "Roster Co", companyType: "Oil Rig", fetchedAt: "2026-10-10T18:10:00.000Z",
      profileJson: JSON.stringify({ company: { id: 123, name: "Roster Co", type: { name: "Oil Rig" }, employees: { hired: 2, capacity: 5 } } }),
      employeesJson: JSON.stringify({ employees: [
        { id: 2, name: "Zoe", position: { name: "Sales" }, days_in_company: 15, stats: { manual_labor: 100, intelligence: 80, endurance: 60 }, wage: 1200, effectiveness: { total: 80, addiction: -2, inactivity: -3 }, status: { description: "Active" }, last_action: { relative: "1 day ago" } },
        { id: 1, name: "Amy", position: { name: "Manager" }, days_in_company: 30, stats: { manual_labor: 200, intelligence: 100, endurance: 100 }, wage: 2000, effectiveness: { total: 90, addiction: -1, inactivity: -2 }, status: { description: "Active" }, last_action: { relative: "Online" } },
      ] }),
    }
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      queries.push({ sql, normalized })
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "Roster Tester" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) { assert.deepEqual(values, ["777", "123"]); return company }
          if (normalized.includes("select count(*) as count, min(fetched_at) as firstat")) { assert.deepEqual(values, ["777", "123"]); return { count: 4, firstAt: "2026-10-01T18:10:00.000Z", latestAt: company.fetchedAt } }
          return null
        },
        async all() { return { results: [] } },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/member-insights?companyId=123", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer roster-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.company.companyName, "Roster Co")
    assert.equal(payload.company.employeeCapacity, 5)
    assert.deepEqual(payload.roster.map((employee) => employee.name), ["Amy", "Zoe"], "roster should sort by position and then employee name")
    assert.equal(payload.summary.rosterCount, 2)
    assert.equal(payload.summary.averageManualLabor, 150)
    assert.equal(payload.summary.averageIntelligence, 90)
    assert.equal(payload.summary.averageEndurance, 80)
    assert.equal(payload.summary.averageEffectiveness, 85)
    assert.equal(payload.summary.knownStatsCount, 2)
    assert.equal(payload.summary.knownWageCount, 2)
    assert.equal(payload.summary.totalKnownWages, 3200)
    assert.equal(payload.summary.snapshotCount, 4)
    assert.ok(queries.every((query) => !/FROM companies(?!.*WHERE player_id = \\?)/i.test(query.sql) || query.normalized.includes("where player_id = ?")), "roster queries must be owner-scoped")
  })

  await test("roster insights honor employee sharing and hide history unless trend sharing is enabled", async () => {
    const queries = []
    const sharedCompany = {
      playerId: "888", companyId: "123", companyName: "Shared Roster Co", companyType: "Oil Rig", fetchedAt: "2026-10-10T18:10:00.000Z", shareTrendData: 0,
      profileJson: JSON.stringify({ company: { id: 123, name: "Shared Roster Co", type: { name: "Oil Rig" }, employees: { hired: 1, capacity: 4 } } }),
      employeesJson: JSON.stringify({ employees: [{ id: 9, name: "Shared Employee", position: { name: "Manager" }, stats: { manual_labor: 90, intelligence: 80, endurance: 70 }, wage: 1500, effectiveness: { total: 88 } }] }),
    }
    let historyRead = false
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      queries.push({ normalized, get values() { return values } })
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "Shared Recipient" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) return null
          if (normalized.includes("join company_sharing_recipients") && normalized.includes("share_employee_data = 1")) { assert.deepEqual(values, ["777", "123"]); return sharedCompany }
          if (normalized.includes("select count(*) as count, min(fetched_at) as firstat")) { historyRead = true; return { count: 9, firstAt: "2026-01-01T00:00:00.000Z", latestAt: sharedCompany.fetchedAt } }
          return null
        },
        async all() { return { results: [] } },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/member-insights?companyId=123", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer roster-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.company.companyName, "Shared Roster Co")
    assert.deepEqual(payload.roster.map((employee) => employee.name), ["Shared Employee"])
    assert.equal(payload.summary.rosterCount, 1)
    assert.equal(payload.summary.snapshotCount, 0, "employee permission alone must not reveal historical snapshot coverage")
    assert.equal(payload.summary.firstSnapshotAt, null)
    assert.equal(payload.summary.latestSnapshotAt, null)
    assert.equal(historyRead, false, "historical snapshot metadata must not be queried without trend sharing")
    assert.ok(queries.some((query) => query.normalized.includes("join company_sharing_recipients") && query.normalized.includes("share_employee_data = 1")))
  })

  await test("roster insights resolve an explicitly selected shared owner when company IDs overlap", async () => {
    const queries = []
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      queries.push({ normalized, get values() { return values } })
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "Recipient" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) throw new Error("explicit shared selection must not fall back to the recipient's own company")
          if (normalized.includes("join company_sharing_recipients") && normalized.includes("s.owner_player_id = ?") && normalized.includes("share_employee_data = 1")) {
            assert.deepEqual(values, ["777", "888", "123"])
            return { playerId: "888", companyId: "123", companyName: "Selected Shared Co", companyType: "Oil Rig", fetchedAt: "2026-10-10T18:10:00.000Z", shareTrendData: 0,
              profileJson: JSON.stringify({ company: { id: 123, name: "Selected Shared Co", type: { name: "Oil Rig" }, employees: { hired: 1, capacity: 3 } } }),
              employeesJson: JSON.stringify({ employees: [{ id: 1, name: "Correct Owner Employee", position: { name: "Manager" }, stats: { manual_labor: 50, intelligence: 60, endurance: 70 }, wage: 1000 }] }) }
          }
          return null
        },
        async all() { return { results: [] } },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/member-insights?companyId=123&ownerPlayerId=888", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer roster-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.company.companyName, "Selected Shared Co")
    assert.deepEqual(payload.roster.map((employee) => employee.name), ["Correct Owner Employee"])
    assert.ok(queries.some((query) => query.normalized.includes("s.owner_player_id = ?") && query.normalized.includes("s.recipient_player_id = ?")))
  })

  await test("roster insights do not disclose a shared company's employees without employee-data permission", async () => {
    let rosterRead = false
    const db = { prepare(sql) {
      const normalized = sql.toLowerCase()
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          if (normalized.includes("from sessions s join players p")) return { player_id: "777", player_name: "Shared Recipient" }
          if (normalized.includes("from companies where player_id = ? and company_id = ? limit 1")) return null
          if (normalized.includes("join company_sharing_recipients")) { rosterRead = true; assert.deepEqual(values, ["777", "123"]); return null }
          if (normalized.includes("select count(*) as count, min(fetched_at) as firstat")) throw new Error("must not read snapshot metadata for an unshared roster")
          return null
        },
        async all() { return { results: [] } },
        async run() { return { success: true } },
      }
    } }
    const response = await worker.fetch(new Request("https://worker.test/api/me/member-insights?companyId=123", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer roster-session" },
    }), { DB: db })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.company, null)
    assert.deepEqual(payload.roster, [])
    assert.equal(payload.summary, null)
    assert.match(payload.message, /not been shared/i)
    assert.equal(rosterRead, true, "the Worker should verify sharing permissions before returning any roster details")
  })

  await test("Executive Overview and layout customization are not listed as administrator-only views", () => {
    const floorSource = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const workspaceSource = readFileSync(join(root, "src/components/floor/insights-workspace.tsx"), "utf8")
    assert.match(floorSource, /const adminOnlyViews = \["admin", "dashboard-members", "member-insights"\]/)
    assert.doesNotMatch(floorSource, /const adminOnlyViews = \[[^\]]*(?:executive|layout)/)
    assert.match(floorSource, /activeView === "executive" && !demoMode/)
    assert.match(floorSource, /activeView === "layout" \?/)
    assert.match(workspaceSource, /setLayoutLoadError\(caught instanceof Error \? caught\.message/)
    assert.match(workspaceSource, /if \(!layoutLoaded \|\| layoutLoadError\)/)
    assert.match(workspaceSource, /disabled=\{savingLayout \|\| !layoutLoaded \|\| !!layoutLoadError\}/)
    assert.match(workspaceSource, /Retry loading layout/)
    assert.match(workspaceSource, /Dashboard-wide appearance/)
    assert.match(workspaceSource, /Executive Overview widgets/)
    assert.match(workspaceSource, /onNavigate\("roster-insights"\)/)
    assert.match(workspaceSource, /Roster data source/)
    assert.match(floorSource, /sharedRosterCompanies=\{sharedCompanies\.filter\(\(company\) => company\.shareEmployeeData\)\}/)
    assert.match(workspaceSource, /ownerPlayerId/)
  })

  await test("Discord poll monitoring runtime DDL contains complete CREATE TABLE statements", () => {
    const source = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const statements = [...source.matchAll(/await db\.prepare\(`(CREATE TABLE IF NOT EXISTS discord_alert_poll_(?:health|history) \([\s\S]*?)`\)\.run\(\)/g)]
    assert.equal(statements.length, 2, "both monitoring tables must be created idempotently at runtime")
    for (const [, sql] of statements) {
      assert.match(sql.trim(), /\)\s*$/, "each runtime table definition must close its SQL column list")
    }
  })

  await test("automation schema bootstrap is cached per D1 binding and failed initialization can retry", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /const automationSchemaInitializations = new WeakMap<D1Database, Promise<void>>\(\)/)
    assert.match(workerSource, /const existing = automationSchemaInitializations\.get\(db\)/)
    assert.match(workerSource, /if \(existing\) return existing/)
    assert.match(workerSource, /automationSchemaInitializations\.delete\(db\)/)
  })


  await test("Discord poll hot paths skip runtime DDL and use migration-managed link tables", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const migration = readFileSync(join(root, "migrations/auth/0011_discord_account_linking.sql"), "utf8")
    assert.match(workerSource, /const skipAutomationSchemaBootstrap =[\s\S]*\(discordLinkPath && request\.method === "GET"\)[\s\S]*\(preferencesPath && request\.method === "GET"\)[\s\S]*discordPollHealthPath/)
    assert.match(workerSource, /if \(!skipAutomationSchemaBootstrap\) await ensureAutomationSchema\(env\)/)
    assert.match(migration, /CREATE TABLE IF NOT EXISTS discord_account_links/)
    assert.match(migration, /CREATE TABLE IF NOT EXISTS discord_link_codes/)
  })

  async function makeEncryptedTestKey(secret, apiKey) {
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(apiKey))
    return { ciphertext: Buffer.from(ciphertext).toString("base64"), iv: Buffer.from(iv).toString("base64") }
  }

  async function makeMembershipFixture({ members, failDeleteOnce = null } = {}) {
    const secret = "membership-e2e-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
    const players = new Map()
    const sessions = new Map()
    const apiKeys = new Map()
    const administrators = new Map()
    const disabled = new Map()
    const halloweenTables = {
      halloween_historical_keys: new Map(),
      halloween_event_logs: new Map(),
      halloween_live_snapshots: new Map(),
      halloween_collection_jobs: new Map(),
      halloween_live_snapshot_jobs: new Map(),
      halloween_member_event_slots: new Map(),
      halloween_api_throttles: new Map(),
    }
    const factionCache = new Map()
    const sharing = new Map()
    const audit = []
    let failDelete = failDeleteOnce
    const tokenByPlayer = new Map()
    for (const member of members) {
      const playerId = String(member.playerId)
      players.set(playerId, {
        player_id: playerId,
        player_name: member.playerName || "Test Member " + playerId,
        faction_id: member.factionId ?? "8317",
        faction_verified_at: member.verifiedAt ?? new Date(Date.now() - 8 * 60 * 1000).toISOString(),
        membership_check_attempted_at: member.attemptedAt ?? null,
        membership_check_status: member.checkStatus ?? null,
        created_at: new Date(Date.now() - 86400000).toISOString(),
      })
      if (member.apiKey) apiKeys.set(playerId, await makeEncryptedTestKey(secret, member.apiKey))
      if (member.isAdmin) administrators.set(playerId, {
        player_id: playerId,
        granted_by: "900",
        granted_at: new Date().toISOString(),
        revoked_by: null,
        revoked_at: null,
      })
      const token = member.token || "e2e-session-" + playerId
      tokenByPlayer.set(playerId, token)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
      const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
      sessions.set(tokenHash, { token_hash: tokenHash, player_id: playerId, expires_at: Math.floor(Date.now() / 1000) + 3600 })
      for (const table of Object.values(halloweenTables)) table.set(playerId, { player_id: playerId, marker: "retained-until-cleanup" })
      factionCache.set(playerId, { player_id: playerId, is_director: 1 })
      sharing.set(playerId + ":777", { owner_player_id: playerId, recipient_player_id: "777" })
      sharing.set("777:" + playerId, { owner_player_id: "777", recipient_player_id: playerId })
    }

    const db = {
      prepare(sql) {
        const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim()
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            if (normalized.includes("from sessions s join players p")) {
              const savedSession = sessions.get(String(values[0]))
              if (!savedSession || savedSession.expires_at <= Number(values[1])) return null
              const player = players.get(savedSession.player_id)
              if (!player) return null
              const role = administrators.get(savedSession.player_id)
              return {
                ...player,
                is_admin: role && role.revoked_at == null ? 1 : 0,
              }
            }
            if (normalized.startsWith("select disabled_at from dashboard_member_status")) {
              return { disabled_at: disabled.get(String(values[0])) ?? null }
            }
            if (normalized.startsWith("select ciphertext, iv from api_keys")) return apiKeys.get(String(values[0])) ?? null
            if (normalized.startsWith("select ciphertext, iv from halloween_historical_keys")) {
              const row = halloweenTables.halloween_historical_keys.get(String(values[0]))
              return row?.ciphertext && row?.iv ? row : null
            }
            if (normalized.startsWith("select last_request_at from halloween_api_throttles")) {
              return halloweenTables.halloween_api_throttles.get(String(values[0])) ?? null
            }
            if (normalized.startsWith("select job_id, player_id, event_year, status, cursor_ts, cursor_url, cursor_direction, pages_collected, logs_collected, window_start_at, window_end_at from halloween_collection_jobs where job_id = ?")) {
              return [...halloweenTables.halloween_collection_jobs.values()].find(row => row.job_id === String(values[0])) ?? null
            }
            if (normalized.startsWith("select start_at, end_at, historical_collection_enabled from halloween_event_windows")) {
              return { start_at: "2026-10-25T10:00:00.000Z", end_at: "2026-11-01T10:00:00.000Z", historical_collection_enabled: 1 }
            }
            if (normalized.startsWith("select value_json from admin_settings")) return null
            if (normalized.includes("from administrators a join players p")) {
              const role = administrators.get(String(values[0]))
              const player = players.get(String(values[0]))
              return role && player ? { player_name: player.player_name, revoked_at: role.revoked_at } : null
            }
            return null
          },
          async all() {
            if (normalized.startsWith("pragma table_info(admin_jobs)")) return { results: [{ name: "job_payload_json" }] }
            return { results: [] }
          },
          async run() {
            if (failDelete && normalized.startsWith("delete from " + failDelete)) {
              failDelete = null
              throw new Error("Injected D1 cleanup failure for test coverage.")
            }
            if (normalized.startsWith("update players set membership_check_attempted_at = ?, membership_check_status = 'checking'")) {
              const [attemptedAt, playerId, claimBefore] = values
              const player = players.get(String(playerId))
              if (!player) return { success: true, meta: { changes: 0 } }
              const canClaim = player.membership_check_status === "cleanup_pending" ||
                player.membership_check_attempted_at == null ||
                player.membership_check_attempted_at < String(claimBefore)
              if (!canClaim) return { success: true, meta: { changes: 0 } }
              player.membership_check_attempted_at = String(attemptedAt)
              player.membership_check_status = "checking"
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("update players set membership_check_status = 'unavailable'")) {
              const [playerId, attemptedAt] = values
              const player = players.get(String(playerId))
              if (!player || (values.length > 1 && player.membership_check_attempted_at !== attemptedAt)) return { success: true, meta: { changes: 0 } }
              player.membership_check_status = "unavailable"
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("update players set membership_check_status = 'cleanup_pending'")) {
              const player = players.get(String(values[0]))
              if (!player) return { success: true, meta: { changes: 0 } }
              player.membership_check_status = "cleanup_pending"
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("update players set faction_id = ?, faction_verified_at = ?, membership_check_attempted_at = ?, membership_check_status = null")) {
              const [factionId, verifiedAt, attemptedAt, updatedAt, playerId] = values
              const player = players.get(String(playerId))
              if (!player) return { success: true, meta: { changes: 0 } }
              Object.assign(player, {
                faction_id: factionId,
                faction_verified_at: verifiedAt,
                membership_check_attempted_at: attemptedAt,
                membership_check_status: null,
                updated_at: updatedAt,
              })
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("update administrators set revoked_by = 'system'")) {
              const [revokedAt, playerId] = values
              const role = administrators.get(String(playerId))
              if (!role || role.revoked_at != null) return { success: true, meta: { changes: 0 } }
              role.revoked_by = "system"
              role.revoked_at = revokedAt
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("update administrators set revoked_by = ?")) {
              const [revokedBy, revokedAt, playerId] = values
              const activeCount = [...administrators.values()].filter(role => role.revoked_at == null).length
              const role = administrators.get(String(playerId))
              if (!role || role.revoked_at != null || activeCount <= 1) return { success: true, meta: { changes: 0 } }
              role.revoked_by = String(revokedBy)
              role.revoked_at = String(revokedAt)
              return { success: true, meta: { changes: 1 } }
            }
            if (normalized.startsWith("delete from sessions where player_id = ?")) {
              const playerId = String(values[0])
              let changes = 0
              for (const [hash, session] of sessions) if (session.player_id === playerId) { sessions.delete(hash); changes++ }
              return { success: true, meta: { changes } }
            }
            if (normalized.startsWith("delete from sessions where token_hash = ?")) {
              return { success: true, meta: { changes: sessions.delete(String(values[0])) ? 1 : 0 } }
            }
            if (normalized.startsWith("delete from api_keys where player_id = ?")) {
              return { success: true, meta: { changes: apiKeys.delete(String(values[0])) ? 1 : 0 } }
            }
            if (normalized.startsWith("delete from faction_member_cache where player_id = ?")) {
              return { success: true, meta: { changes: factionCache.delete(String(values[0])) ? 1 : 0 } }
            }
            if (normalized.startsWith("delete from company_sharing_recipients")) {
              const [ownerId, recipientId] = values.map(String)
              let changes = 0
              for (const [key, row] of sharing) if (row.owner_player_id === ownerId || row.recipient_player_id === recipientId) { sharing.delete(key); changes++ }
              return { success: true, meta: { changes } }
            }
            if (normalized.startsWith("delete from halloween_")) {
              const tableName = normalized.match(/^delete from (halloween_[a-z_]+)/)?.[1]
              const table = tableName ? halloweenTables[tableName] : null
              const playerId = String(values[0])
              return { success: true, meta: { changes: table?.delete(playerId) ? 1 : 0 } }
            }
            if (normalized.startsWith("insert into admin_audit_log")) {
              audit.push({
                actor_player_id: values[0],
                actor_player_name: values[1],
                action: values[2],
                target_type: values[3],
                target_id: values[4],
                outcome: values[5],
                summary: values[6],
              })
              return { success: true, meta: { changes: 1 } }
            }
            return { success: true, meta: { changes: 1 } }
          },
        }
      },
    }
    return {
      env: { DB: db, KEY_ENCRYPTION_SECRET: secret, ALLOWED_ORIGIN: "https://naughty-company-dashboard.pages.dev" },
      players, sessions, apiKeys, administrators, disabled, halloweenTables, factionCache, sharing, audit, tokenByPlayer,
    }
  }

  await test("confirmed faction departure invalidates sessions, credentials, Halloween data, director cache, sharing, and administrator role end-to-end", async () => {
    const originalFetch = globalThis.fetch
    const fixture = await makeMembershipFixture({
      members: [{ playerId: "222", playerName: "Departed Member", apiKey: "departed-login-key", isAdmin: true }],
    })
    const secondDeviceToken = "e2e-second-device-222"
    const secondDeviceDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secondDeviceToken))
    const secondDeviceHash = Array.from(new Uint8Array(secondDeviceDigest), byte => byte.toString(16).padStart(2, "0")).join("")
    fixture.sessions.set(secondDeviceHash, {
      token_hash: secondDeviceHash,
      player_id: "222",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
    assert.equal(fixture.sessions.size, 2, "the departure test begins with two active device sessions")
    let factionChecks = 0
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path === "/v2/user/faction") {
        factionChecks++
        return new Response(JSON.stringify({ faction: { id: 9999, name: "Different Faction" } }))
      }
      if (path === "/v2/user/profile") return new Response(JSON.stringify({ profile: { id: 222, name: "Departed Member" } }))
      throw new Error("Unexpected Torn request in departure E2E test: " + path)
    }
    try {
      const token = fixture.tokenByPlayer.get("222")
      const response = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + token },
      }), fixture.env, { waitUntil() {} })
      assert.equal(response.status, 401, "a confirmed departure must invalidate the authenticated request")
      assert.equal(factionChecks, 1, "the stale member's faction must be checked against Torn")
      assert.equal(fixture.sessions.size, 0, "all active sessions for the departed member must be deleted")
      assert.equal(fixture.apiKeys.has("222"), false, "the saved faction login credential must be deleted")
      assert.equal(fixture.factionCache.has("222"), false, "cached director/member data must be deleted")
      assert.equal([...fixture.sharing.values()].some(row => row.owner_player_id === "222" || row.recipient_player_id === "222"), false, "sharing relationships must be deleted in both directions")
      for (const [name, table] of Object.entries(fixture.halloweenTables)) assert.equal(table.has("222"), false, name + " must be purged on departure")
      const role = fixture.administrators.get("222")
      assert.ok(role?.revoked_at, "the durable administrator role must be revoked")
      assert.equal(role.revoked_by, "system", "departure-driven revocation must be attributed to the system")
      assert.equal(fixture.players.get("222").faction_id, "9999", "the new faction ID is stored only after cleanup completes")
      const repeated = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + token },
      }), fixture.env, { waitUntil() {} })
      assert.equal(repeated.status, 401, "a deleted session must remain invalid")
      assert.equal(factionChecks, 1, "a deleted session must not trigger another Torn request")
      const signIn = await worker.fetch(new Request("https://worker.test/api/auth/sign-in", {
        method: "POST",
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "departed-login-key" }),
      }), fixture.env, { waitUntil() {} })
      assert.equal(signIn.status, 403, "a departed member must not be able to sign in again")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("cleanup-pending departure stays fail-closed through a Torn outage and retries cleanup", async () => {
    const originalFetch = globalThis.fetch
    const fixture = await makeMembershipFixture({
      members: [{ playerId: "223", playerName: "Cleanup Pending Member", apiKey: "cleanup-login-key", isAdmin: true }],
      failDeleteOnce: "halloween_event_logs",
    })
    let mode = "departed"
    let factionChecks = 0
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path !== "/v2/user/faction") throw new Error("Unexpected Torn request in cleanup retry E2E test: " + path)
      factionChecks++
      if (mode === "outage") return new Response(JSON.stringify({ error: { code: 9 } }), { status: 429 })
      return new Response(JSON.stringify({ faction: { id: 9999, name: "Different Faction" } }))
    }
    try {
      const token = fixture.tokenByPlayer.get("223")
      const request = () => worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + token },
      }), fixture.env, { waitUntil() {} })
      const first = await request()
      assert.equal(first.status, 401, "the first departure attempt must fail closed when cleanup throws")
      assert.equal(fixture.players.get("223").membership_check_status, "cleanup_pending")
      assert.ok(fixture.sessions.size === 1, "injected failure happens before session deletion")
      assert.equal(fixture.apiKeys.has("223"), true, "the login key is retained until retry can finish cleanup")
      assert.equal(fixture.administrators.get("223").revoked_by, "system", "admin revocation happens before fallible archive cleanup")

      mode = "outage"
      const duringOutage = await request()
      assert.equal(duringOutage.status, 401, "a later Torn outage must not turn a confirmed departure into an outage-grace session")
      assert.equal(fixture.players.get("223").membership_check_status, "cleanup_pending", "cleanup-pending state must survive retry outages")
      assert.equal(fixture.sessions.size, 1, "failed cleanup keeps the session record inaccessible until cleanup can finish")
      assert.equal(factionChecks, 2)

      mode = "departed"
      const retry = await request()
      assert.equal(retry.status, 401, "a successful cleanup retry must leave the old session invalid")
      assert.equal(fixture.players.get("223").faction_id, "9999")
      assert.equal(fixture.players.get("223").membership_check_status, null)
      assert.equal(fixture.sessions.size, 0)
      assert.equal(fixture.apiKeys.has("223"), false)
      for (const table of Object.values(fixture.halloweenTables)) assert.equal(table.has("223"), false)
      assert.equal(factionChecks, 3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("genuine Torn outage uses only bounded last-success grace and does not purge member access", async () => {
    const originalFetch = globalThis.fetch
    const fixture = await makeMembershipFixture({
      members: [{ playerId: "224", playerName: "Torn Outage Member", apiKey: "outage-login-key", isAdmin: true }],
    })
    let factionChecks = 0
    globalThis.fetch = async input => {
      factionChecks++
      return new Response(JSON.stringify({ error: { code: 9 } }), { status: 429 })
    }
    try {
      const token = fixture.tokenByPlayer.get("224")
      const request = () => worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + token },
      }), fixture.env, { waitUntil() {} })
      const first = await request()
      assert.equal(first.status, 200, "a recent successful membership verification may use the 15-minute outage grace")
      assert.equal(fixture.players.get("224").membership_check_status, "unavailable")
      const second = await request()
      assert.equal(second.status, 200, "a recent unavailable check may use the same bounded grace without another Torn request")
      assert.equal(factionChecks, 1, "the five-minute backoff must suppress duplicate outage requests")
      assert.equal(fixture.sessions.size, 1)
      assert.equal(fixture.apiKeys.has("224"), true)
      assert.equal(fixture.administrators.get("224").revoked_at, null)
      assert.ok(fixture.halloweenTables.halloween_historical_keys.has("224"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("Torn outage beyond the 15-minute last-success window fails closed without treating the member as departed", async () => {
    const originalFetch = globalThis.fetch
    const fixture = await makeMembershipFixture({
      members: [{
        playerId: "225",
        playerName: "Stale Verification Member",
        apiKey: "stale-login-key",
        isAdmin: true,
        verifiedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      }],
    })
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 9 } }), { status: 429 })
    try {
      const response = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + fixture.tokenByPlayer.get("225") },
      }), fixture.env, { waitUntil() {} })
      assert.equal(response.status, 401, "outage grace must not extend beyond 15 minutes from the last successful verification")
      assert.equal(fixture.players.get("225").membership_check_status, "unavailable")
      assert.equal(fixture.players.get("225").faction_id, "8317", "a Torn outage must not be interpreted as faction departure")
      assert.equal(fixture.sessions.size, 1)
      assert.equal(fixture.apiKeys.has("225"), true)
      assert.equal(fixture.administrators.get("225").revoked_at, null)
      assert.ok(fixture.halloweenTables.halloween_historical_keys.has("225"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("historical collector discovery of faction departure uses the same full access invalidation path", async () => {
    const originalFetch = globalThis.fetch
    const fixture = await makeMembershipFixture({
      members: [{ playerId: "226", playerName: "Collector-Detected Departure", apiKey: "full-access-key", isAdmin: true }],
    })
    const encrypted = fixture.apiKeys.get("226")
    fixture.halloweenTables.halloween_historical_keys.set("226", {
      player_id: "226",
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
    })
    fixture.halloweenTables.halloween_collection_jobs.set("226", {
      job_id: "collector-job-226",
      player_id: "226",
      event_year: 2026,
      status: "running",
      cursor_ts: Math.floor(Date.parse("2026-10-25T10:00:00.000Z") / 1000),
      cursor_url: null,
      cursor_direction: null,
      pages_collected: 0,
      logs_collected: 0,
      window_start_at: "2026-10-25T10:00:00.000Z",
      window_end_at: "2026-11-01T10:00:00.000Z",
    })
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path !== "/v2/user/faction") throw new Error("Unexpected Torn request in collector departure test: " + path)
      return new Response(JSON.stringify({ faction: { id: 9999, name: "Different Faction" } }))
    }
    try {
      let acknowledged = false
      let retried = false
      await worker.queue({
        messages: [{
          body: { kind: "halloween-log-collection", jobId: "collector-job-226" },
          attempts: 1,
          ack() { acknowledged = true },
          retry() { retried = true },
        }],
      }, fixture.env)
      assert.equal(acknowledged, true, "the departure cleanup should complete and the queue message should ack")
      assert.equal(retried, false)
      assert.equal(fixture.players.get("226").faction_id, "9999")
      assert.equal(fixture.players.get("226").membership_check_status, null)
      assert.equal(fixture.sessions.size, 0)
      assert.equal(fixture.apiKeys.has("226"), false)
      assert.equal(fixture.factionCache.has("226"), false)
      assert.equal([...fixture.sharing.values()].some(row => row.owner_player_id === "226" || row.recipient_player_id === "226"), false)
      assert.equal(fixture.administrators.get("226").revoked_by, "system")
      for (const table of Object.values(fixture.halloweenTables)) assert.equal(table.has("226"), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("administrator revocation removes privileges from an existing session and records the actor", async () => {
    const originalFetch = globalThis.fetch
    const fixture = await makeMembershipFixture({
      members: [
        { playerId: "900", playerName: "Acting Admin", token: "acting-admin-token", isAdmin: true, verifiedAt: new Date().toISOString() },
        { playerId: "901", playerName: "Revoked Admin", token: "revoked-admin-token", isAdmin: true, verifiedAt: new Date().toISOString() },
      ],
    })
    globalThis.fetch = async () => { throw new Error("Fresh administrator sessions must not call Torn.") }
    try {
      const actorToken = fixture.tokenByPlayer.get("900")
      const targetToken = fixture.tokenByPlayer.get("901")
      const revoke = await worker.fetch(new Request("https://worker.test/api/admin/administrators/revoke", {
        method: "POST",
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + actorToken, "Content-Type": "application/json" },
        body: JSON.stringify({ playerId: "901" }),
      }), fixture.env, { waitUntil() {} })
      assert.equal(revoke.status, 200)
      assert.equal(fixture.administrators.get("901").revoked_by, "900")
      assert.ok(fixture.administrators.get("901").revoked_at)
      assert.ok(fixture.audit.some(item => item.action === "administrator.revoked" && item.target_id === "901" && item.actor_player_id === "900"))

      const targetSession = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + targetToken },
      }), fixture.env, { waitUntil() {} })
      assert.equal(targetSession.status, 200, "revocation removes administrator privileges but does not sign the user out")
      assert.equal((await targetSession.json()).isAdmin, false, "an existing session must immediately reflect the revoked role")

      const denied = await worker.fetch(new Request("https://worker.test/api/admin/administrators", {
        headers: { Origin: fixture.env.ALLOWED_ORIGIN, Authorization: "Bearer " + targetToken },
      }), fixture.env, { waitUntil() {} })
      assert.equal(denied.status, 403, "the existing session must immediately lose access to administrator routes")
      assert.ok(fixture.audit.some(item => item.action === "authorization.denied" && item.actor_player_id === "901"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  console.log(`\n${passed} backend checks passed.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
