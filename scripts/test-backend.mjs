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
  "src/lib/company/engine.ts",
  "src/lib/company/types.ts",
  "src/lib/torn/client.ts",
  "src/lib/torn/types.ts",
  "src/worker/index.ts",
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
            if (lower.includes("insert into sessions")) sessions.set(String(values[0]), { token_hash: String(values[0]), player_id: String(values[1]), expires_at: Number(values[2]) })
            return { success: true }
          },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from company_keys")) return companyKeys.get(String(values[0])) ?? null
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
    globalThis.fetch = async (input) => {
      const url = new URL(String(input))
      const path = url.pathname
      if (path.endsWith("/v2/user/profile")) return new Response(JSON.stringify({ profile: { id: 777, name: "Test Director" } }))
      if (path.endsWith("/v2/user/faction")) return new Response(JSON.stringify({ faction: { id: 8317, name: "Naughty Souls" } }))
      if (path.endsWith("/v2/user/job")) return new Response(JSON.stringify({ job: { type: "company", id: 77, type_id: 28, name: "Test Company", position: "Director" } }))
      if (path.endsWith("/v2/company/profile")) return new Response(JSON.stringify({ company: { id: 77, name: "Test Company", director: 777 } }))
      if (path.endsWith("/v2/company") && url.searchParams.get("selections") === "employees,stock,profile") {
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
      assert.equal(companyKeys.get("777").last_four, apiKeys.get("777").last_four)

      // Simulate a pre-fix session with no company key, then restore the session.
      companyKeys.clear()
      const restored = await worker.fetch(new Request("https://worker.test/api/auth/session", {
        headers: { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: `Bearer ${payload.token}` },
      }), { DB: db, KEY_ENCRYPTION_SECRET: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" })
      assert.equal(restored.status, 200)
      const restoredPayload = await restored.json()
      assert.equal(restoredPayload.company.isDirector, true)
      assert.equal(restoredPayload.company.key.saved, true)
      assert.equal(companyKeys.get("777").last_four, "7777")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test("private company sharing defaults off and only persists explicitly enabled categories", async () => {
    const token = "sharing-test-session-token"
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    let preferences = null
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from sessions s join players p")) return values[0] === tokenHash ? { player_id: "777", player_name: "Test Director" } : null
            if (lower.includes("from company_data_sharing")) return preferences
            return null
          },
          async run() {
            if (sql.toLowerCase().includes("insert into company_data_sharing")) {
              preferences = { ad_budget: values[1], employee_wages: values[2], employee_positions: values[3], employee_effectiveness: values[4], stock_quantity_pricing: values[5], updated_at: values[6] }
            }
            return { success: true }
          },
          async all() { return { results: [] } },
        }
      },
    }
    const env = { DB: db }
    const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: `Bearer ${token}` }
    const initial = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", { headers }), env)
    assert.equal(initial.status, 200)
    assert.deepEqual((await initial.json()).settings, { adBudget: false, employeeWages: false, employeePositions: false, employeeEffectiveness: false, stockQuantityPricing: false })
    const saved = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ settings: { employeeWages: true, stockQuantityPricing: true, adBudget: "true", employeePositions: 1 } }) }), env)
    assert.equal(saved.status, 200)
    assert.deepEqual((await saved.json()).settings, { adBudget: false, employeeWages: true, employeePositions: false, employeeEffectiveness: false, stockQuantityPricing: true })
    const reloaded = await worker.fetch(new Request("https://worker.test/api/me/data-sharing", { headers }), env)
    assert.deepEqual((await reloaded.json()).settings, { adBudget: false, employeeWages: true, employeePositions: false, employeeEffectiveness: false, stockQuantityPricing: true })
    const shared = await worker.fetch(new Request("https://worker.test/api/faction/shared-company-data", { headers }), env)
    assert.equal(shared.status, 200)
    assert.deepEqual((await shared.json()).companies, [])
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

  console.log(`\n${passed} backend checks passed.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
