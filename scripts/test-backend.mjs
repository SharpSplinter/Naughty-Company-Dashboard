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
    const db = {
      prepare(sql) {
        let values = []
        return {
          bind(...args) { values = args; return this },
          async run() {
            const lower = sql.toLowerCase()
            if (lower.includes("insert into api_keys")) apiKeys.set(String(values[0]), { last_four: values[3], updated_at: values[5], ciphertext: values[1], iv: values[2] })
            if (lower.includes("insert into company_keys")) companyKeys.set(String(values[0]), { last_four: values[3], updated_at: values[5], ciphertext: values[1], iv: values[2] })
            return { success: true }
          },
          async first() {
            const lower = sql.toLowerCase()
            if (lower.includes("from company_keys")) return companyKeys.get(String(values[0])) ?? null
            if (lower.includes("from api_keys")) return apiKeys.get(String(values[0])) ?? null
            return null
          },
          async all() { return { results: [] } },
        }
      },
    }
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith("/v2/user/profile")) return new Response(JSON.stringify({ profile: { id: 777, name: "Test Director" } }))
      if (path.endsWith("/v2/user/faction")) return new Response(JSON.stringify({ faction: { id: 8317, name: "Naughty Souls" } }))
      if (path.endsWith("/v2/company/profile")) return new Response(JSON.stringify({ company: { id: 77, name: "Test Company", director: 777 } }))
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
      assert.equal(companyKeys.get("777").last_four, apiKeys.get("777").last_four)
    } finally {
      globalThis.fetch = originalFetch
    }
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
