import { mkdirSync, writeFileSync } from "node:fs"

const apiKey = process.env.TORN_API_KEY?.trim()
if (!apiKey) {
  console.error("Required GitHub Actions secret TORN_API_KEY is missing.")
  process.exit(1)
}

const baseUrl = "https://api.torn.com/v2"
const outputPath = "artifacts/torn-personalstats-live-sanitized.json"
const requestedStats = [
  "xantaken",
  "lsdtaken",
  "drugsused",
  "overdosed",
  "alcoholused",
  "boostersused",
  "energydrinkused",
  "refills",
  "statenhancersused",
  "networth",
  "cantaken",
  "exttaken",
  "kettaken",
  "opitaken",
  "shrtaken",
  "spetaken",
  "pcptaken",
  "victaken",
]
const metricPaths = {
  xantaken: ["drugs", "xanax"],
  lsdtaken: ["drugs", "lsd"],
  drugsused: ["drugs", "total"],
  overdosed: ["drugs", "overdoses"],
  alcoholused: ["items", "used", "alcohol"],
  boostersused: ["items", "used", "boosters"],
  energydrinkused: ["items", "used", "energy_drinks"],
  refills: ["other", "refills", "energy"],
  statenhancersused: ["items", "used", "stat_enhancers"],
  networth: ["networth", "total"],
  cantaken: ["drugs", "cannabis"],
  exttaken: ["drugs", "ecstasy"],
  kettaken: ["drugs", "ketamine"],
  opitaken: ["drugs", "opium"],
  shrtaken: ["drugs", "shrooms"],
  spetaken: ["drugs", "speed"],
  pcptaken: ["drugs", "pcp"],
  victaken: ["drugs", "vicodin"],
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitize(value, key = "") {
  if (value === null) return null
  if (Array.isArray(value)) return value.slice(0, 2).map((child) => sanitize(child))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]))
  }
  // Historical stat names are public API enum identifiers, not player data.
  if (key === "name" && typeof value === "string" && requestedStats.includes(value)) return value
  // Preserve timestamp field validity while replacing the actual timestamp with a fixed test value.
  if (key === "timestamp" && typeof value === "number") return 1794000000
  if (typeof value === "number") return 0
  if (typeof value === "boolean") return false
  if (typeof value === "string") return "[REDACTED]"
  return "[UNSUPPORTED]"
}

function shapeOf(value) {
  if (value === null) return { type: "null" }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      item: value.length ? shapeOf(value[0]) : null,
    }
  }
  if (isRecord(value)) {
    return {
      type: "object",
      fields: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOf(child)])),
    }
  }
  return { type: typeof value }
}

function valueAtPath(root, path) {
  let current = root
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return null
    current = current[segment]
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null
}

let ownerPlayerId = null

const report = {
  generatedAt: new Date().toISOString(),
  source: "Torn API v2 owner-only GET /user/personalstats",
  privacy: {
    apiKeyIncluded: false,
    liveStatValuesIncluded: false,
    stringValues: "redacted",
    numericValues: "replaced with 0",
    arrays: "first two elements retained to preserve element shape",
  },
  openApiVersion: "6.15.0",
  results: [],
  fixtures: {},
}

async function captureKeyInfo() {
  try {
    const response = await fetch(`${baseUrl}/key/info`, {
      method: "GET",
      headers: { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    const payload = await response.json().catch(() => null)
    const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    if (!response.ok || apiError || !isRecord(payload) || !isRecord(payload.info)) {
      const code = typeof apiError?.code === "number" ? apiError.code : null
      report.keyInfo = { outcome: "unavailable", httpStatus: response.status, tornErrorCode: code }
      console.log(`Torn key info: HTTP ${response.status}; Torn error code ${code ?? "not supplied"}`)
      return
    }
    const access = isRecord(payload.info.access) ? payload.info.access : {}
    const user = isRecord(payload.info.user) ? payload.info.user : {}
    ownerPlayerId = typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0
      ? String(user.id)
      : typeof user.id === "string" && /^[1-9]\d*$/.test(user.id) ? user.id : null
    report.keyInfo = {
      outcome: "captured",
      httpStatus: response.status,
      accessLevel: typeof access.level === "number" ? access.level : null,
      accessType: typeof access.type === "string" ? access.type : null,
      userIdPresent: ownerPlayerId !== null,
      factionPermissionPresent: access.faction != null,
    }
    console.log(`Torn key info: HTTP ${response.status}; access level recorded without owner identifiers`)
  } catch {
    report.keyInfo = { outcome: "network-error" }
    console.log("Torn key info: network error (details suppressed)")
  }
}

async function capture(label, selection, path, category = null) {
  let response
  let payload
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    })
    payload = await response.json().catch(() => null)
  } catch {
    report.results.push({ label, selection, outcome: "network-error" })
    console.log(`Torn personalstats ${label}: network error (details suppressed)`)
    return null
  }

  const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  if (!response.ok || apiError) {
    const code = typeof apiError?.code === "number" ? apiError.code : null
    report.results.push({
      label,
      selection,
      outcome: "unavailable",
      httpStatus: response.status,
      tornErrorCode: code,
    })
    console.log(`Torn personalstats ${label}: HTTP ${response.status}; Torn error code ${code ?? "not supplied"}`)
    return null
  }

  const personalstats = isRecord(payload) || Array.isArray(payload)
    ? payload.personalstats
    : undefined
  const metrics = isRecord(personalstats)
    ? Object.fromEntries(Object.entries(metricPaths).map(([name, pathParts]) => [name, valueAtPath(personalstats, pathParts) !== null]))
    : null

  report.fixtures[label] = {
    selection,
    ...(category ? { requestedCategory: category } : {}),
    httpStatus: response.status,
    responseShape: shapeOf(payload),
    sanitizedPayload: sanitize(payload),
    ...(metrics ? { availableDashboardMetrics: Object.keys(metrics).filter((name) => metrics[name]) } : {}),
    ...(metrics ? { missingDashboardMetrics: Object.keys(metrics).filter((name) => !metrics[name]) } : {}),
  }
  report.results.push({
    label,
    selection,
    outcome: "captured",
    httpStatus: response.status,
    personalstatsType: Array.isArray(personalstats) ? "array" : isRecord(personalstats) ? "object" : typeof personalstats,
    ...(metrics ? {
      availableMetricCount: Object.values(metrics).filter(Boolean).length,
      missingMetricCount: Object.values(metrics).filter((available) => !available).length,
    } : {}),
  })
  console.log(`Torn personalstats ${label}: HTTP ${response.status}; personalstats=${Array.isArray(personalstats) ? "array" : isRecord(personalstats) ? "object" : typeof personalstats}`)
  return payload
}

async function requestTorn(path) {
  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })
}

async function captureFactionRosterAndMemberSamples() {
  try {
    const response = await requestTorn("/faction/members?striptags=true")
    const payload = await response.json().catch(() => null)
    const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    if (!response.ok || apiError || !isRecord(payload) || !Array.isArray(payload.members)) {
      const code = typeof apiError?.code === "number" ? apiError.code : null
      report.factionRoster = { outcome: "unavailable", httpStatus: response.status, tornErrorCode: code }
      console.log(`Torn faction roster: HTTP ${response.status}; Torn error code ${code ?? "not supplied"}`)
      return
    }

    const allIds = [...new Set(payload.members
      .map((member) => isRecord(member) ? member.id : null)
      .map((id) => typeof id === "number" ? String(id) : typeof id === "string" ? id : "")
      .filter((id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))))]

    const nonOwnerIds = allIds.filter((id) => id !== ownerPlayerId)
    const sampleIds = (nonOwnerIds.length ? nonOwnerIds : ownerPlayerId ? [ownerPlayerId] : []).slice(0, 2)
    report.factionRoster = {
      outcome: "captured",
      httpStatus: response.status,
      memberCount: payload.members.length,
      memberArrayPresent: true,
      memberShape: payload.members.length && isRecord(payload.members[0]) ? Object.keys(payload.members[0]).sort() : [],
      distinctTargetSampleCount: sampleIds.length,
      sampleTargetsWereOtherMembers: nonOwnerIds.length > 0,
    }
    report.fixtures.factionRoster = {
      httpStatus: response.status,
      responseShape: shapeOf(payload),
      sanitizedPayload: sanitize(payload),
    }
    console.log(`Torn faction roster: HTTP ${response.status}; members=${payload.members.length}; sampleTargets=${sampleIds.length}`)

    for (let index = 0; index < sampleIds.length; index += 1) {
      await capture(`factionMemberPopular${index + 1}`, "target member cat=popular", `/user/${sampleIds[index]}/personalstats?cat=popular`)
    }
  } catch {
    report.factionRoster = { outcome: "network-error" }
    console.log("Torn faction roster: network error (details suppressed)")
  }
}

async function captureGymEnergyContributors() {
  try {
    const response = await requestTorn("/faction/contributors?stat=gymenergy")
    const payload = await response.json().catch(() => null)
    const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    const contributors = isRecord(payload) && Array.isArray(payload.contributors) ? payload.contributors : null
    if (!response.ok || apiError || !contributors) {
      const code = typeof apiError?.code === "number" ? apiError.code : null
      report.gymEnergyContributors = { outcome: "unavailable", httpStatus: response.status, tornErrorCode: code }
      console.log(`Torn gym energy contributors: HTTP ${response.status}; Torn error code ${code ?? "not supplied"}`)
      return
    }
    report.gymEnergyContributors = {
      outcome: "captured",
      httpStatus: response.status,
      contributorCount: contributors.length,
      contributorFields: contributors.length && isRecord(contributors[0]) ? Object.keys(contributors[0]).sort() : [],
    }
    report.fixtures.gymEnergyContributors = {
      httpStatus: response.status,
      responseShape: shapeOf(payload),
      sanitizedPayload: sanitize(payload),
    }
    console.log(`Torn gym energy contributors: HTTP ${response.status}; contributors=${contributors.length}`)
  } catch {
    report.gymEnergyContributors = { outcome: "network-error" }
    console.log("Torn gym energy contributors: network error (details suppressed)")
  }
}

const timestamp = Math.floor(Date.now() / 1000)
const currentSelections = [
  { label: "popular", selection: "cat=popular", path: "/user/personalstats?cat=popular" },
  { label: "allOwner", selection: "cat=all (owner key)", path: "/user/personalstats?cat=all" },
  { label: "categoryDrugs", selection: "category", category: "drugs", path: "/user/personalstats?cat=drugs" },
  { label: "categoryItems", selection: "category", category: "items", path: "/user/personalstats?cat=items" },
  { label: "categoryOther", selection: "category", category: "other", path: "/user/personalstats?cat=other" },
  { label: "categoryNetworth", selection: "category", category: "networth", path: "/user/personalstats?cat=networth" },
]

for (const item of currentSelections) {
  await capture(item.label, item.selection, item.path, item.category ?? null)
}

await captureFactionRosterAndMemberSamples()
await captureGymEnergyContributors()

for (let offset = 0; offset < requestedStats.length; offset += 10) {
  const stats = requestedStats.slice(offset, offset + 10)
  const query = new URLSearchParams()
  query.set("stat", stats.join(","))
  query.set("timestamp", String(timestamp))
  await capture(`historicBatch${Math.floor(offset / 10) + 1}`, `historic stat batch (${stats.length} names)`, `/user/personalstats?${query.toString()}`)
}

await captureKeyInfo()

const popular = report.results.find((result) => result.label === "popular")
const allOwner = report.results.find((result) => result.label === "allOwner")
const historic = report.results.filter((result) => result.label.startsWith("historicBatch"))
const availablePopularMetrics = report.fixtures.popular?.availableDashboardMetrics ?? []
report.acceptance = {
  popularCaptured: popular?.outcome === "captured",
  popularCoversAllRequiredMetrics: requestedStats.every((name) => availablePopularMetrics.includes(name)),
  allOwnerSelectionCaptured: allOwner?.outcome === "captured",
  keyInfoCaptured: report.keyInfo?.outcome === "captured",
  historicalBatchesCaptured: historic.filter((result) => result.outcome === "captured").length,
  historicalBatchesRequested: 2,
}

mkdirSync("artifacts", { recursive: true })
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
console.log(`Sanitized personalstats response-shape report written to ${outputPath}`)
console.log(`Captured ${report.results.filter((result) => result.outcome === "captured").length} personalstats responses; faction roster=${report.factionRoster?.outcome ?? "not checked"}; gym-energy contributors=${report.gymEnergyContributors?.outcome ?? "not checked"}; no live stat values or credentials were written.`)

if (popular?.outcome !== "captured" || !report.acceptance.popularCoversAllRequiredMetrics) {
  console.error("The required Popular selection could not be captured. Inspect the sanitized artifact status only; raw API responses are suppressed.")
  process.exitCode = 1
}
