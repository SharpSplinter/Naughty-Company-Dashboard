import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"
import { validateAdminPassword } from "../src/lib/admin-password-policy.js"

const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), "naughty-company-admin-password-test-"))
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
    throw new Error("Admin password encoding test compilation failed.")
  }
  program.emit()

  const require = createRequire(import.meta.url)
  const worker = require(join(temp, "worker/index.js")).default
  const { pbkdf2Sync, webcrypto } = await import("node:crypto")
  const password = "Café!2026 Horse?9" // Synthetic fixture only, never a production credential.
  assert.equal(validateAdminPassword(password).valid, true)
  const salt = Buffer.alloc(16, 11)
  const digest = pbkdf2Sync(password, salt, 210000, 32, "sha256")
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations: 210000 }, key, 256)
  assert.deepEqual(Buffer.from(bits), digest, "Node PBKDF2 and Web Crypto must agree for UTF-8 input")
  const hash = ["pbkdf2-sha256", "210000", salt.toString("base64"), digest.toString("base64")].join("$")

  let elevatedUntil = 0
  const db = { prepare(sql) {
    const normalized = sql.toLowerCase()
    let values = []
    return {
      bind(...args) { values = args; return this },
      async first() {
        if (normalized.includes("from sessions s join players p")) return { player_id: "351311", player_name: "Synthetic Owner", admin_elevated_until: elevatedUntil }
        return null
      },
      async all() { return { results: [] } },
      async run() {
        if (normalized.startsWith("update sessions set admin_elevated_until = ?")) elevatedUntil = Number(values[0])
        else if (normalized.startsWith("update sessions set admin_elevated_until = 0")) elevatedUntil = 0
        return { success: true, meta: { changes: 1 } }
      },
    }
  } }
  const env = { DB: db, ADMIN_USERNAME: "owner", ADMIN_PASSWORD_HASH: hash }
  const headers = { Origin: "https://naughty-company-dashboard.pages.dev", Authorization: "Bearer synthetic-unicode-owner-session", "Content-Type": "application/json" }
  const accepted = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
    method: "POST", headers, body: JSON.stringify({ username: "owner", password }),
  }), env)
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).isAdmin, true)
  assert.ok(elevatedUntil > Math.floor(Date.now() / 1000))

  const revoked = await worker.fetch(new Request("https://worker.test/api/auth/admin/de-elevate", { method: "POST", headers }), env)
  assert.equal(revoked.status, 200)
  assert.equal(elevatedUntil, 0)

  const rejected = await worker.fetch(new Request("https://worker.test/api/auth/admin/elevate", {
    method: "POST", headers, body: JSON.stringify({ username: "owner", password: "Cafe!2026 Horse?9" }),
  }), env)
  assert.equal(rejected.status, 401)
  assert.equal((await rejected.json()).diagnostic, "password_mismatch")
  assert.equal(elevatedUntil, 0)
  console.log("PASS admin password Unicode/embedded-space hash round-trip and fail-closed mismatch")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
