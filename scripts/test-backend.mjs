import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"

const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), "naughty-company-tests-"))
writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "commonjs" }))
const sourceFiles = [
  "src/lib/automation/rules.ts",
  "src/lib/company/engine.ts",
  "src/lib/company/types.ts",
  "src/lib/torn/client.ts",
  "src/lib/torn/types.ts",
  "src/worker/index.ts",
  "src/components/floor/ranking-utils.ts",
].map((file) => resolve(root, file))

try {
  const program = ts.createProgram(sourceFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
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
  const { placement } = require(join(temp, "components/floor/ranking-utils.js"))
  const { evaluateIncomeDrop, evaluateIncomeIncrease, evaluatePercentageDrop, evaluateRosterChange, isWithinQuietHours, normalizeWebhookUrl, isSnapshotStale, normalizeAlertThreshold, normalizeCooldownHours } = require(join(temp, "lib/automation/rules.js"))

  let passed = 0
  async function test(name, fn) {
    await fn()
    passed += 1
    console.log("PASS", name)
  }

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

  await test("handles quiet hours that cross midnight and all-day quiet windows", () => {
    assert.equal(isWithinQuietHours(23 * 60, "22:00", "08:00"), true)
    assert.equal(isWithinQuietHours(7 * 60, "22:00", "08:00"), true)
    assert.equal(isWithinQuietHours(12 * 60, "22:00", "08:00"), false)
    assert.equal(isWithinQuietHours(300, "08:00", "08:00"), true)
    assert.equal(isWithinQuietHours(300, "bad", "08:00"), false)
  })

  await test("accepts only public HTTPS webhook destinations", () => {
    assert.equal(normalizeWebhookUrl("https://hooks.example.com/alert"), "https://hooks.example.com/alert")
    assert.equal(normalizeWebhookUrl("http://hooks.example.com/alert"), null)
    assert.equal(normalizeWebhookUrl("https://localhost/alert"), null)
    assert.equal(normalizeWebhookUrl("https://127.0.0.1/alert"), null)
    assert.equal(normalizeWebhookUrl("https://192.168.1.10/alert"), null)
    assert.equal(normalizeWebhookUrl("https://user:secret@hooks.example.com/alert"), null)
    assert.equal(normalizeWebhookUrl("https://[::1]/alert"), null)
  })

  await test("webhook delivery never follows redirects to unvalidated destinations", () => {
    const workerSource = readFileSync(join(root, "src/worker/index.ts"), "utf8")
    assert.match(workerSource, /fetch\(endpoint, \{ method: "POST", redirect: "manual"/)
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
        employees: [{ id: 1, name: "Employee" }],
        stock: [{ id: 173, name: "Oil (Barrel)" }],
        profile: { id: 77, name: "Sample Oil Rig", type: { id: 28, name: "Oil Rig" } },
      }))
    } })
    const response = await client.getCompanySelections()
    assert.equal(requestedUrl, "https://api.torn.com/v2/company?selections=employees%2Cstock%2Cprofile")
    assert.equal(response.profile.profile.id, 77)
    assert.equal(response.employees.employees.length, 1)
    assert.equal(response.stock.stock.length, 1)
  })

  await test("normalizes Torn combined company responses that retain OpenAPI response wrappers", async () => {
    const client = new TornApiClient({ apiKey: "test", fetcher: async () => new Response(JSON.stringify({
      profile: { profile: { id: 78, name: "Wrapped Company", type: { id: 28, name: "Oil Rig" } } },
      employees: { employees: [{ id: 2, name: "Wrapped Employee" }] },
      stock: { stock: [{ id: 173, name: "Oil (Barrel)" }] },
    })) })
    const response = await client.getCompanySelections()
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
      if (path.endsWith("/v2/company") && url.searchParams.get("selections") === "employees,stock,profile") {
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

  await test("admin API rejects requests without an authenticated dashboard session", async () => {
    const response = await worker.fetch(new Request("https://worker.test/api/admin/overview", {
      headers: { Origin: "https://naughty-company-dashboard.pages.dev" },
    }), { DB: { prepare() { return { bind() { return this }, async first() { return null }, async all() { return { results: [] } }, async run() { return { success: true } } } } } })
    assert.equal(response.status, 401)
    assert.match((await response.json()).error, /active dashboard session/i)
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
    assert.match((await response.json()).error, /administrator access/i)
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
          if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter" }
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
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter" }; return null },
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
      async first() { if (sql.toLowerCase().includes("from sessions s join players p")) return { player_id: "351311", player_name: "SharpSplinter" }; return null },
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
          if (normalized.includes("row_number() over (partition by substr(fetched_at, 1, 10)")) {
            assert.deepEqual(values.slice(0, 2), ["777", "123"], "history queries must filter by authenticated owner and selected company")
            assert.equal(values.length, 3, "a selected range must bind its cutoff")
            return { results: [
              { snapshotId: "old", fetchedAt: "2026-10-08T18:10:00.000Z", profileJson: JSON.stringify({ company: { id: 123, income: { daily: 100, weekly: 700 }, rating: 3 } }), employeesJson: JSON.stringify({ employees: [{ id: 1 }] }) },
              { snapshotId: "latest", fetchedAt: "2026-10-10T18:10:00.000Z", profileJson: JSON.stringify({ company: { id: 123, income: { daily: 150, weekly: 1050 }, rating: 4 } }), employeesJson: JSON.stringify({ employees: [{ id: 1 }, { id: 2 }] }) },
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
    assert.equal(payload.history[1].dailyIncome, 150)
    assert.equal(payload.history[1].employeeCount, 2)
    assert.equal(payload.summary.snapshotCount, 2)
    assert.equal(payload.summary.dailyIncomeChange, 50)
    assert.equal(payload.summary.dailyIncomeChangePercent, 50)
    assert.equal(payload.summary.weeklyIncomeChange, 350)
    assert.equal(payload.summary.ratingChange, 1)
    assert.equal(payload.summary.employeeCountChange, 1)
    assert.ok(queries.some((query) => query.normalized.includes("where player_id = ? and company_id = ?")))
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
  })

  console.log(`\n${passed} backend checks passed.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
