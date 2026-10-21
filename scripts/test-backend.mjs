import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"
import { validateAdminPassword } from "../src/lib/admin-password-policy.js"

const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), "naughty-company-tests-"))
writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "commonjs" }))
const sourceFiles = [
  "src/lib/admin-password-policy.js",
  "src/lib/automation/rules.ts",
  "src/lib/automation/discord-poll-monitoring.ts",
  "src/lib/company/engine.ts",
  "src/lib/company/types.ts",
  "src/lib/torn/client.ts",
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
  const worker = require(join(temp, "worker/index.js")).default
  const { officialSnapshotSourceTime } = require(join(temp, "worker/snapshot-provenance.js"))
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

  await test("administrator password hash generator passes Node syntax validation without running", () => {
    execFileSync(process.execPath, ["--check", join(root, "scripts/generate-admin-password-hash.mjs")], { stdio: "pipe" })
  })

  await test("administrator password policy requires 8 characters, all character classes, and rejects alphabetic/numeric sequences", () => {
    for (const password of ["Tr7!xP9@", "Ax12!Qz9", "Mix8#Tree2"]) {
      assert.deepEqual(validateAdminPassword(password), { valid: true }, `${password} should meet the policy`)
    }
    for (const [password, reason] of [
      ["Ab1!", /at least 8 characters/i],
      ["123456!@", /at least one letter/i],
      ["Abcdef12", /special character/i],
      ["Abc!7xQ9", /consecutive letters or digits/i],
      ["Cba!7xQ9", /consecutive letters or digits/i],
      ["Ax123!Qz", /consecutive letters or digits/i],
      ["Ax321!Qz", /consecutive letters or digits/i],
    ]) {
      const result = validateAdminPassword(password)
      assert.equal(result.valid, false, `${password} should be rejected`)
      if (!result.valid) assert.match(result.reason, reason)
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

  await test("company stock refreshes preserve current values and append historical stock snapshots", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0002_company_financial_history.sql"), "utf8")
    assert.equal((workerSource.match(/INSERT INTO company_financial_snapshots \(player_id, company_id, stock_json, fetched_at\)/g) ?? []).length, 2)
    assert.match(workerSource, /ON CONFLICT\(player_id, company_id\) DO UPDATE SET stock_json = excluded\.stock_json, fetched_at = excluded\.fetched_at/)
    assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS company_financial_snapshots/)
    assert.match(migrationSource, /company_financial_snapshots_owner_idx/)
    assert.doesNotMatch(migrationSource, /DROP TABLE|DELETE FROM company_financials/i)
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
    assert.match(wranglerSource, /crons = \["10 18 \* \* \*", "10 0 \* \* \*"\]/)
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

  await test("admin endpoint refresh is admin-gated, selective, audited, and live-only", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    const uiSource = readFileSync(join(root, "src/components/floor/admin-panel.tsx"), "utf8")
    const floorAppSource = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    const migrationSource = readFileSync(join(root, "migrations/auth/0008_admin_endpoint_refresh.sql"), "utf8")
    const stepUpMigrationSource = readFileSync(join(root, "migrations/auth/0010_admin_step_up.sql"), "utf8")
    const adminStart = workerSource.indexOf("async function handleAdminRequest")
    const jobsRoute = workerSource.indexOf('if (url.pathname === "/api/admin/jobs" && request.method === "POST")', adminStart)
    const adminRoutes = workerSource.slice(adminStart, workerSource.indexOf("\nasync function ", adminStart + 30))
    const refreshStart = workerSource.indexOf("async function runAdminEndpointRefresh")
    const refreshEnd = workerSource.indexOf("async function runAdminJob", refreshStart)
    const refreshBody = workerSource.slice(refreshStart, refreshEnd)
    assert.ok(adminStart >= 0 && jobsRoute > adminStart)
    assert.match(adminRoutes, /!isAdminElevated\(session\)/, "admin routes must require active session-scoped elevation")
    assert.match(workerSource, /isAdmin: false, canElevateAdmin:/, "normal Torn sign-in must never grant admin")
    assert.doesNotMatch(workerSource, /isAdmin: player\.id === ADMIN_PLAYER_ID/, "Torn player ID is only an elevation allowlist")
    assert.match(workerSource, /ADMIN_PASSWORD_HASH/)
    assert.match(workerSource, /ADMIN_USERNAME/)
    assert.match(workerSource, /ADMIN_MAX_ATTEMPTS = 5/)
    assert.match(workerSource, /admin_elevated_until/)
    assert.match(floorAppSource, /Unlock administration/)
    assert.match(floorAppSource, /\/api\/auth\/admin\/elevate/)
    assert.match(stepUpMigrationSource, /ALTER TABLE sessions ADD COLUMN admin_elevated_until/)
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
    await client.getUserJobFor(12345)
    await client.getCompanyProfileById(96639)
    assert.deepEqual(requested, [
      "https://api.torn.com/v2/faction/members",
      "https://api.torn.com/v2/user/12345/job",
      "https://api.torn.com/v2/company/96639/profile",
    ])
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

  await test("sign-in automatically uses a company director login key when Torn returns director as a numeric ID", async () => {
    const originalFetch = globalThis.fetch
    const apiKeys = new Map()
    const companyKeys = new Map()
    const companyApiKeys = new Map()
    const companies = new Map()
    const companySnapshots = new Map()
    const companyFinancials = new Map()
    const directorCache = new Map([["777", { is_director: 1 }]])
    const players = new Map()
    const sessions = new Map()
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async run() {
            const lower = sql.toLowerCase()
            if (lower.includes("insert into players")) players.set(String(values[0]), { player_id: String(values[0]), player_name: values[1] })
            if (lower.includes("insert into api_keys")) apiKeys.set(String(values[0]), { last_four: values[3], updated_at: values[5], ciphertext: values[1], iv: values[2] })
            if (lower.includes("insert into company_keys")) companyKeys.set(String(values[0]), { last_four: values[3], updated_at: values[5], ciphertext: values[1], iv: values[2] })
            if (lower.includes("insert into company_api_keys")) companyApiKeys.set(`${values[0]}:${values[1]}`, { player_id: String(values[0]), company_id: String(values[1]), last_four: values[4], company_name: values[5], company_type: values[6], updated_at: values[8], ciphertext: values[2], iv: values[3] })
            if (lower.includes("insert into companies")) companies.set(`${values[0]}:${values[1]}`, { player_id: String(values[0]), company_id: String(values[1]), company_name: values[2], company_type: values[3], profile_json: values[4], employees_json: values[5], fetched_at: values[6] })
            if (lower.includes("insert into company_snapshots")) companySnapshots.set(`${values[0]}:${values[1]}`, { player_id: String(values[0]), company_id: String(values[1]), profile_json: values[2], employees_json: values[3], fetched_at: values[4] })
            if (lower.includes("insert into company_financials")) companyFinancials.set(`${values[0]}:${values[1]}`, { player_id: String(values[0]), company_id: String(values[1]), stock_json: values[2], fetched_at: values[3] })
            if (lower.includes("insert into sessions")) sessions.set(String(values[0]), { token_hash: String(values[0]), player_id: String(values[1]), expires_at: Number(values[2]) })
            return { success: true }
          },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from company_keys")) return companyKeys.get(String(values[0])) ?? null
            if (lower.includes("from company_api_keys")) return [...companyApiKeys.values()].filter((row) => row.player_id === String(values[0])).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null
            if (lower.includes("from faction_member_cache")) return directorCache.get(String(values[0])) ?? null
            if (lower.includes("from companies")) return companies.get(`${values[0]}:${values[1]}`) ?? null
            if (lower.includes("from api_keys")) return apiKeys.get(String(values[0])) ?? null
            if (lower.includes("from sessions s join players p")) {
              const savedSession = sessions.get(String(values[0]))
              if (!savedSession || savedSession.expires_at <= Number(values[1])) return null
              return { ...players.get(savedSession.player_id), player_id: savedSession.player_id }
            }
            return null
          },
          async all() { return { results: [] } },
        }
      },
    }
    let combinedCompanyRequest = false
    let combinedRequests = 0
    let combinedFailureObserved = false
    let fallbackProfileUsed = false
    let tornRequestCount = 0
    globalThis.fetch = async (input) => {
      tornRequestCount += 1
      const url = new URL(String(input))
      const path = url.pathname
      if (path.endsWith("/v2/user/profile")) return new Response(JSON.stringify({ profile: { id: 777, name: "Test Director" } }))
      if (path.endsWith("/v2/user/faction")) return new Response(JSON.stringify({ faction: { id: 8317, name: "Naughty Souls" } }))
      if (path.endsWith("/v2/user/job")) return new Response(JSON.stringify({ job: { type: "company", id: 77, type_id: 28, name: "Test Company", position: "Director" } }))
      if (path.endsWith("/v2/company/profile")) {
        fallbackProfileUsed = true
        return new Response(JSON.stringify({ company: { id: 77, name: "Test Company", type: { id: 28, name: "Oil Rig" }, director: 777 } }))
      }
      if (path.endsWith("/v2/company/employees")) return new Response(JSON.stringify({ employees: [] }))
      if (path.endsWith("/v2/company/stock")) return new Response(JSON.stringify({ stock: [] }))
      if (path.endsWith("/v2/company") && url.searchParams.get("selections") === "timestamp,profile,stock,employees") {
        combinedRequests += 1
        if (combinedRequests === 2) {
          combinedFailureObserved = true
          return new Response(JSON.stringify({ error: { code: 16, error: "Not granted" } }), { status: 403 })
        }
        combinedCompanyRequest = true
        return new Response(JSON.stringify({ employees: [], stock: [], profile: { id: 77, name: "Test Company", type: { id: 28, name: "Oil Rig" }, director: { id: 777, name: "Test Director" } } }))
      }
      return new Response(JSON.stringify({ error: { code: 16, error: "Not granted" } }), { status: 403 })
    }
    try {
      const response = await worker.fetch(new Request("https://worker.test/api/auth/sign-in", {
        method: "POST",
        headers: { Origin: "https://naughty-company-dashboard.pages.dev", "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "primary-login-key-7777" }),
      }), { DB: db, KEY_ENCRYPTION_SECRET: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" })
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.company.isDirector, true)
      assert.equal(payload.company.key.saved, true)
      assert.equal(payload.company.key.lastFour, "7777")
      assert.equal(combinedCompanyRequest, true)
      assert.equal(combinedFailureObserved, true)
      assert.equal(fallbackProfileUsed, true)
      assert.equal(companyKeys.get("777").last_four, apiKeys.get("777").last_four)
      assert.equal([...companyApiKeys.values()][0].last_four, apiKeys.get("777").last_four)
      assert.equal(companies.get("777:77").company_name, "Test Company")
      assert.equal(companySnapshots.has("777:77"), true)

      // A returning director with a saved login credential is auto-connected if the primary company record is missing.
      companyKeys.clear()
      companyApiKeys.clear()
      const requestsBeforeRestore = tornRequestCount
      const restored = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: `Bearer ${payload.token}` },
      }), { DB: db, KEY_ENCRYPTION_SECRET: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" })
      assert.equal(restored.status, 200)
      const restoredPayload = await restored.json()
      assert.equal(restoredPayload.company.isDirector, true)
      assert.equal(restoredPayload.company.key.saved, true)
      assert.equal(companyKeys.has("777"), true)
      assert.equal(companyApiKeys.has("777:77"), true)
      assert.equal(companies.has("777:77"), true)
      assert.ok(tornRequestCount > requestsBeforeRestore)
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

  await test("administrator elevation fails closed when Worker secrets are not configured", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: 0 }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-session", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "not-a-real-password" }),
    }), { DB: db })
    assert.equal(response.status, 503)
    assert.match((await response.json()).error, /not configured/i)
  })

  await test("administrator elevation rejects a sequential password even when its stored hash matches", async () => {
    const { pbkdf2Sync } = require("node:crypto")
    const weakPassword = "abc123!x"
    const salt = Buffer.alloc(16, 9)
    const digest = pbkdf2Sync(weakPassword, salt, 210000, 32, "sha256")
    const passwordHash = ["pbkdf2-sha256", "210000", salt.toString("base64"), digest.toString("base64")].join("$")
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) {
          return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: 0 }
        }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-policy-session", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: weakPassword }),
    }), { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: passwordHash })
    assert.equal(response.status, 401)
    const payload = await response.json()
    assert.match(payload.error, /administrator sign-in failed/i)
    assert.equal(payload.diagnostic, "password_policy")
  })

  await test("owner elevation diagnostics identify username mismatch and malformed hash without exposing secrets", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) {
          return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: 0 }
        }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-diagnostics-session", "Content-Type": "application/json" }
    const wrongUsername = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST", headers, body: JSON.stringify({ username: "wrong", password: "Correct!7Horse?9" }),
    }), { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: "malformed" })
    assert.equal(wrongUsername.status, 401)
    assert.equal((await wrongUsername.json()).diagnostic, "username_mismatch")

    const malformedHash = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST", headers, body: JSON.stringify({ username: "owner", password: "Correct!7Horse?9" }),
    }), { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: "malformed" })
    assert.equal(malformedHash.status, 401)
    const payload = await malformedHash.json()
    assert.equal(payload.diagnostic, "stored_hash_invalid")
    assert.equal(Object.hasOwn(payload, "password"), false)
    assert.equal(JSON.stringify(payload).includes("malformed"), false, "diagnostics must not echo secret values")
  })

  await test("administrator elevation is session-scoped, expires, and can be explicitly revoked", async () => {
    const { pbkdf2Sync } = require("node:crypto")
    const password = "Correct!7Horse?9"
    const salt = Buffer.alloc(16, 7)
    const digest = pbkdf2Sync(password, salt, 210000, 32, "sha256")
    const passwordHash = ["pbkdf2-sha256", "210000", salt.toString("base64"), digest.toString("base64")].join("$")
    let elevatedUntil = 0
    const db = { prepare(sql) {
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          const normalized = sql.toLowerCase()
          if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: elevatedUntil }
          return null
        },
        async all() { return { results: [] } },
        async run() {
          if (sql.toLowerCase().startsWith("update sessions set admin_elevated_until = ?")) elevatedUntil = Number(values[0])
          else if (sql.toLowerCase().startsWith("update sessions set admin_elevated_until = 0")) elevatedUntil = 0
          return { success: true, meta: { changes: 1 } }
        },
      }
    } }
    const env = { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: passwordHash }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-session", "Content-Type": "application/json", "cf-connecting-ip": "192.0.2.10" }
    const elevated = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST", headers, body: JSON.stringify({ username: "owner", password }),
    }), env)
    assert.equal(elevated.status, 200)
    const elevatedPayload = await elevated.json()
    assert.equal(elevatedPayload.isAdmin, true)
    assert.ok(elevatedUntil > Math.floor(Date.now() / 1000))
    assert.ok(elevatedUntil <= Math.floor(Date.now() / 1000) + 1800)

    const revoked = await worker.fetch(new Request("https://worker.test/api/auth/admin/de-elevate", { method: "POST", headers }), env)
    assert.equal(revoked.status, 200)
    assert.equal((await revoked.json()).isAdmin, false)
    assert.equal(elevatedUntil, 0)

    const adminRequest = await worker.fetch(new Request("https://worker.test/api/admin/overview", { headers }), env)
    assert.equal(adminRequest.status, 403)
  })

  await test("maintenance mode permits owner recovery authentication but blocks ordinary APIs until elevation", async () => {
    let companyAutoConnectLookup = false
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        const normalized = sql.toLowerCase()
        if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: 0 }
        if (normalized.includes("from admin_settings")) return { value_json: "true" }
        if (normalized.includes("select company_id from company_api_keys") && normalized.includes("order by updated_at desc limit 1")) companyAutoConnectLookup = true
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-maintenance-session" }
    const restored = await worker.fetch(new Request("https://worker.test/api/auth/session", { headers }), { DB: db })
    assert.equal(restored.status, 200, "the allowlisted owner must be able to reach the separate elevation prompt")
    const session = await restored.json()
    assert.equal(session.isAdmin, false, "maintenance recovery must not confer admin privileges")
    assert.equal(session.canElevateAdmin, true)
    assert.equal(companyAutoConnectLookup, false, "maintenance recovery should not trigger automatic company connection work")

    const protectedData = await worker.fetch(new Request("https://worker.test/api/me/health", { headers }), { DB: db })
    assert.equal(protectedData.status, 401, "normal authenticated API routes remain blocked during maintenance before elevation")
  })

  await test("expired administrator elevation is denied at the Worker even if the browser still has stale admin state", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) {
          return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: Math.floor(Date.now() / 1000) - 60 }
        }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/admin/overview", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer stale-admin-session" },
    }), { DB: db })
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /administrator verification/i)
  })

  await test("administrator elevation rate-limits repeated invalid credentials", async () => {
    let attempt = { failures: 0, windowStartedAt: Math.floor(Date.now() / 1000), lockedUntil: 0 }
    const db = { prepare(sql) {
      let values = []
      return {
        bind(...args) { values = args; return this },
        async first() {
          const normalized = sql.toLowerCase()
          if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: 0 }
          if (normalized.includes("from admin_auth_attempts") && normalized.includes("select locked_until")) return { lockedUntil: attempt.lockedUntil }
          if (normalized.includes("from admin_auth_attempts") && normalized.includes("select failures")) return { ...attempt, windowStartedAt: attempt.windowStartedAt, lockedUntil: attempt.lockedUntil }
          return null
        },
        async all() { return { results: [] } },
        async run() {
          if (sql.toLowerCase().startsWith("insert into admin_auth_attempts")) attempt = { failures: Number(values[1]), windowStartedAt: Number(values[2]), lockedUntil: Number(values[3]) }
          return { success: true, meta: { changes: 1 } }
        },
      }
    } }
    const env = { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: "malformed" }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-session", "Content-Type": "application/json", "cf-connecting-ip": "192.0.2.11" }
    for (let index = 0; index < 5; index++) {
      const response = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
        method: "POST", headers, body: JSON.stringify({ username: "wrong", password: "incorrect-password" }),
      }), env)
      assert.equal(response.status, index === 4 ? 429 : 401)
    }
    assert.equal(attempt.failures, 5)
    assert.ok(attempt.lockedUntil > Math.floor(Date.now() / 1000))
    const locked = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST", headers, body: JSON.stringify({ username: "owner", password: "incorrect-password" }),
    }), env)
    assert.equal(locked.status, 429)
  })

  await test("administrator elevation is denied to non-allowlisted Torn identities", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "777", player_name: "Member Tester", admin_elevated_until: 0 }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
      method: "POST",
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "some-password" }),
    }), { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: "malformed" })
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /verification failed/i)
  })

  await test("admin API rejects requests without an authenticated dashboard session", async () => {
    const response = await worker.fetch(new Request("https://worker.test/api/admin/overview", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev" },
    }), { DB: { prepare() { return { bind() { return this }, async first() { return null }, async all() { return { results: [] } }, async run() { return { success: true } } } } } })
    assert.equal(response.status, 401)
    assert.match((await response.json()).error, /active dashboard session/i)
  })

  await test("owner Torn session has no admin access until step-up verification", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: 0 }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true, meta: { changes: 1 } } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/admin/overview", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer owner-standard-session" },
    }), { DB: db })
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /administrator verification/i)
  })

  await test("admin API rejects an authenticated non-administrator", async () => {
    const db = { prepare(sql) { return {
      bind() { return this },
      async first() {
        if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "777", player_name: "Member Tester" }
        return null
      },
      async all() { return { results: [] } },
      async run() { return { success: true } },
    } } }
    const response = await worker.fetch(new Request("https://worker.test/api/admin/overview", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer member-session" },
    }), { DB: db })
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /administrator (?:verification|access)/i)
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
          if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: Math.floor(Date.now() / 1000) + 1800 }
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
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: Math.floor(Date.now() / 1000) + 1800 }; return null },
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
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter", admin_elevated_until: Math.floor(Date.now() / 1000) + 1800 }; return null },
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
    assert.deepEqual(await response.json(), { deleted: true, companyId: "123", companyDataRetained: true, companyKeySaved: true })
    assert.equal(writes.length, 1)
    assert.match(writes[0].sql, /DELETE FROM company_api_keys WHERE player_id = \? AND company_id = \?/)
    assert.deepEqual(writes[0].values, ["777", "123"])
    assert.equal(writes.some((write) => /DELETE FROM (companies|company_snapshots|company_financials)/i.test(write.sql)), false)
  })

  await test("connection settings expose per-company key removal without deleting company records", () => {
    const source = readFileSync(join(root, "src/components/floor/floor-app.tsx"), "utf8")
    assert.match(source, /deleteSavedCompanyKey/)
    assert.match(source, /Remove key/)
    assert.match(source, /\/api\/auth\/company-key\?companyId=/)
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

  console.log(`\n${passed} backend checks passed.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
