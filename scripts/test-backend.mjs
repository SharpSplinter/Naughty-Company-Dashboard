import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  const { evaluateIncomeDrop, isSnapshotStale, normalizeAlertThreshold, normalizeCooldownHours } = require(join(temp, "lib/automation/rules.js"))

  let passed = 0
  async function test(name, fn) {
    await fn()
    passed += 1
    console.log("PASS", name)
  }

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
    }), {})
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("access-control-allow-origin"), "https://naughty-company-dashboard.pages.dev")
    assert.deepEqual(await response.json(), { ok: true, service: "naughty-company-api" })
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

  console.log(`\n${passed} backend checks passed.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
