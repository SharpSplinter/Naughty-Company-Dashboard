// src/lib/torn/client.ts
var DEFAULT_BASE_URL = "https://api.torn.com/v2";
var DEFAULT_TIMEOUT_MS = 1e4;
function extractCompanyId(payload) {
  if (!isRecord(payload)) return null;
  const company = isRecord(payload.company) ? payload.company : isRecord(payload.profile) ? payload.profile : payload;
  const candidates = [company.id, company.company_id, company.companyId, company.ID, payload.company_id, payload.companyId];
  for (const candidate of candidates) {
    const id = typeof candidate === "number" ? candidate : typeof candidate === "string" && /^\d+$/.test(candidate) ? Number(candidate) : NaN;
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}
var TornApiClientError = class extends Error {
  status;
  code;
  retryAfter;
  constructor(message, options) {
    super(message);
    this.name = "TornApiClientError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function apiErrorMessage(code) {
  switch (code) {
    case 2:
      return "The Torn API key is invalid.";
    case 3:
      return "The Torn API key does not have the required access.";
    case 4:
      return "The Torn company ID is invalid.";
    case 9:
      return "Torn API rate limit reached. Please retry shortly.";
    default:
      return "Torn API request failed.";
  }
}
function apiErrorStatus(responseStatus, code) {
  if (responseStatus === 429 || code === 9) return 429;
  if (code === 2) return 401;
  if (code === 3) return 403;
  if (code === 4) return 400;
  if (responseStatus >= 500) return 502;
  return 502;
}
var TornApiClient = class {
  apiKey;
  baseUrl;
  fetcher;
  timeoutMs;
  constructor(options) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new TornApiClientError("A Torn API key is required.", {
        status: 401
      });
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  async getUserJob() {
    return this.request("/user/job");
  }
  async getFactionMembers() {
    return this.request("/faction/members");
  }
  async getUserJobFor(playerId) {
    if (!/^\d+$/.test(String(playerId))) throw new TornApiClientError("Player ID must be numeric.", { status: 400 });
    return this.request(`/user/${playerId}/job`);
  }
  async getCompanyProfileById(companyId) {
    if (!/^\d+$/.test(String(companyId))) throw new TornApiClientError("Company ID must be numeric.", { status: 400 });
    return this.request(`/company/${companyId}/profile`);
  }
  async getCompanyProfile() {
    return this.request("/company/profile");
  }
  async getCompanyEmployees() {
    return this.request("/company/employees");
  }
  async getCompanyStock() {
    return this.request("/company/stock");
  }
  async getCompanySelections() {
    const payload = await this.request("/company?selections=employees%2Cstock%2Cprofile");
    if (!isRecord(payload) || !isRecord(payload.profile)) {
      throw new TornApiClientError("Torn did not return a company profile in the combined response.", { status: 502 });
    }
    const profilePayload = isRecord(payload.profile.profile) ? payload.profile : { profile: payload.profile };
    const employeePayload = Array.isArray(payload.employees) ? { employees: payload.employees } : isRecord(payload.employees) && Array.isArray(payload.employees.employees) ? payload.employees : null;
    const stockPayload = Array.isArray(payload.stock) ? { stock: payload.stock } : isRecord(payload.stock) && Array.isArray(payload.stock.stock) ? payload.stock : null;
    if (!employeePayload || !stockPayload) {
      throw new TornApiClientError("Torn did not return company employees and stock in the combined response.", { status: 502 });
    }
    return {
      profile: profilePayload,
      employees: employeePayload,
      stock: stockPayload
    };
  }
  async getCompanyData() {
    const [profile, employees] = await Promise.all([
      this.getCompanyProfile(),
      this.getCompanyEmployees()
    ]);
    const companyId = extractCompanyId(profile);
    if (!companyId) throw new TornApiClientError("Torn did not return a valid company ID for this API key.", { status: 502 });
    return { companyId, profile, employees, fetchedAt: (/* @__PURE__ */ new Date()).toISOString() };
  }
  async request(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: "application/json"
        },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      if (!response.ok || apiError) {
        const upstreamStatus = typeof response.status === "number" ? response.status : 502;
        const apiCode = apiError && typeof apiError.code === "number" ? apiError.code : void 0;
        const retryAfter = response.headers.get("Retry-After") ?? void 0;
        throw new TornApiClientError(apiErrorMessage(apiCode), {
          status: apiErrorStatus(upstreamStatus, apiCode),
          code: apiCode,
          retryAfter
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof TornApiClientError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TornApiClientError("Torn API request timed out.", {
          status: 504
        });
      }
      throw new TornApiClientError("Could not reach the Torn API.", {
        status: 502
      });
    } finally {
      clearTimeout(timeout);
    }
  }
};

// src/lib/automation/rules.ts
function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function normalizeAlertThreshold(value, fallback = 15) {
  const number = finiteNumber(value);
  return Math.min(90, Math.max(1, number === null ? fallback : number));
}
function normalizeCooldownHours(value, fallback = 24) {
  const number = finiteNumber(value);
  return Math.round(Math.min(168, Math.max(1, number === null ? fallback : number)));
}
function evaluateIncomeDrop(previous, current, threshold) {
  const before = finiteNumber(previous);
  const after = finiteNumber(current);
  if (before === null || after === null || before <= 0) return null;
  const changePercent = (after - before) / before * 100;
  return changePercent <= -normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null;
}
function isSnapshotStale(fetchedAt, nowMs, afterHours) {
  if (!fetchedAt) return false;
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - fetchedMs >= normalizeCooldownHours(afterHours, 30) * 36e5;
}
function evaluateIncomeIncrease(previous, current, threshold) {
  const before = finiteNumber(previous);
  const after = finiteNumber(current);
  if (before === null || after === null || before <= 0) return null;
  const changePercent = (after - before) / before * 100;
  return changePercent >= normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null;
}
function evaluatePercentageDrop(previous, current, threshold) {
  const before = finiteNumber(previous);
  const after = finiteNumber(current);
  if (before === null || after === null || before <= 0) return null;
  const changePercent = (after - before) / before * 100;
  return changePercent <= -normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null;
}
function evaluateRosterChange(previous, current, threshold) {
  const before = finiteNumber(previous);
  const after = finiteNumber(current);
  if (before === null || after === null || before < 0 || after < 0 || before === after) return null;
  const changePercent = before > 0 ? (after - before) / before * 100 : after > 0 ? 100 : 0;
  return Math.abs(changePercent) >= normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null;
}
function normalizeWebhookUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || host.includes(":") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host === "metadata.google.internal") return null;
    if (/^(?:0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return null;
    if (/^[0-9.]+$/.test(host) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// src/worker/index.ts
var jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
var DAY = 86400;
var ADMIN_PLAYER_ID = "351311";
function jsonResponse(body, status = 200, origin = "null", extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, X-Admin-Confirm-Restore", vary: "Origin", ...extraHeaders } });
}
function allowedOrigin(request, env) {
  const incoming = request.headers.get("Origin");
  if (!incoming) return "null";
  const configured = env.ALLOWED_ORIGIN?.trim();
  if (configured && configured !== "*" && incoming === configured) return incoming;
  try {
    const url = new URL(incoming);
    const isDashboard = url.protocol === "https:" && /^(?:[a-z0-9-]+\.)?naughty-company-dashboard\.pages\.dev$/.test(url.hostname);
    const isLocalDev = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "3000";
    return isDashboard || isLocalDev ? incoming : null;
  } catch {
    return null;
  }
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asJson(value) {
  return JSON.stringify(value ?? null);
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function encryptionKey(env) {
  if (!env.KEY_ENCRYPTION_SECRET || env.KEY_ENCRYPTION_SECRET.length < 32) throw new Error("Key encryption is not configured.");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.KEY_ENCRYPTION_SECRET));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptKey(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(value));
  return { ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))), iv: btoa(String.fromCharCode(...iv)) };
}
async function decryptKey(env, ciphertext, iv) {
  const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await encryptionKey(env), decode(ciphertext));
  return new TextDecoder().decode(plaintext);
}
function requireDb(env) {
  if (!env.DB) throw new Error("Persistent storage is not configured.");
  return env.DB;
}
async function readAdminSetting(env, key) {
  const row = await requireDb(env).prepare("SELECT value_json FROM admin_settings WHERE setting_key = ?").bind(key).first();
  if (!row) return void 0;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return void 0;
  }
}
async function readAdminBoolean(env, key, fallback) {
  const value = await readAdminSetting(env, key);
  return typeof value === "boolean" ? value : fallback;
}
async function authenticate(request, env) {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token || !env.DB) return null;
  const hash = await sha256(token);
  const session = await requireDb(env).prepare("SELECT p.player_id, p.player_name FROM sessions s JOIN players p ON p.player_id = s.player_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(hash, Math.floor(Date.now() / 1e3)).first();
  if (!session) return null;
  if (session.player_id !== ADMIN_PLAYER_ID) {
    const status = await requireDb(env).prepare("SELECT disabled_at FROM dashboard_member_status WHERE player_id = ?").bind(session.player_id).first();
    if (status?.disabled_at) return null;
    if (await readAdminBoolean(env, "maintenanceMode", false)) return null;
  }
  return session;
}
async function validateTornKey(apiKey) {
  if (!apiKey || apiKey.length > 256 || /\s/.test(apiKey)) throw new Error("Enter a valid Torn API key.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1e4);
  try {
    const headers = { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" };
    const profileResponse = await fetch("https://api.torn.com/v2/user/profile", { headers, signal: controller.signal });
    const profilePayload = await profileResponse.json().catch(() => null);
    if (!profileResponse.ok || isRecord2(profilePayload) && isRecord2(profilePayload.error)) {
      const error = isRecord2(profilePayload) && isRecord2(profilePayload.error) ? profilePayload.error : null;
      const code = typeof error?.code === "number" ? error.code : void 0;
      const status = code === 2 ? 401 : code === 3 ? 403 : code === 9 ? 429 : profileResponse.status >= 500 ? 502 : 401;
      throw Object.assign(new Error(code === 2 ? "That Torn API key is invalid." : code === 3 ? "This Torn API key does not have profile access." : code === 9 ? "Torn rate limit reached. Try again shortly." : "Could not verify this Torn API key."), { status });
    }
    const profile = isRecord2(profilePayload) && isRecord2(profilePayload.profile) ? profilePayload.profile : null;
    const id = profile?.id ?? profile?.player_id;
    const name = profile?.name;
    if (typeof id !== "number" && typeof id !== "string" || !/^\d+$/.test(String(id)) || Number(id) <= 0 || typeof name !== "string" || !name.trim()) throw Object.assign(new Error("Torn returned an unexpected player profile."), { status: 502 });
    const factionResponse = await fetch("https://api.torn.com/v2/user/faction", { headers, signal: controller.signal });
    const factionPayload = await factionResponse.json().catch(() => null);
    if (!factionResponse.ok || isRecord2(factionPayload) && isRecord2(factionPayload.error)) {
      const error = isRecord2(factionPayload) && isRecord2(factionPayload.error) ? factionPayload.error : null;
      const code = typeof error?.code === "number" ? error.code : void 0;
      const status = code === 2 ? 401 : code === 3 ? 403 : code === 9 ? 429 : factionResponse.status >= 500 ? 502 : 502;
      throw Object.assign(new Error(code === 3 ? "The API key needs faction access so Naughty Souls membership can be verified. Use a limited-access key that includes faction access." : code === 9 ? "Torn rate limit reached while checking faction membership. Try again shortly." : "We could not verify your Naughty Souls membership with Torn. Please check your key permissions and try again."), { status });
    }
    const faction = isRecord2(factionPayload) && isRecord2(factionPayload.faction) ? factionPayload.faction : null;
    const factionId = faction?.id ?? (isRecord2(factionPayload) ? factionPayload.faction_id : void 0);
    const factionName = faction?.name;
    if (typeof factionId !== "number" && typeof factionId !== "string" || !/^\d+$/.test(String(factionId))) {
      throw Object.assign(new Error("ACCESS DENIED: Your Torn account is not a member of Naughty Souls (faction ID 8317). You must belong to Naughty Souls to use this dashboard."), { status: 403 });
    }
    if (String(factionId) !== "8317") {
      throw Object.assign(new Error("ACCESS DENIED: You do not belong to Naughty Souls (faction ID 8317). This dashboard is exclusively for Naughty Souls faction members. Sign-in has been blocked."), { status: 403 });
    }
    return { id: String(id), name: name.trim().slice(0, 100), factionId: String(factionId), factionName: typeof factionName === "string" ? factionName.trim().slice(0, 100) : "Naughty Souls" };
  } finally {
    clearTimeout(timeout);
  }
}
async function saveKey(env, playerId, apiKey) {
  const encrypted = await encryptKey(env, apiKey);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await requireDb(env).prepare("INSERT INTO api_keys (player_id, ciphertext, iv, last_four, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, updated_at = excluded.updated_at").bind(playerId, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), now, now).run();
}
async function savedKey(env, playerId) {
  const row = await requireDb(env).prepare("SELECT ciphertext, iv FROM api_keys WHERE player_id = ?").bind(playerId).first();
  return row ? decryptKey(env, row.ciphertext, row.iv) : null;
}
async function saveCompanyKey(env, playerId, apiKey) {
  const encrypted = await encryptKey(env, apiKey);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await requireDb(env).prepare("INSERT INTO company_keys (player_id, ciphertext, iv, last_four, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, updated_at = excluded.updated_at").bind(playerId, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), now, now).run();
}
async function savedCompanyKey(env, playerId) {
  const row = await requireDb(env).prepare("SELECT ciphertext, iv FROM company_keys WHERE player_id = ?").bind(playerId).first();
  return row ? decryptKey(env, row.ciphertext, row.iv) : null;
}
async function saveCompanyApiKey(env, playerId, companyId, apiKey, profile) {
  const encrypted = await encryptKey(env, apiKey);
  const root = isRecord2(profile) && isRecord2(profile.company) ? profile.company : isRecord2(profile) && isRecord2(profile.profile) ? profile.profile : isRecord2(profile) ? profile : {};
  const type = isRecord2(root.type) ? root.type : {};
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await requireDb(env).prepare("INSERT INTO company_api_keys (player_id, company_id, ciphertext, iv, last_four, company_name, company_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, company_name = excluded.company_name, company_type = excluded.company_type, updated_at = excluded.updated_at").bind(playerId, String(companyId), encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), typeof root.name === "string" ? root.name : `Company #${companyId}`, typeof type.name === "string" ? type.name : null, now, now).run();
}
async function persistCompanyConnection(env, playerId, apiKey, validated) {
  await saveCompanyKey(env, playerId, apiKey);
  await saveCompanyApiKey(env, playerId, validated.companyId, apiKey, validated.profile);
  const profile = validated.profile;
  const root = isRecord2(profile) && isRecord2(profile.company) ? profile.company : isRecord2(profile) && isRecord2(profile.profile) ? profile.profile : {};
  const type = isRecord2(root.type) ? root.type : {};
  const companyName = typeof root.name === "string" ? root.name : `Company #${validated.companyId}`;
  const companyType = typeof type.name === "string" ? type.name : null;
  const db = requireDb(env);
  const existing = await db.prepare("SELECT employees_json FROM companies WHERE player_id = ? AND company_id = ?").bind(playerId, String(validated.companyId)).first();
  const employeesJson = validated.employees ? asJson(validated.employees) : existing?.employees_json ?? "{}";
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(playerId, String(validated.companyId), companyName, companyType, asJson(profile), employeesJson, now).run();
  await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(playerId, String(validated.companyId), asJson(profile), employeesJson, now).run();
  if (validated.stock !== null && validated.stock !== void 0) {
    await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(playerId, String(validated.companyId), asJson(validated.stock), now).run();
    try {
      await persistFactionDirectorSnapshot(env, profile, validated.stock);
    } catch {
    }
  }
}
async function ensurePrimaryCompanyConnection(env, playerId) {
  const db = requireDb(env);
  const existing = await db.prepare("SELECT company_id FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC LIMIT 1").bind(playerId).first();
  if (existing) {
    const snapshot = await db.prepare("SELECT company_id FROM companies WHERE player_id = ? AND company_id = ?").bind(playerId, existing.company_id).first();
    if (snapshot) return { saved: true, companyId: existing.company_id };
    const existingKey = await savedCompanyApiKey(env, playerId, existing.company_id);
    if (existingKey) {
      const validated2 = await validateCompanyKey(existingKey);
      await persistCompanyConnection(env, playerId, existingKey, validated2);
      return { saved: true, companyId: String(validated2.companyId) };
    }
  }
  const director = await db.prepare("SELECT is_director FROM faction_member_cache WHERE player_id = ?").bind(playerId).first();
  if (director?.is_director !== 1) return { saved: false };
  const apiKey = await savedKey(env, playerId);
  if (!apiKey) return { saved: false };
  const validated = await validateCompanyKey(apiKey);
  await persistCompanyConnection(env, playerId, apiKey, validated);
  return { saved: true, companyId: String(validated.companyId) };
}
async function savedCompanyApiKey(env, playerId, companyId) {
  const row = await requireDb(env).prepare("SELECT ciphertext, iv FROM company_api_keys WHERE player_id = ? AND company_id = ?").bind(playerId, companyId).first();
  return row ? decryptKey(env, row.ciphertext, row.iv) : null;
}
async function companyKeyMeta(env, playerId) {
  const legacy = await requireDb(env).prepare("SELECT last_four, updated_at FROM company_keys WHERE player_id = ?").bind(playerId).first();
  const perCompany = await requireDb(env).prepare("SELECT last_four, updated_at FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC LIMIT 1").bind(playerId).first();
  const row = perCompany ?? legacy;
  return row ? { saved: true, lastFour: row.last_four, updatedAt: row.updated_at } : { saved: false };
}
async function validateCompanyKey(apiKey) {
  const client = new TornApiClient({ apiKey });
  let profile, employees = null, stock = null;
  try {
    const selections = await client.getCompanySelections();
    profile = selections.profile;
    employees = selections.employees;
    stock = selections.stock;
  } catch {
    profile = await client.getCompanyProfile();
    const fallbackId = companyIdFromPayload(profile);
    if (!fallbackId) throw Object.assign(new Error("That key did not return a valid company profile. Use a key with company profile access."), { status: 403 });
    try {
      employees = await client.getCompanyEmployees();
    } catch {
    }
    try {
      stock = await client.getCompanyStock();
    } catch {
    }
  }
  const companyId = companyIdFromPayload(profile);
  if (!companyId) throw Object.assign(new Error("That key did not return a valid company profile. Use a key with company profile access."), { status: 403 });
  return { companyId, profile, employees, stock };
}
async function inspectDirectorKey(apiKey, playerId) {
  try {
    const client = new TornApiClient({ apiKey });
    const jobPayload = await client.getUserJob();
    const job = isRecord2(jobPayload) && isRecord2(jobPayload.job) ? jobPayload.job : {};
    const position = typeof job.position === "string" ? job.position.trim().toLowerCase() : "";
    const jobCompanyId = job.id;
    if (position !== "director" || typeof jobCompanyId !== "number" && !(typeof jobCompanyId === "string" && /^\d+$/.test(jobCompanyId))) {
      return { isDirector: false };
    }
    const selections = await client.getCompanySelections();
    const companyId = companyIdFromPayload(selections.profile);
    if (!companyId || String(companyId) !== String(jobCompanyId)) return { isDirector: false };
    return { isDirector: true, profile: selections.profile };
  } catch {
    return { isDirector: false };
  }
}
function companyIdFromPayload(payload) {
  if (!isRecord2(payload)) return null;
  const company = isRecord2(payload.company) ? payload.company : isRecord2(payload.profile) ? payload.profile : payload;
  const candidates = [company.id, company.company_id, company.companyId, company.ID, payload.company_id, payload.companyId];
  for (const candidate of candidates) {
    const id = typeof candidate === "number" ? candidate : typeof candidate === "string" && /^\d+$/.test(candidate) ? Number(candidate) : NaN;
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}
function tornError(error, origin) {
  if (error instanceof TornApiClientError) return jsonResponse({ error: error.message }, error.status, origin, error.retryAfter ? { "retry-after": error.retryAfter } : {});
  const status = isRecord2(error) && typeof error.status === "number" ? error.status : 500;
  return jsonResponse({ error: error instanceof Error ? error.message : "Unexpected server error." }, status, origin);
}
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}
function normalizedColumn(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function numberField(row, ...names) {
  for (const name of names) {
    const value = row[normalizedColumn(name)];
    if (value !== void 0 && value.trim() !== "") {
      const number = Number(value.replace(/[$,]/g, ""));
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}
async function fetchGlobalCompanyRankings(apiKey) {
  const headers = { Authorization: `ApiKey ${apiKey}`, Accept: "text/csv, text/plain, application/json" };
  const response = await fetch("https://api.torn.com/v2/company/snapshot", { headers, signal: AbortSignal.timeout(2e4) });
  const body = await response.text();
  if (!response.ok || body.trimStart().startsWith("{")) {
    let message = "Torn could not provide the all-company snapshot.";
    try {
      const payload = JSON.parse(body);
      if (isRecord2(payload) && isRecord2(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message;
    } catch {
    }
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : response.status >= 500 ? 502 : 502 });
  }
  const csv = parseCsv(body);
  if (csv.length < 2) throw Object.assign(new Error("Torn returned an empty company snapshot."), { status: 502 });
  const typeNames = /* @__PURE__ */ new Map();
  try {
    const typeResponse = await fetch("https://api.torn.com/v2/torn/companies", { headers, signal: AbortSignal.timeout(1e4) });
    if (typeResponse.ok) {
      const typePayload = await typeResponse.json();
      const root = isRecord2(typePayload) && isRecord2(typePayload.companies) ? typePayload.companies : isRecord2(typePayload) && isRecord2(typePayload.company_types) ? typePayload.company_types : typePayload;
      const entries = Array.isArray(root) ? root : isRecord2(root) ? Object.values(root) : [];
      for (const entry of entries) {
        if (!isRecord2(entry)) continue;
        const id = entry.id ?? entry.ID ?? entry.company_type;
        const name = entry.name ?? entry.title ?? entry.type_name;
        if ((typeof id === "number" || typeof id === "string" && /^\d+$/.test(id)) && typeof name === "string") typeNames.set(Number(id), name);
      }
    }
  } catch {
  }
  const headersRow = csv[0].map(normalizedColumn);
  const records = csv.slice(1).map((cells) => Object.fromEntries(headersRow.map((header, index) => [header, cells[index] ?? ""])));
  const companies = records.flatMap((row) => {
    const companyId = numberField(row, "id", "company_id", "companyId", "ID");
    if (!companyId) return [];
    const typeId = numberField(row, "company_type_id", "company_type", "companyType", "type_id", "type");
    const weeklyIncome = numberField(row, "weekly_income", "weeklyIncome");
    const dailyIncome = numberField(row, "daily_income", "dailyIncome");
    const rating = numberField(row, "rating", "stars", "star_rating");
    return [{ companyId: String(companyId), companyName: row.name || row.companyname || `Company #${companyId}`, companyType: row.companytypename || row.typename || (typeId === null ? "Unknown" : typeNames.get(typeId) || `Type #${typeId}`), companyTypeId: typeId, starRating: rating, weeklyIncome, dailyIncome, averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7, directorName: "", playerId: "torn-global", fetchedAt: (/* @__PURE__ */ new Date()).toISOString() }];
  }).sort((a, b) => Number(b.weeklyIncome ?? -1) - Number(a.weeklyIncome ?? -1));
  return { companies, snapshotFetchedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
async function refreshGlobalRankingCache(env, apiKey, force = false) {
  if (!env.DB) return;
  const db = requireDb(env);
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_refresh_lock (lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1), lease_until INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare("INSERT INTO global_rankings_refresh_lock (lock_id, lease_until) VALUES (1, 0) ON CONFLICT(lock_id) DO NOTHING").run();
  const cached = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first();
  const nowMs = Date.now();
  const cacheAge = cached?.fetchedAt ? nowMs - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;
  const maxAgeMs = 24 * 60 * 60 * 1e3;
  if (!force && Number.isFinite(cacheAge) && cacheAge >= 0 && cacheAge < maxAgeMs) return;
  const nowSeconds = Math.floor(nowMs / 1e3);
  const leaseUntil = nowSeconds + 120;
  const claim = await db.prepare("UPDATE global_rankings_refresh_lock SET lease_until = ? WHERE lock_id = 1 AND lease_until < ?").bind(leaseUntil, nowSeconds).run();
  if (claim.meta?.changes === 0) return;
  try {
    const latest = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first();
    const latestAge = latest?.fetchedAt ? Date.now() - Date.parse(latest.fetchedAt) : Number.POSITIVE_INFINITY;
    if (!force && Number.isFinite(latestAge) && latestAge >= 0 && latestAge < maxAgeMs) return;
    let key = apiKey;
    if (!key) {
      const row = await db.prepare("SELECT player_id FROM api_keys ORDER BY updated_at DESC LIMIT 1").first();
      if (row) key = await savedKey(env, row.player_id) ?? void 0;
    }
    if (!key) return;
    const snapshot = await fetchGlobalCompanyRankings(key);
    await db.prepare("INSERT INTO global_rankings_cache (cache_id, companies_json, fetched_at) VALUES (1, ?, ?) ON CONFLICT(cache_id) DO UPDATE SET companies_json = excluded.companies_json, fetched_at = excluded.fetched_at").bind(asJson(snapshot.companies), snapshot.snapshotFetchedAt).run();
  } finally {
    await db.prepare("UPDATE global_rankings_refresh_lock SET lease_until = 0 WHERE lock_id = 1 AND lease_until = ?").bind(leaseUntil).run().catch(() => void 0);
  }
}
function companyProfileRoot(payload) {
  if (!isRecord2(payload)) return {};
  if (isRecord2(payload.company)) return payload.company;
  if (isRecord2(payload.profile)) return isRecord2(payload.profile.profile) ? payload.profile.profile : payload.profile;
  return payload;
}
function positiveId(value) {
  if ((typeof value === "number" || typeof value === "string") && /^\d+$/.test(String(value)) && Number(value) > 0) return String(value);
  return null;
}
async function persistFactionDirectorSnapshot(env, profile, stock = null) {
  if (!env.DB) return;
  const root = companyProfileRoot(profile);
  const director = isRecord2(root.director) ? root.director : {};
  const playerId = positiveId(director.id ?? director.player_id);
  const companyId = positiveId(root.id ?? root.company_id);
  if (!playerId || !companyId) return;
  const type = isRecord2(root.type) ? root.type : {};
  const name = typeof root.name === "string" ? root.name : `Company #${companyId}`;
  const typeName = typeof type.name === "string" ? type.name : null;
  const typeId = typeof type.id === "number" ? type.id : null;
  const rating = typeof root.rating === "number" ? root.rating : null;
  const income = isRecord2(root.income) ? root.income : {};
  const dailyIncome = typeof income.daily === "number" ? income.daily : null;
  const weeklyIncome = typeof income.weekly === "number" ? income.weekly : null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const day = now.slice(0, 10);
  const db = requireDb(env);
  await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, company_id, company_name, company_type, company_type_id, company_rating, daily_income, weekly_income, profile_json, updated_at) VALUES (?, ?, '8317', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET is_director = 1, company_id = excluded.company_id, company_name = excluded.company_name, company_type = excluded.company_type, company_type_id = excluded.company_type_id, company_rating = excluded.company_rating, daily_income = excluded.daily_income, weekly_income = excluded.weekly_income, profile_json = excluded.profile_json, updated_at = excluded.updated_at").bind(playerId, typeof director.name === "string" ? director.name : `Player #${playerId}`, now, companyId, name, typeName, typeId, rating, dailyIncome, weeklyIncome, asJson(profile), now).run();
  await db.prepare("INSERT INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id, snapshot_day) DO NOTHING").bind(playerId, companyId, day, asJson(profile), stock === null || stock === void 0 ? null : asJson(stock), now).run();
}
async function syncFactionDirectorDirectory(env, apiKey, limit = 20) {
  const client = new TornApiClient({ apiKey });
  const memberPayload = await client.getFactionMembers();
  const rawMembers = Array.isArray(memberPayload.members) ? memberPayload.members : isRecord2(memberPayload.members) ? Object.values(memberPayload.members) : [];
  const db = requireDb(env);
  const now = Date.now();
  let processed = 0;
  let pending = 0;
  for (const item of rawMembers) {
    if (!isRecord2(item)) continue;
    const id = positiveId(item.id ?? item.user_id);
    if (!id) continue;
    const name = typeof item.name === "string" ? item.name : `Player #${id}`;
    const cached = await db.prepare("SELECT checked_at FROM faction_member_cache WHERE player_id = ?").bind(id).first();
    const checked = cached?.checked_at ? Date.parse(cached.checked_at) : 0;
    if (checked && now - checked < 12 * 60 * 60 * 1e3) continue;
    if (processed >= limit) {
      pending += 1;
      continue;
    }
    processed += 1;
    const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      const jobPayload = await client.getUserJobFor(id);
      const job = isRecord2(jobPayload.job) ? jobPayload.job : {};
      const position = typeof job.position === "string" ? job.position.trim().toLowerCase() : "";
      const isDirector = position === "director" && Boolean(positiveId(job.id ?? job.company_id));
      if (!isDirector) {
        await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, job_json, updated_at) VALUES (?, ?, '8317', ?, 0, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, faction_id = excluded.faction_id, checked_at = excluded.checked_at, is_director = 0, company_id = NULL, company_name = NULL, company_type = NULL, company_type_id = NULL, company_rating = NULL, daily_income = NULL, weekly_income = NULL, job_json = excluded.job_json, profile_json = NULL, updated_at = excluded.updated_at").bind(id, name, checkedAt, asJson(jobPayload), checkedAt).run();
        continue;
      }
      const companyId = positiveId(job.id ?? job.company_id);
      let profile = null;
      try {
        profile = await client.getCompanyProfileById(companyId);
      } catch {
      }
      const root = companyProfileRoot(profile);
      const type = isRecord2(root.type) ? root.type : {};
      const jobTypeId = typeof job.type_id === "number" ? job.type_id : null;
      const companyName = typeof root.name === "string" ? root.name : typeof job.name === "string" ? job.name : `Company #${companyId}`;
      const companyType = typeof type.name === "string" ? type.name : null;
      const companyTypeId = typeof type.id === "number" ? type.id : jobTypeId;
      const rating = typeof root.rating === "number" ? root.rating : null;
      const income = isRecord2(root.income) ? root.income : {};
      const dailyIncome = typeof income.daily === "number" ? income.daily : null;
      const weeklyIncome = typeof income.weekly === "number" ? income.weekly : null;
      await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, company_id, company_name, company_type, company_type_id, company_rating, daily_income, weekly_income, job_json, profile_json, updated_at) VALUES (?, ?, '8317', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, faction_id = excluded.faction_id, checked_at = excluded.checked_at, is_director = 1, company_id = excluded.company_id, company_name = excluded.company_name, company_type = excluded.company_type, company_type_id = excluded.company_type_id, company_rating = excluded.company_rating, daily_income = excluded.daily_income, weekly_income = excluded.weekly_income, job_json = excluded.job_json, profile_json = COALESCE(excluded.profile_json, faction_member_cache.profile_json), updated_at = excluded.updated_at").bind(id, name, checkedAt, companyId, companyName, companyType, companyTypeId, rating, dailyIncome, weeklyIncome, asJson(jobPayload), profile === null ? null : asJson(profile), checkedAt).run();
      if (profile) await persistFactionDirectorSnapshot(env, profile);
    } catch {
      await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, updated_at) VALUES (?, ?, '8317', ?, 0, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, checked_at = excluded.checked_at, updated_at = excluded.updated_at").bind(id, name, checkedAt, checkedAt).run();
    }
  }
  const rows = await db.prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 ORDER BY company_type ASC, weekly_income DESC").all();
  return { processed, pending: Math.max(pending, 0), directors: rows.results ?? [] };
}
async function captureWeeklyFactionStarCounts(env, capturedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!env.DB) return;
  const db = requireDb(env);
  const captured = new Date(capturedAt);
  const weekKey = captured.toISOString().slice(0, 10);
  await db.prepare("CREATE TABLE IF NOT EXISTS faction_star_weekly_counts (week_key TEXT NOT NULL, star_rating INTEGER NOT NULL, company_count INTEGER NOT NULL, captured_at TEXT NOT NULL, PRIMARY KEY (week_key, star_rating))").run();
  const counts = await db.prepare("SELECT company_rating AS starRating, COUNT(DISTINCT company_id) AS companyCount FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 AND company_id IS NOT NULL AND company_rating IS NOT NULL GROUP BY company_rating ORDER BY company_rating ASC").all();
  for (const row of counts.results ?? []) {
    if (!Number.isInteger(row.starRating) || row.starRating < 0) continue;
    await db.prepare("INSERT INTO faction_star_weekly_counts (week_key, star_rating, company_count, captured_at) VALUES (?, ?, ?, ?) ON CONFLICT(week_key, star_rating) DO NOTHING").bind(weekKey, row.starRating, row.companyCount, capturedAt).run();
  }
}
async function getWeeklyFactionStarCounts(env) {
  const db = requireDb(env);
  await db.prepare("CREATE TABLE IF NOT EXISTS faction_star_weekly_counts (week_key TEXT NOT NULL, star_rating INTEGER NOT NULL, company_count INTEGER NOT NULL, captured_at TEXT NOT NULL, PRIMARY KEY (week_key, star_rating))").run();
  const latest = await db.prepare("SELECT week_key AS weekKey, MAX(captured_at) AS capturedAt FROM faction_star_weekly_counts GROUP BY week_key ORDER BY week_key DESC LIMIT 1").first();
  if (!latest) return { weeklyStarCounts: [], weeklyStarCountsCapturedAt: "" };
  const rows = await db.prepare("SELECT star_rating AS starRating, company_count AS companyCount FROM faction_star_weekly_counts WHERE week_key = ? ORDER BY star_rating ASC").bind(latest.weekKey).all();
  return { weeklyStarCounts: rows.results ?? [], weeklyStarCountsCapturedAt: latest.capturedAt };
}
async function refreshFactionDirectoryFromAnyKey(env, limit = 35) {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return;
  const row = await requireDb(env).prepare("SELECT player_id, ciphertext, iv FROM api_keys ORDER BY updated_at DESC LIMIT 1").first();
  if (!row) return;
  try {
    const apiKey = await decryptKey(env, row.ciphertext, row.iv);
    await syncFactionDirectorDirectory(env, apiKey, limit);
  } catch {
  }
}
async function refreshRankingProfiles(env) {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return { companiesChecked: 0, companiesFailed: 0 };
  const db = requireDb(env);
  const perCompany = await db.prepare("SELECT player_id, company_id, ciphertext, iv FROM company_api_keys ORDER BY updated_at ASC").all();
  const keys = perCompany.results ?? [];
  const keyedPlayers = new Set(keys.map((row) => row.player_id));
  const legacy = await db.prepare("SELECT player_id, ciphertext, iv FROM company_keys ORDER BY updated_at ASC").all();
  const work = [...keys, ...(legacy.results ?? []).filter((row) => !keyedPlayers.has(row.player_id)).map((row) => ({ ...row, company_id: "" }))];
  let companiesChecked = 0;
  let companiesFailed = 0;
  for (const keyRow of work) {
    try {
      const apiKey = await decryptKey(env, keyRow.ciphertext, keyRow.iv);
      const client = new TornApiClient({ apiKey });
      const { profile, employees: employeePayload, stock } = await client.getCompanySelections();
      const companyId = companyIdFromPayload(profile);
      if (!companyId || keyRow.company_id && String(companyId) !== keyRow.company_id) continue;
      const root = isRecord2(profile) && isRecord2(profile.company) ? profile.company : isRecord2(profile) && isRecord2(profile.profile) ? profile.profile : isRecord2(profile) ? profile : {};
      const type = isRecord2(root.type) ? root.type : {};
      const existing = await db.prepare("SELECT employees_json FROM companies WHERE player_id = ? AND company_id = ?").bind(keyRow.player_id, String(companyId)).first();
      const employees = employeePayload === null ? existing?.employees_json ?? "{}" : asJson(employeePayload);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(keyRow.player_id, String(companyId), String(root.name ?? `Company #${companyId}`), typeof type.name === "string" ? type.name : null, asJson(profile), employees, now).run();
      await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(keyRow.player_id, String(companyId), asJson(profile), employees, now).run();
      await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(keyRow.player_id, String(companyId), asJson(stock), now).run();
      await persistFactionDirectorSnapshot(env, profile, stock);
      companiesChecked += 1;
      await evaluateAutomationForCompany(env, keyRow.player_id, String(companyId)).catch(() => void 0);
    } catch (error) {
      companiesFailed += 1;
      await emitRefreshFailureAlerts(env, keyRow.player_id, keyRow.company_id || null, error).catch(() => void 0);
    }
  }
  return { companiesChecked, companiesFailed };
}
async function writeAdminAudit(env, actor, action, targetType, targetId, outcome, summary, details = {}) {
  try {
    await requireDb(env).prepare("INSERT INTO admin_audit_log (actor_player_id, actor_player_name, action, target_type, target_id, outcome, summary, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(actor.player_id, actor.player_name, action, targetType, targetId, outcome, summary.slice(0, 240), asJson(details), (/* @__PURE__ */ new Date()).toISOString()).run();
  } catch {
  }
}
function parseStoredJson(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
async function ensureAutomationSchema(env) {
  const db = requireDb(env);
  await db.prepare(`CREATE TABLE IF NOT EXISTS alert_rules (
    rule_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    company_id TEXT,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('income_drop', 'stale_data', 'refresh_failure', 'income_increase', 'rating_drop', 'roster_change')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    threshold_percent REAL NOT NULL DEFAULT 15,
    cooldown_hours INTEGER NOT NULL DEFAULT 24,
    stale_after_hours INTEGER NOT NULL DEFAULT 30,
    last_triggered_at TEXT,
    last_evaluated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS alert_events (
    event_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL REFERENCES alert_rules(rule_id) ON DELETE CASCADE,
    company_id TEXT,
    rule_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    previous_value REAL,
    current_value REAL,
    change_percent REAL,
    source_snapshot_at TEXT,
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'acknowledged')),
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_runs (
    run_id TEXT PRIMARY KEY,
    trigger_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    companies_checked INTEGER NOT NULL DEFAULT 0,
    companies_failed INTEGER NOT NULL DEFAULT 0,
    alerts_created INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_preferences (
    owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    browser_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_notifications_enabled IN (0, 1)),
    quiet_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_hours_enabled IN (0, 1)),
    quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
    quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    minimum_severity TEXT NOT NULL DEFAULT 'info' CHECK (minimum_severity IN ('info', 'warning', 'critical')),
    digest_mode TEXT NOT NULL DEFAULT 'instant' CHECK (digest_mode IN ('instant', 'daily', 'off')),
    updated_at TEXT NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_webhooks (
    owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_delivered_at TEXT,
    last_error TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_delivery_log (
    delivery_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES alert_events(event_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
    status_code INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_automation_delivery_owner_created ON automation_delivery_log(owner_player_id, created_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_alert_rules_owner_enabled ON alert_rules(owner_player_id, enabled, rule_type)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_alert_events_owner_status_created ON alert_events(owner_player_id, status, created_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC)").run();
}
function dailyIncomeFromProfile(payload) {
  const root = companyProfileRoot(payload);
  const income = isRecord2(root.income) ? root.income : null;
  const value = income?.daily;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function ratingFromProfile(payload) {
  const root = companyProfileRoot(payload);
  const value = root.rating ?? (isRecord2(root.company) ? root.company.rating : void 0);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function employeesFromPayload(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord2);
  if (!isRecord2(payload)) return [];
  const nested = Array.isArray(payload.employees) ? payload.employees : isRecord2(payload.employees) && Array.isArray(payload.employees.employees) ? payload.employees.employees : null;
  return nested ? nested.filter(isRecord2) : [];
}
function rosterCount(payload) {
  return employeesFromPayload(payload).length;
}
function numericField(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function severityRank(value) {
  return value === "critical" ? 3 : value === "warning" ? 2 : 1;
}
async function deliverAutomationWebhook(env, ownerPlayerId, alert) {
  const db = requireDb(env);
  try {
    const [hook, preferences] = await Promise.all([
      db.prepare("SELECT ciphertext, iv FROM automation_webhooks WHERE owner_player_id = ? AND enabled = 1").bind(ownerPlayerId).first(),
      db.prepare("SELECT minimum_severity AS minimumSeverity FROM automation_preferences WHERE owner_player_id = ?").bind(ownerPlayerId).first()
    ]);
    if (!hook) return { attempted: false, delivered: false, detail: "No webhook is configured." };
    if (preferences?.minimumSeverity && severityRank(alert.severity) < severityRank(preferences.minimumSeverity)) return { attempted: false, delivered: false, detail: "Alert is below the configured minimum severity." };
    const endpoint = await decryptKey(env, hook.ciphertext, hook.iv);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5e3);
    let statusCode;
    let detail = "";
    try {
      const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": "Naughty-Company-Dashboard/1.0" }, body: JSON.stringify({ source: "Naughty Company Dashboard", event: "automation.alert", alert }), signal: controller.signal });
      statusCode = response.status;
      if (!response.ok) detail = `Webhook endpoint returned HTTP ${response.status}.`;
      else detail = "Webhook delivered successfully.";
    } catch (error) {
      detail = error instanceof Error && error.name === "AbortError" ? "Webhook request timed out after 5 seconds." : "Webhook request failed. Check the endpoint and try again.";
    } finally {
      clearTimeout(timeout);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString(), delivered = statusCode !== void 0 && statusCode >= 200 && statusCode < 300;
    await db.prepare("INSERT INTO automation_delivery_log (delivery_id, owner_player_id, event_id, status, status_code, detail, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), ownerPlayerId, alert.eventId, delivered ? "delivered" : "failed", statusCode ?? null, detail, now, delivered ? now : null).run();
    await db.prepare("UPDATE automation_webhooks SET last_delivered_at = CASE WHEN ? = 1 THEN ? ELSE last_delivered_at END, last_error = ?, updated_at = ? WHERE owner_player_id = ?").bind(Number(delivered), now, delivered ? null : detail, now, ownerPlayerId).run();
    return { attempted: true, delivered, statusCode, detail };
  } catch {
    return { attempted: true, delivered: false, detail: "Webhook delivery could not be completed. Check the configured endpoint and encryption settings." };
  }
}
function validateWebhookUrl(value) {
  return normalizeWebhookUrl(value);
}
async function createAlertEvent(env, rule, input) {
  const db = requireDb(env);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const lastTriggered = rule.last_triggered_at ? Date.parse(rule.last_triggered_at) : Number.NaN;
  const cooldownHours = normalizeCooldownHours(rule.cooldown_hours);
  if (Number.isFinite(lastTriggered) && Date.now() - lastTriggered < cooldownHours * 36e5) return false;
  const dedupeKey = `${rule.rule_id}:${input.dedupeSuffix}`;
  const result = await db.prepare("INSERT OR IGNORE INTO alert_events (event_id, owner_player_id, rule_id, company_id, rule_type, severity, title, message, previous_value, current_value, change_percent, source_snapshot_at, status, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)").bind(crypto.randomUUID(), rule.owner_player_id, rule.rule_id, input.companyId ?? rule.company_id, rule.rule_type, input.severity, input.title.slice(0, 120), input.message.slice(0, 500), input.previousValue ?? null, input.currentValue ?? null, input.changePercent ?? null, input.sourceSnapshotAt ?? null, dedupeKey, now).run();
  const inserted = (result.meta?.changes ?? 0) > 0;
  if (inserted) await db.prepare("UPDATE alert_rules SET last_triggered_at = ?, updated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(now, now, rule.rule_id, rule.owner_player_id).run();
  return inserted;
}
async function evaluateAutomationForCompany(env, playerId, companyId) {
  await ensureAutomationSchema(env);
  const db = requireDb(env);
  const ruleResult = await db.prepare("SELECT * FROM alert_rules WHERE owner_player_id = ? AND enabled = 1 AND (company_id IS NULL OR company_id = ?)").bind(playerId, companyId).all();
  const rules = ruleResult.results ?? [];
  if (!rules.length) return;
  const snapshots = await db.prepare("SELECT profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? AND company_id = ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 2").bind(playerId, companyId).all();
  const rows = snapshots.results ?? [];
  const current = rows[0];
  const previous = rows[1];
  const currentIncome = current ? dailyIncomeFromProfile(parseStoredJson(current.profileJson)) : null;
  const previousIncome = previous ? dailyIncomeFromProfile(parseStoredJson(previous.profileJson)) : null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const rule of rules) {
    try {
      if (rule.rule_type === "income_drop" && current && previous) {
        const drop = evaluateIncomeDrop(previousIncome, currentIncome, rule.threshold_percent);
        if (drop) await createAlertEvent(env, rule, {
          severity: "warning",
          title: "Daily income dropped",
          message: `Daily income fell ${Math.abs(drop.changePercent).toFixed(1)}% since the previous successful company refresh.`,
          companyId,
          previousValue: previousIncome,
          currentValue: currentIncome,
          changePercent: drop.changePercent,
          sourceSnapshotAt: current.fetchedAt,
          dedupeSuffix: `income:${current.fetchedAt}`
        });
      }
      if (rule.rule_type === "income_increase" && current && previous && currentIncome !== null && previousIncome !== null && previousIncome > 0) {
        const rise = evaluateIncomeIncrease(previousIncome, currentIncome, rule.threshold_percent);
        if (rise) await createAlertEvent(env, rule, {
          severity: "info",
          title: "Daily income increased",
          message: `Daily income increased ${rise.changePercent.toFixed(1)}% since the previous successful company refresh.`,
          companyId,
          previousValue: previousIncome,
          currentValue: currentIncome,
          changePercent: rise.changePercent,
          sourceSnapshotAt: current.fetchedAt,
          dedupeSuffix: `income-rise:${current.fetchedAt}`
        });
      }
      if (rule.rule_type === "rating_drop" && current && previous) {
        const before = ratingFromProfile(parseStoredJson(previous.profileJson)), after = ratingFromProfile(parseStoredJson(current.profileJson));
        if (before !== null && after !== null && before > 0) {
          const drop = evaluatePercentageDrop(before, after, rule.threshold_percent);
          if (drop) await createAlertEvent(env, rule, {
            severity: "warning",
            title: "Company rating dropped",
            message: `Company rating decreased ${Math.abs(drop.changePercent).toFixed(1)}% between successful snapshots.`,
            companyId,
            previousValue: before,
            currentValue: after,
            changePercent: drop.changePercent,
            sourceSnapshotAt: current.fetchedAt,
            dedupeSuffix: `rating:${current.fetchedAt}`
          });
        }
      }
      if (rule.rule_type === "roster_change" && current && previous) {
        const before = rosterCount(parseStoredJson(previous.employeesJson)), after = rosterCount(parseStoredJson(current.employeesJson));
        const change = evaluateRosterChange(before, after, rule.threshold_percent);
        if (change) await createAlertEvent(env, rule, {
          severity: after < before ? "warning" : "info",
          title: after < before ? "Employee roster contracted" : "Employee roster grew",
          message: `Roster size changed from ${before} to ${after} employees (${change.changePercent > 0 ? "+" : ""}${change.changePercent.toFixed(1)}%) between successful snapshots.`,
          companyId,
          previousValue: before,
          currentValue: after,
          changePercent: change.changePercent,
          sourceSnapshotAt: current.fetchedAt,
          dedupeSuffix: `roster:${current.fetchedAt}`
        });
      }
      await db.prepare("UPDATE alert_rules SET last_evaluated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(now, rule.rule_id, playerId).run();
    } catch {
    }
  }
}
async function emitRefreshFailureAlerts(env, playerId, companyId, error) {
  await ensureAutomationSchema(env);
  const db = requireDb(env);
  const rows = await db.prepare("SELECT * FROM alert_rules WHERE owner_player_id = ? AND enabled = 1 AND rule_type = 'refresh_failure' AND (company_id IS NULL OR (? IS NOT NULL AND company_id = ?))").bind(playerId, companyId, companyId).all();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const detail = error instanceof Error ? error.message : "The refresh failed unexpectedly.";
  const safeDetail = detail.replace(/ApiKey\s+\S+/gi, "API key [redacted]").replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]").slice(0, 180);
  for (const rule of rows.results ?? []) {
    await createAlertEvent(env, rule, {
      severity: "critical",
      title: "Company refresh failed",
      message: `The scheduled company refresh did not complete. ${safeDetail || "Check the saved connection and retry."}`,
      companyId,
      sourceSnapshotAt: now,
      dedupeSuffix: `refresh-failure:${now.slice(0, 10)}`
    }).catch(() => false);
  }
}
async function evaluateStaleDataRules(env) {
  await ensureAutomationSchema(env);
  const db = requireDb(env);
  const result = await db.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND rule_type = 'stale_data'").all();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  for (const rule of result.results ?? []) {
    try {
      const latest = rule.company_id ? await db.prepare("SELECT company_id AS companyId, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? AND company_id = ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 1").bind(rule.owner_player_id, rule.company_id).first() : await db.prepare("SELECT company_id AS companyId, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 1").bind(rule.owner_player_id).first();
      if (!latest) {
        await createAlertEvent(env, rule, { severity: "warning", title: "No company snapshot available", message: "No successful company snapshot is available for this rule yet. Check the company connection and refresh status.", companyId: rule.company_id, dedupeSuffix: `no-snapshot:${now.slice(0, 10)}` });
      } else if (isSnapshotStale(latest.fetchedAt, nowMs, rule.stale_after_hours)) {
        const ageHours = Math.max(0, Math.floor((nowMs - Date.parse(latest.fetchedAt)) / 36e5));
        await createAlertEvent(env, rule, { severity: "warning", title: "Company data is stale", message: `The last successful company snapshot is ${ageHours} hours old. The configured limit is ${rule.stale_after_hours} hours.`, companyId: latest.companyId, sourceSnapshotAt: latest.fetchedAt, dedupeSuffix: `stale:${now.slice(0, 10)}` });
      }
      await db.prepare("UPDATE alert_rules SET last_evaluated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(now, rule.rule_id, rule.owner_player_id).run();
    } catch {
    }
  }
}
async function runScheduledAutomation(controller, env) {
  if (!env.DB) return;
  const db = requireDb(env);
  try {
    await ensureAutomationSchema(env);
  } catch {
    await Promise.allSettled([refreshRankingProfiles(env), refreshFactionDirectoryFromAnyKey(env, 35), refreshGlobalRankingCache(env)]);
    return;
  }
  const runId = crypto.randomUUID();
  const startedAt = new Date(controller.scheduledTime).toISOString();
  await db.prepare("INSERT INTO automation_runs (run_id, trigger_name, status, started_at) VALUES (?, ?, 'running', ?)").bind(runId, controller.cron || "scheduled", startedAt).run();
  const isWeeklyLock = new Date(controller.scheduledTime).getUTCDay() === 0;
  const tasks = [refreshRankingProfiles(env), refreshFactionDirectoryFromAnyKey(env, isWeeklyLock ? 250 : 35), refreshGlobalRankingCache(env)];
  if (isWeeklyLock) tasks.push(captureWeeklyFactionStarCounts(env, startedAt));
  const results = await Promise.allSettled(tasks);
  await evaluateStaleDataRules(env).catch(() => void 0);
  const refresh = results[0];
  const refreshSummary = refresh.status === "fulfilled" ? refresh.value : { companiesChecked: 0, companiesFailed: 0 };
  const failures = results.filter((item) => item.status === "rejected").map((item) => item.status === "rejected" ? item.reason instanceof Error ? item.reason.message : "A scheduled task failed." : "");
  const companiesChecked = Number(refreshSummary.companiesChecked ?? 0);
  const companiesFailed = Number(refreshSummary.companiesFailed ?? 0) + (refresh.status === "rejected" ? 1 : 0);
  const alerts = await db.prepare("SELECT COUNT(*) AS count FROM alert_events WHERE created_at >= ?").bind(startedAt).first().catch(() => null);
  const status = results.every((item) => item.status === "rejected") ? "failed" : failures.length || companiesFailed ? "partial" : "succeeded";
  const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  const summary = [...failures, ...companiesFailed ? [`${companiesFailed} company refresh(es) failed.`] : []].join(" ").slice(0, 500) || null;
  await db.prepare("UPDATE automation_runs SET status = ?, finished_at = ?, companies_checked = ?, companies_failed = ?, alerts_created = ?, error_summary = ? WHERE run_id = ?").bind(status, finishedAt, companiesChecked, companiesFailed, Number(alerts?.count ?? 0), summary, runId).run();
}
async function runAdminJob(env, jobId) {
  const db = requireDb(env);
  const job = await db.prepare("SELECT job_type, target_player_id, target_company_id FROM admin_jobs WHERE job_id = ?").bind(jobId).first();
  if (!job) return;
  const started = (/* @__PURE__ */ new Date()).toISOString();
  await db.prepare("UPDATE admin_jobs SET status = 'running', started_at = ? WHERE job_id = ? AND status = 'queued'").bind(started, jobId).run();
  try {
    let result;
    if (job.job_type === "company-refresh") {
      if (!job.target_player_id || !job.target_company_id) throw new Error("Refresh job is missing its company target.");
      let apiKey = await savedCompanyApiKey(env, job.target_player_id, job.target_company_id);
      if (!apiKey) apiKey = await savedCompanyKey(env, job.target_player_id);
      if (!apiKey) apiKey = await savedKey(env, job.target_player_id);
      if (!apiKey) throw new Error("No saved credential is available for this company.");
      const validated = await validateCompanyKey(apiKey);
      if (String(validated.companyId) !== job.target_company_id) throw new Error("The saved credential returned a different company ID. No data was changed.");
      await persistCompanyConnection(env, job.target_player_id, apiKey, validated);
      const root = companyProfileRoot(validated.profile);
      result = { companyId: String(validated.companyId), companyName: typeof root.name === "string" ? root.name : `Company #${validated.companyId}` };
    } else if (job.job_type === "global-refresh") {
      await refreshRankingProfiles(env);
      await refreshFactionDirectoryFromAnyKey(env, 35);
      await refreshGlobalRankingCache(env, void 0, true);
      result = { message: "Company rankings, faction directory batch, and global ranking cache refreshed." };
    } else {
      throw new Error("Unsupported administrative job type.");
    }
    await db.prepare("UPDATE admin_jobs SET status = 'completed', finished_at = ?, result_json = ?, error_message = NULL WHERE job_id = ?").bind((/* @__PURE__ */ new Date()).toISOString(), asJson(result), jobId).run();
    const actor = { player_id: "351311", player_name: "SharpSplinter" };
    await writeAdminAudit(env, actor, "job.completed", "job", jobId, "succeeded", `Administrative job ${job.job_type} completed.`, { jobType: job.job_type, targetPlayerId: job.target_player_id, targetCompanyId: job.target_company_id });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 220) : "The operation failed unexpectedly.";
    await db.prepare("UPDATE admin_jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE job_id = ?").bind((/* @__PURE__ */ new Date()).toISOString(), message, jobId).run();
    const actor = { player_id: "351311", player_name: "SharpSplinter" };
    await writeAdminAudit(env, actor, "job.failed", "job", jobId, "failed", `Administrative job ${job.job_type} failed.`, { jobType: job.job_type, targetPlayerId: job.target_player_id, targetCompanyId: job.target_company_id, error: message });
  }
}
async function adminBackupForPlayer(env, playerId) {
  const db = requireDb(env);
  await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
  const player = await db.prepare("SELECT player_id, player_name FROM players WHERE player_id = ?").bind(playerId).first();
  if (!player) throw new Error("That dashboard member does not exist.");
  const [companyRows, financialRows, snapshots, directorSnapshots, pageRows, sharingRows] = await Promise.all([
    db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(playerId).all(),
    db.prepare("SELECT company_id AS companyId, stock_json AS stockJson, fetched_at AS fetchedAt FROM company_financials WHERE player_id = ? ORDER BY fetched_at DESC").bind(playerId).all(),
    db.prepare("SELECT company_id AS companyId, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? ORDER BY fetched_at ASC").bind(playerId).all(),
    db.prepare("SELECT company_id AS companyId, snapshot_day AS snapshotDay, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? ORDER BY snapshot_day ASC").bind(playerId).all(),
    db.prepare("SELECT page_key AS pageKey, data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ?").bind(playerId).all(),
    db.prepare("SELECT recipient_player_id AS recipientId, share_financial_data AS shareFinancialData, share_employee_data AS shareEmployeeData, share_trend_data AS shareTrendData, updated_at AS updatedAt FROM company_sharing_recipients WHERE owner_player_id = ? ORDER BY recipient_player_id").bind(playerId).all()
  ]);
  const companies = (companyRows.results ?? []).map((row) => ({ companyId: String(row.companyId), companyName: row.companyName ?? null, companyType: row.companyType ?? null, profile: parseStoredJson(row.profileJson), employees: parseStoredJson(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }));
  const financials = (financialRows.results ?? []).map((row) => ({ companyId: String(row.companyId), stock: parseStoredJson(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }));
  const companySnapshots = (snapshots.results ?? []).map((row) => ({ companyId: String(row.companyId), profile: parseStoredJson(row.profileJson), employees: parseStoredJson(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }));
  const directorSnapshotData = (directorSnapshots.results ?? []).map((row) => ({ playerId, companyId: String(row.companyId), snapshotDay: String(row.snapshotDay), profile: parseStoredJson(row.profileJson), stock: parseStoredJson(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }));
  const pageData = (pageRows.results ?? []).map((row) => ({ pageKey: String(row.pageKey), data: parseStoredJson(row.dataJson), updatedAt: String(row.updatedAt ?? "") }));
  const sharingPreferences = (sharingRows.results ?? []).map((row) => ({ recipientId: String(row.recipientId), shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1, updatedAt: String(row.updatedAt ?? "") }));
  return { format: "naughty-company-dashboard-admin-backup", version: 1, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), player: { id: player.player_id, name: player.player_name }, storage: { companies, financials, companySnapshots, directorSnapshots: directorSnapshotData, pageData, sharingPreferences }, excluded: ["API credentials, session tokens, and administrator settings are never exported."] };
}
function adminBackupCounts(storage) {
  const count = (key) => Array.isArray(storage[key]) ? storage[key].length : 0;
  return { companies: count("companies"), financials: count("financials"), companySnapshots: count("companySnapshots"), directorSnapshots: count("directorSnapshots"), pageData: count("pageData"), sharingPreferences: count("sharingPreferences") };
}
async function restoreAdminBackup(env, targetPlayerId, parsed) {
  const db = requireDb(env);
  const storage = parsed.storage;
  await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
  const pageAllowlist = /* @__PURE__ */ new Set(["company", "employees", "charts", "rankings", "references", "settings"]);
  const counts = adminBackupCounts(storage);
  for (const item of (Array.isArray(storage.companies) ? storage.companies : []).slice(0, 100)) {
    if (!isRecord2(item)) continue;
    const companyId = positiveId(item.companyId ?? item.company_id);
    if (!companyId || item.profile === void 0) continue;
    const existing = await db.prepare("SELECT employees_json AS employeesJson, company_name AS companyName, company_type AS companyType, fetched_at AS fetchedAt FROM companies WHERE player_id = ? AND company_id = ?").bind(targetPlayerId, companyId).first();
    const profileRoot = companyProfileRoot(item.profile);
    const companyName = typeof item.companyName === "string" ? item.companyName : typeof profileRoot.name === "string" ? profileRoot.name : String(existing?.companyName ?? `Company #${companyId}`);
    const type = isRecord2(profileRoot.type) ? profileRoot.type : {};
    const companyType = typeof item.companyType === "string" ? item.companyType : typeof type.name === "string" ? type.name : existing?.companyType ?? null;
    const employees = item.employees !== void 0 ? item.employees : existing ? parseStoredJson(existing.employeesJson) : [];
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : String(existing?.fetchedAt ?? (/* @__PURE__ */ new Date()).toISOString());
    await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(targetPlayerId, String(companyId), companyName, companyType == null ? null : String(companyType), asJson(item.profile), asJson(employees), fetchedAt).run();
  }
  for (const item of (Array.isArray(storage.financials) ? storage.financials : []).slice(0, 100)) {
    if (!isRecord2(item)) continue;
    const companyId = positiveId(item.companyId);
    if (!companyId || item.stock === void 0) continue;
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(targetPlayerId, String(companyId), asJson(item.stock), fetchedAt).run();
  }
  for (const item of (Array.isArray(storage.companySnapshots) ? storage.companySnapshots : []).slice(0, 1e4)) {
    if (!isRecord2(item)) continue;
    const companyId = positiveId(item.companyId);
    if (!companyId || item.profile === void 0) continue;
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
    const existing = await db.prepare("SELECT snapshot_id FROM company_snapshots WHERE player_id = ? AND company_id = ? AND fetched_at = ? LIMIT 1").bind(targetPlayerId, String(companyId), fetchedAt).first();
    if (!existing) await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(targetPlayerId, String(companyId), asJson(item.profile), asJson(item.employees ?? []), fetchedAt).run();
  }
  for (const item of (Array.isArray(storage.directorSnapshots) ? storage.directorSnapshots : []).slice(0, 1e4)) {
    if (!isRecord2(item)) continue;
    const companyId = positiveId(item.companyId);
    const day = typeof item.snapshotDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.snapshotDay) ? item.snapshotDay : null;
    if (!companyId || !day || item.profile === void 0) continue;
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT OR IGNORE INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").bind(targetPlayerId, String(companyId), day, asJson(item.profile), item.stock == null ? null : asJson(item.stock), fetchedAt).run();
  }
  for (const item of (Array.isArray(storage.pageData) ? storage.pageData : []).slice(0, 20)) {
    if (!isRecord2(item) || typeof item.pageKey !== "string" || !pageAllowlist.has(item.pageKey)) continue;
    await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(targetPlayerId, item.pageKey, asJson(item.data), (/* @__PURE__ */ new Date()).toISOString()).run();
  }
  for (const item of (Array.isArray(storage.sharingPreferences) ? storage.sharingPreferences : []).slice(0, 1e3)) {
    if (!isRecord2(item)) continue;
    const recipientId = positiveId(item.recipientId ?? item.recipient_id ?? item.playerId);
    if (!recipientId || recipientId === targetPlayerId) continue;
    const recipient = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(recipientId).first();
    if (!recipient) continue;
    await db.prepare("INSERT INTO company_sharing_recipients (owner_player_id, recipient_player_id, share_financial_data, share_employee_data, share_trend_data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id, recipient_player_id) DO UPDATE SET share_financial_data = excluded.share_financial_data, share_employee_data = excluded.share_employee_data, share_trend_data = excluded.share_trend_data, updated_at = excluded.updated_at").bind(targetPlayerId, String(recipientId), Number(item.shareFinancialData === true || item.share_financial_data === 1), Number(item.shareEmployeeData === true || item.share_employee_data === 1), Number(item.shareTrendData === true || item.share_trend_data === 1), (/* @__PURE__ */ new Date()).toISOString()).run();
  }
  return counts;
}
async function handleAutomationRequest(request, env, origin) {
  const url = new URL(request.url);
  const rulesPath = url.pathname === "/api/me/alert-rules" || url.pathname.startsWith("/api/me/alert-rules/");
  const alertsPath = url.pathname === "/api/me/alerts" || url.pathname.startsWith("/api/me/alerts/");
  const preferencesPath = url.pathname === "/api/me/automation-preferences";
  const webhookPath = url.pathname === "/api/me/automation-webhook";
  const deliveriesPath = url.pathname === "/api/me/automation-webhook/deliveries";
  const retryMatch = url.pathname.match(/^\/api\/me\/automation-webhook\/retry\/([a-f0-9-]{36})$/i);
  if (!rulesPath && !alertsPath && !preferencesPath && !webhookPath && !deliveriesPath && !retryMatch) return null;
  const session = await authenticate(request, env);
  if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
  await ensureAutomationSchema(env);
  const db = requireDb(env);
  if (preferencesPath && request.method === "GET") {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT OR IGNORE INTO automation_preferences (owner_player_id, updated_at) VALUES (?, ?)").bind(session.player_id, now).run();
    const preferences = await db.prepare("SELECT browser_notifications_enabled AS browserNotificationsEnabled, quiet_hours_enabled AS quietHoursEnabled, quiet_hours_start AS quietHoursStart, quiet_hours_end AS quietHoursEnd, timezone, minimum_severity AS minimumSeverity, digest_mode AS digestMode, updated_at AS updatedAt FROM automation_preferences WHERE owner_player_id = ?").bind(session.player_id).first();
    return jsonResponse({ preferences: preferences ?? { browserNotificationsEnabled: 0, quietHoursEnabled: 0, quietHoursStart: "22:00", quietHoursEnd: "08:00", timezone: "UTC", minimumSeverity: "info", digestMode: "instant" } }, 200, origin);
  }
  if (webhookPath && request.method === "GET") {
    const row = await db.prepare("SELECT enabled, created_at AS createdAt, updated_at AS updatedAt, last_delivered_at AS lastDeliveredAt, last_error AS lastError FROM automation_webhooks WHERE owner_player_id = ?").bind(session.player_id).first();
    return jsonResponse({ configured: Boolean(row), webhook: row ? { enabled: Boolean(row.enabled), createdAt: row.createdAt, updatedAt: row.updatedAt, lastDeliveredAt: row.lastDeliveredAt, lastError: row.lastError } : null }, 200, origin);
  }
  if (webhookPath && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const endpoint = isRecord2(body) ? validateWebhookUrl(body.url) : null;
    if (!endpoint) return jsonResponse({ error: "Use a public HTTPS webhook URL without credentials, local hostnames, or private IP addresses." }, 400, origin);
    let encrypted;
    try {
      encrypted = await encryptKey(env, endpoint);
    } catch {
      return jsonResponse({ error: "Webhook encryption is not configured on this Worker." }, 503, origin);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT INTO automation_webhooks (owner_player_id, ciphertext, iv, enabled, created_at, updated_at, last_delivered_at, last_error) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL) ON CONFLICT(owner_player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, enabled = 1, updated_at = excluded.updated_at, last_error = NULL").bind(session.player_id, encrypted.ciphertext, encrypted.iv, now, now).run();
    return jsonResponse({ configured: true, saved: true, updatedAt: now }, 200, origin);
  }
  if (webhookPath && request.method === "DELETE") {
    await db.prepare("DELETE FROM automation_webhooks WHERE owner_player_id = ?").bind(session.player_id).run();
    return jsonResponse({ configured: false, deleted: true }, 200, origin);
  }
  if (deliveriesPath && request.method === "GET") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20) || 20));
    const rows = await db.prepare("SELECT delivery_id AS deliveryId, event_id AS eventId, status, status_code AS statusCode, detail, created_at AS createdAt, delivered_at AS deliveredAt FROM automation_delivery_log WHERE owner_player_id = ? ORDER BY created_at DESC LIMIT ?").bind(session.player_id, limit).all();
    return jsonResponse({ deliveries: rows.results ?? [] }, 200, origin);
  }
  if (retryMatch && request.method === "POST") {
    const event = await db.prepare("SELECT event_id AS eventId, rule_id AS ruleId, rule_type AS ruleType, severity, title, message, company_id AS companyId, created_at AS createdAt FROM alert_events WHERE event_id = ? AND owner_player_id = ?").bind(retryMatch[1], session.player_id).first();
    if (!event) return jsonResponse({ error: "Alert not found." }, 404, origin);
    const result = await deliverAutomationWebhook(env, session.player_id, event);
    return jsonResponse({ delivery: result }, result.attempted && !result.delivered ? 502 : 200, origin);
  }
  if (preferencesPath && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!isRecord2(body)) return jsonResponse({ error: "Provide automation notification preferences." }, 400, origin);
    const existing = await db.prepare("SELECT * FROM automation_preferences WHERE owner_player_id = ?").bind(session.player_id).first();
    const validTime = (value, fallback) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    const validZone = (value, fallback) => {
      if (typeof value !== "string" || value.length > 80) return fallback;
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return value;
      } catch {
        return fallback;
      }
    };
    const severity = ["info", "warning", "critical"].includes(String(body.minimumSeverity)) ? String(body.minimumSeverity) : String(existing?.minimum_severity ?? "info");
    const digest = ["instant", "daily", "off"].includes(String(body.digestMode)) ? String(body.digestMode) : String(existing?.digest_mode ?? "instant");
    const prefs = { browserNotificationsEnabled: Number(typeof body.browserNotificationsEnabled === "boolean" ? body.browserNotificationsEnabled : Boolean(existing?.browser_notifications_enabled)), quietHoursEnabled: Number(typeof body.quietHoursEnabled === "boolean" ? body.quietHoursEnabled : Boolean(existing?.quiet_hours_enabled)), quietHoursStart: validTime(body.quietHoursStart, String(existing?.quiet_hours_start ?? "22:00")), quietHoursEnd: validTime(body.quietHoursEnd, String(existing?.quiet_hours_end ?? "08:00")), timezone: validZone(body.timezone, String(existing?.timezone ?? "UTC")), minimumSeverity: severity, digestMode: digest };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT INTO automation_preferences (owner_player_id, browser_notifications_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone, minimum_severity, digest_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id) DO UPDATE SET browser_notifications_enabled = excluded.browser_notifications_enabled, quiet_hours_enabled = excluded.quiet_hours_enabled, quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end, timezone = excluded.timezone, minimum_severity = excluded.minimum_severity, digest_mode = excluded.digest_mode, updated_at = excluded.updated_at").bind(session.player_id, prefs.browserNotificationsEnabled, prefs.quietHoursEnabled, prefs.quietHoursStart, prefs.quietHoursEnd, prefs.timezone, prefs.minimumSeverity, prefs.digestMode, now).run();
    return jsonResponse({ preferences: { ...prefs, updatedAt: now }, saved: true }, 200, origin);
  }
  if (url.pathname === "/api/me/alert-rules" && request.method === "GET") {
    const rows = await db.prepare("SELECT r.rule_id AS ruleId, r.company_id AS companyId, r.rule_type AS ruleType, r.enabled AS enabled, r.threshold_percent AS thresholdPercent, r.cooldown_hours AS cooldownHours, r.stale_after_hours AS staleAfterHours, r.last_triggered_at AS lastTriggeredAt, r.last_evaluated_at AS lastEvaluatedAt, r.created_at AS createdAt, c.company_name AS companyName FROM alert_rules r LEFT JOIN companies c ON c.player_id = r.owner_player_id AND c.company_id = r.company_id WHERE r.owner_player_id = ? ORDER BY r.created_at DESC LIMIT 100").bind(session.player_id).all();
    return jsonResponse({ rules: rows.results ?? [] }, 200, origin);
  }
  if (url.pathname === "/api/me/alert-rules" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const type = isRecord2(body) && typeof body.ruleType === "string" ? body.ruleType : "";
    if (!["income_drop", "stale_data", "refresh_failure", "income_increase", "rating_drop", "roster_change"].includes(type)) return jsonResponse({ error: "Choose a supported alert type." }, 400, origin);
    const rawCompanyId = isRecord2(body) ? body.companyId : null;
    const companyId = rawCompanyId == null || rawCompanyId === "" ? null : positiveId(rawCompanyId);
    if (rawCompanyId != null && rawCompanyId !== "" && !companyId) return jsonResponse({ error: "Choose a valid company." }, 400, origin);
    if (companyId) {
      const owned = await db.prepare("SELECT company_id FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first();
      if (!owned) return jsonResponse({ error: "That company is not connected to your account." }, 403, origin);
    }
    const ruleId = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const threshold = normalizeAlertThreshold(isRecord2(body) ? body.thresholdPercent : void 0);
    const cooldown = normalizeCooldownHours(isRecord2(body) ? body.cooldownHours : void 0);
    const staleAfter = normalizeCooldownHours(isRecord2(body) ? body.staleAfterHours : void 0, 30);
    await db.prepare("INSERT INTO alert_rules (rule_id, owner_player_id, company_id, rule_type, enabled, threshold_percent, cooldown_hours, stale_after_hours, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)").bind(ruleId, session.player_id, companyId, type, threshold, cooldown, staleAfter, now, now).run();
    return jsonResponse({ ruleId, created: true }, 201, origin);
  }
  const ruleMatch = url.pathname.match(/^\/api\/me\/alert-rules\/([a-f0-9-]{36})$/i);
  if (ruleMatch && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const rule = await db.prepare("SELECT * FROM alert_rules WHERE rule_id = ? AND owner_player_id = ?").bind(ruleMatch[1], session.player_id).first();
    if (!rule) return jsonResponse({ error: "Alert rule not found." }, 404, origin);
    const enabled = isRecord2(body) && typeof body.enabled === "boolean" ? Number(body.enabled) : rule.enabled;
    const threshold = isRecord2(body) && body.thresholdPercent !== void 0 ? normalizeAlertThreshold(body.thresholdPercent) : rule.threshold_percent;
    const cooldown = isRecord2(body) && body.cooldownHours !== void 0 ? normalizeCooldownHours(body.cooldownHours) : rule.cooldown_hours;
    const staleAfter = isRecord2(body) && body.staleAfterHours !== void 0 ? normalizeCooldownHours(body.staleAfterHours, 30) : rule.stale_after_hours;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("UPDATE alert_rules SET enabled = ?, threshold_percent = ?, cooldown_hours = ?, stale_after_hours = ?, updated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(enabled, threshold, cooldown, staleAfter, now, rule.rule_id, session.player_id).run();
    return jsonResponse({ updated: true }, 200, origin);
  }
  if (ruleMatch && request.method === "DELETE") {
    const result = await db.prepare("DELETE FROM alert_rules WHERE rule_id = ? AND owner_player_id = ?").bind(ruleMatch[1], session.player_id).run();
    if (!(result.meta?.changes ?? 0)) return jsonResponse({ error: "Alert rule not found." }, 404, origin);
    return jsonResponse({ deleted: true }, 200, origin);
  }
  if (url.pathname === "/api/me/alerts" && request.method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50) || 50));
    const [rows, unread, latestRun] = await Promise.all([
      db.prepare("SELECT e.event_id AS eventId, e.rule_id AS ruleId, e.company_id AS companyId, e.rule_type AS ruleType, e.severity, e.title, e.message, e.previous_value AS previousValue, e.current_value AS currentValue, e.change_percent AS changePercent, e.source_snapshot_at AS sourceSnapshotAt, e.status, e.created_at AS createdAt, e.acknowledged_at AS acknowledgedAt, c.company_name AS companyName FROM alert_events e LEFT JOIN companies c ON c.player_id = e.owner_player_id AND c.company_id = e.company_id WHERE e.owner_player_id = ? ORDER BY e.created_at DESC LIMIT ?").bind(session.player_id, limit).all(),
      db.prepare("SELECT COUNT(*) AS count FROM alert_events WHERE owner_player_id = ? AND status = 'unread'").bind(session.player_id).first(),
      db.prepare("SELECT trigger_name AS triggerName, status, started_at AS startedAt, finished_at AS finishedAt, companies_checked AS companiesChecked, companies_failed AS companiesFailed, alerts_created AS alertsCreated FROM automation_runs ORDER BY started_at DESC LIMIT 1").first()
    ]);
    return jsonResponse({ events: rows.results ?? [], unreadCount: Number(unread?.count ?? 0), latestRun: latestRun ?? null }, 200, origin);
  }
  const acknowledgeMatch = url.pathname.match(/^\/api\/me\/alerts\/([a-f0-9-]{36})\/acknowledge$/i);
  if (acknowledgeMatch && request.method === "POST") {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const result = await db.prepare("UPDATE alert_events SET status = 'acknowledged', acknowledged_at = ? WHERE event_id = ? AND owner_player_id = ? AND status = 'unread'").bind(now, acknowledgeMatch[1], session.player_id).run();
    if (!(result.meta?.changes ?? 0)) {
      const existing = await db.prepare("SELECT event_id FROM alert_events WHERE event_id = ? AND owner_player_id = ?").bind(acknowledgeMatch[1], session.player_id).first();
      if (!existing) return jsonResponse({ error: "Alert not found." }, 404, origin);
    }
    return jsonResponse({ acknowledged: true }, 200, origin);
  }
  return jsonResponse({ error: "Automation route not found." }, 404, origin);
}
async function handleUserInsightsRequest(request, env, origin) {
  const url = new URL(request.url);
  const healthPath = url.pathname === "/api/me/health";
  const historyMatch = url.pathname.match(/^\/api\/me\/companies\/(\d+)\/history$/);
  const rosterPath = url.pathname === "/api/me/member-insights";
  const layoutPath = url.pathname === "/api/me/dashboard-layout";
  if (!healthPath && !historyMatch && !rosterPath && !layoutPath) return null;
  const session = await authenticate(request, env);
  if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
  const db = requireDb(env);
  if (healthPath && request.method === "GET") {
    const probeStartedAt = Date.now();
    const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      const databaseStartedAt = Date.now();
      const nowUtc = /* @__PURE__ */ new Date();
      const staleBeforeDate = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 18, 10, 0, 0));
      if (nowUtc.getTime() < staleBeforeDate.getTime()) staleBeforeDate.setUTCDate(staleBeforeDate.getUTCDate() - 1);
      const staleBefore = staleBeforeDate.toISOString();
      const [summary, rows] = await Promise.all([
        db.prepare("WITH connected AS (SELECT company_id AS companyId FROM companies WHERE player_id = ? UNION SELECT company_id AS companyId FROM company_api_keys WHERE player_id = ?), freshness AS (SELECT c.companyId, MAX(s.fetched_at) AS fetchedAt FROM connected c LEFT JOIN company_snapshots s ON s.player_id = ? AND s.company_id = c.companyId GROUP BY c.companyId) SELECT (SELECT COUNT(*) FROM connected) AS companyCount, (SELECT COUNT(*) FROM company_snapshots WHERE player_id = ?) AS snapshotCount, (SELECT MAX(fetched_at) FROM company_snapshots WHERE player_id = ?) AS latestSnapshotAt, (SELECT COUNT(*) FROM freshness WHERE fetchedAt IS NULL OR fetchedAt < ?) AS staleCompanies").bind(session.player_id, session.player_id, session.player_id, session.player_id, session.player_id, staleBefore).first(),
        db.prepare("WITH connected AS (SELECT c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType FROM companies c WHERE c.player_id = ? UNION ALL SELECT k.company_id AS companyId, k.company_name AS companyName, k.company_type AS companyType FROM company_api_keys k WHERE k.player_id = ? AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.player_id = k.player_id AND c.company_id = k.company_id)), snapshot_stats AS (SELECT company_id AS companyId, MAX(fetched_at) AS fetchedAt, COUNT(*) AS snapshotCount FROM company_snapshots WHERE player_id = ? GROUP BY company_id) SELECT c.companyId, c.companyName, c.companyType, s.fetchedAt, COALESCE(s.snapshotCount, 0) AS snapshotCount FROM connected c LEFT JOIN snapshot_stats s ON s.companyId = c.companyId ORDER BY s.fetchedAt DESC LIMIT 100").bind(session.player_id, session.player_id, session.player_id).all()
      ]);
      const databaseLatencyMs = Date.now() - databaseStartedAt;
      const now = Date.now();
      const companies = (rows.results ?? []).map((row) => {
        const timestamp = row.fetchedAt == null ? Number.NaN : Date.parse(String(row.fetchedAt));
        const preciseAgeHours = Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 36e5) : null;
        const ageHours = preciseAgeHours === null ? null : Math.round(preciseAgeHours * 10) / 10;
        return { ...row, ageHours, freshness: preciseAgeHours === null ? "never" : timestamp < Date.parse(staleBefore) ? "stale" : "fresh" };
      });
      return jsonResponse({ checkedAt, worker: { status: "ok", checkedAt, latencyMs: Date.now() - probeStartedAt }, database: { status: "ok", latencyMs: databaseLatencyMs }, summary: { companyCount: Number(summary?.companyCount ?? 0), snapshotCount: Number(summary?.snapshotCount ?? 0), latestSnapshotAt: summary?.latestSnapshotAt ?? null, staleCompanies: Number(summary?.staleCompanies ?? 0) }, companies }, 200, origin);
    } catch {
      return jsonResponse({ checkedAt, worker: { status: "ok", checkedAt, latencyMs: Date.now() - probeStartedAt }, database: { status: "error", latencyMs: Date.now() - probeStartedAt }, summary: { companyCount: 0, snapshotCount: 0, latestSnapshotAt: null, staleCompanies: 0 }, companies: [], error: "The health check could not query dashboard storage." }, 200, origin);
    }
  }
  if (historyMatch && request.method === "GET") {
    const companyId = historyMatch[1];
    const owned = await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first() ?? await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType FROM company_api_keys WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first();
    if (!owned) return jsonResponse({ error: "That company is not connected to your account." }, 404, origin);
    const requested = url.searchParams.get("days") || "90";
    const range = ["7", "30", "90", "365", "all"].includes(requested) ? requested : "90";
    const cutoff = range === "all" ? null : new Date(Date.now() - Number(range) * DAY * 1e3).toISOString();
    const cutoffSql = cutoff ? " AND fetched_at >= ?" : "";
    const historyQuery = db.prepare(`SELECT snapshotId, profileJson, employeesJson, fetchedAt FROM (SELECT snapshot_id AS snapshotId, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt, ROW_NUMBER() OVER (PARTITION BY substr(fetched_at, 1, 10) ORDER BY fetched_at DESC, snapshot_id DESC) AS dayRank FROM company_snapshots WHERE player_id = ? AND company_id = ?${cutoffSql}) WHERE dayRank = 1 ORDER BY fetchedAt ASC LIMIT 2000`);
    const raw = await (cutoff ? historyQuery.bind(session.player_id, companyId, cutoff) : historyQuery.bind(session.player_id, companyId)).all();
    const byDay = /* @__PURE__ */ new Map();
    for (const row of raw.results ?? []) {
      const profile = parseStoredJson(row.profileJson);
      const employees = parseStoredJson(row.employeesJson);
      const root = companyProfileRoot(profile);
      const income = isRecord2(root.income) ? root.income : {};
      const day = String(row.fetchedAt ?? "").slice(0, 10);
      if (!day) continue;
      byDay.set(day, { day, fetchedAt: row.fetchedAt, snapshotId: row.snapshotId, dailyIncome: dailyIncomeFromProfile(profile), weeklyIncome: numericField(income.weekly), rating: ratingFromProfile(profile), employeeCount: rosterCount(employees), employeeCapacity: isRecord2(root.employees) ? numericField(root.employees.capacity) : null });
    }
    const history = Array.from(byDay.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const first = history[0] ?? null, latest = history.at(-1) ?? null;
    const delta = (key) => first && latest && typeof first[key] === "number" && typeof latest[key] === "number" ? Number(latest[key]) - Number(first[key]) : null;
    const percent = (key) => first && latest && typeof first[key] === "number" && typeof latest[key] === "number" && Number(first[key]) !== 0 ? Math.round((Number(latest[key]) - Number(first[key])) / Number(first[key]) * 1e3) / 10 : null;
    return jsonResponse({ company: owned, range, history, summary: { snapshotCount: history.length, firstSnapshotAt: first?.fetchedAt ?? null, latestSnapshotAt: latest?.fetchedAt ?? null, dailyIncomeChange: delta("dailyIncome"), dailyIncomeChangePercent: percent("dailyIncome"), weeklyIncomeChange: delta("weeklyIncome"), ratingChange: delta("rating"), employeeCountChange: delta("employeeCount") } }, 200, origin);
  }
  if (rosterPath && request.method === "GET") {
    const requestedCompany = url.searchParams.get("companyId") || "";
    const company = requestedCompany ? await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, requestedCompany).first() : await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC LIMIT 1").bind(session.player_id).first();
    if (!company) return jsonResponse({ company: null, roster: [], summary: null, message: "Connect a company to see roster insights." }, 200, origin);
    const profile = parseStoredJson(company.profileJson), rawEmployees = employeesFromPayload(parseStoredJson(company.employeesJson));
    const root = companyProfileRoot(profile), profileEmployees = isRecord2(root.employees) ? root.employees : {};
    const roster = rawEmployees.map((employee) => {
      const position = isRecord2(employee.position) ? employee.position : {};
      const stats = isRecord2(employee.stats) ? employee.stats : {};
      const effectiveness = isRecord2(employee.effectiveness) ? employee.effectiveness : {};
      const status = isRecord2(employee.status) ? employee.status : {};
      const lastAction = isRecord2(employee.last_action) ? employee.last_action : {};
      return { id: String(employee.id ?? ""), name: typeof employee.name === "string" ? employee.name : "Unknown employee", position: typeof position.name === "string" ? position.name : "Unknown position", daysInCompany: numericField(employee.days_in_company), manualLabor: numericField(stats.manual_labor), intelligence: numericField(stats.intelligence), endurance: numericField(stats.endurance), wage: numericField(employee.wage), effectiveness: numericField(effectiveness.total), status: typeof status.description === "string" ? status.description : typeof status.state === "string" ? status.state : null, lastAction: typeof lastAction.relative === "string" ? lastAction.relative : typeof lastAction.status === "string" ? lastAction.status : null };
    }).sort((a, b) => a.position.localeCompare(b.position) || a.name.localeCompare(b.name));
    const average = (key) => {
      const values = roster.map((item) => item[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    const wages = roster.map((item) => item.wage).filter((value) => typeof value === "number" && Number.isFinite(value));
    const snapshots = await db.prepare("SELECT COUNT(*) AS count, MIN(fetched_at) AS firstAt, MAX(fetched_at) AS latestAt FROM company_snapshots WHERE player_id = ? AND company_id = ?").bind(session.player_id, String(company.companyId)).first();
    const positions = /* @__PURE__ */ new Map();
    for (const employee of roster) positions.set(employee.position, (positions.get(employee.position) ?? 0) + 1);
    return jsonResponse({ company: { companyId: company.companyId, companyName: company.companyName, companyType: company.companyType, fetchedAt: company.fetchedAt, employeesHired: numericField(profileEmployees.hired), employeeCapacity: numericField(profileEmployees.capacity) }, roster, summary: { rosterCount: roster.length, employeeCapacity: numericField(profileEmployees.capacity), averageManualLabor: average("manualLabor"), averageIntelligence: average("intelligence"), averageEndurance: average("endurance"), averageEffectiveness: average("effectiveness"), knownStatsCount: roster.filter((item) => item.manualLabor !== null && item.intelligence !== null && item.endurance !== null).length, knownWageCount: wages.length, totalKnownWages: wages.reduce((sum, value) => sum + value, 0), positions: Array.from(positions, ([position, count]) => ({ position, count })).sort((a, b) => b.count - a.count || a.position.localeCompare(b.position)), snapshotCount: Number(snapshots?.count ?? 0), firstSnapshotAt: snapshots?.firstAt ?? null, latestSnapshotAt: snapshots?.latestAt ?? null } }, 200, origin);
  }
  if (layoutPath && (request.method === "GET" || request.method === "POST")) {
    await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run();
    const key = "dashboard-layout";
    const allowed = /* @__PURE__ */ new Set(["company-health", "income-performance", "roster-overview", "recent-trends", "automation-status", "alerts", "rankings"]);
    if (request.method === "GET") {
      const row = await db.prepare("SELECT data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ? AND page_key = ?").bind(session.player_id, key).first();
      let layout = null;
      try {
        layout = row?.dataJson ? JSON.parse(String(row.dataJson)) : null;
      } catch {
        layout = null;
      }
      return jsonResponse({ layout, updatedAt: row?.updatedAt ?? null }, 200, origin);
    }
    const body = await request.json().catch(() => null);
    if (!isRecord2(body) || !Array.isArray(body.widgets) || body.widgets.length > 7) return jsonResponse({ error: "Provide a valid dashboard widget layout." }, 400, origin);
    const rawPreferences = isRecord2(body.dashboardPreferences) ? body.dashboardPreferences : {};
    const dashboardPreferences = {
      density: rawPreferences.density === "compact" ? "compact" : "comfortable",
      contentWidth: rawPreferences.contentWidth === "wide" ? "wide" : "standard"
    };
    const seen = /* @__PURE__ */ new Set(), widgets = [];
    for (const [index, value] of body.widgets.entries()) {
      if (!isRecord2(value) || typeof value.id !== "string" || !allowed.has(value.id) || seen.has(value.id)) return jsonResponse({ error: "The layout contains an unknown or duplicate widget." }, 400, origin);
      seen.add(value.id);
      widgets.push({ id: value.id, visible: value.visible !== false, order: index });
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(session.player_id, key, asJson({ widgets, dashboardPreferences }), now).run();
    return jsonResponse({ saved: true, layout: { widgets, dashboardPreferences }, updatedAt: now }, 200, origin);
  }
  return jsonResponse({ error: "Insights route not found." }, 404, origin);
}
async function handleAdminRequest(request, env, origin, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin")) return null;
  const session = await authenticate(request, env);
  if (!session) return jsonResponse({ error: "An active dashboard session is required." }, 401, origin);
  if (session.player_id !== ADMIN_PLAYER_ID) {
    await writeAdminAudit(env, session, "authorization.denied", "route", url.pathname, "denied", "A non-administrator attempted to access an administration route.");
    return jsonResponse({ error: "Administrator access is required." }, 403, origin);
  }
  const db = requireDb(env);
  await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
  const memberMatch = url.pathname.match(/^\/api\/admin\/members\/(\d+)(?:\/(status|connection-test|connection-repair))?$/);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50) || 50));
  if (url.pathname === "/api/admin/member-activity" && request.method === "GET") {
    const daysRaw = Number(url.searchParams.get("days") || 30), days = [7, 30, 90, 365].includes(daysRaw) ? daysRaw : 30;
    const cutoff = new Date(Date.now() - days * DAY * 1e3).toISOString();
    const [summary, recent] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS totalMembers, SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS activeMembers, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS newMembers, SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM companies c WHERE c.player_id = players.player_id) AND NOT EXISTS (SELECT 1 FROM company_api_keys k WHERE k.player_id = players.player_id) THEN 1 ELSE 0 END) AS withoutCompany FROM players").bind(cutoff, cutoff).first(),
      db.prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, p.created_at AS createdAt, p.updated_at AS lastActiveAt, (SELECT COUNT(*) FROM company_snapshots s WHERE s.player_id = p.player_id) AS snapshotCount, (SELECT MAX(c.fetched_at) FROM companies c WHERE c.player_id = p.player_id) AS latestCompanyAt FROM players p ORDER BY p.updated_at DESC LIMIT 50").all()
    ]);
    return jsonResponse({ rangeDays: days, summary: { totalMembers: Number(summary?.totalMembers ?? 0), activeMembers: Number(summary?.activeMembers ?? 0), newMembers: Number(summary?.newMembers ?? 0), withoutCompany: Number(summary?.withoutCompany ?? 0) }, members: recent.results ?? [], generatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
  }
  if (url.pathname === "/api/admin/automation/runs" && request.method === "GET") {
    await ensureAutomationSchema(env);
    const requestedRange = url.searchParams.get("days") || "30";
    const range = ["7", "30", "90", "365", "all"].includes(requestedRange) ? requestedRange : "30";
    const cutoff = range === "all" ? null : new Date(Date.now() - Number(range) * DAY * 1e3).toISOString();
    const where = cutoff ? "WHERE started_at >= ?" : "";
    const runQuery = db.prepare(`SELECT run_id AS runId, trigger_name AS triggerName, status, started_at AS startedAt, finished_at AS finishedAt, companies_checked AS companiesChecked, companies_failed AS companiesFailed, alerts_created AS alertsCreated, error_summary AS errorSummary FROM automation_runs ${where} ORDER BY started_at DESC LIMIT ?`);
    const summaryQuery = db.prepare(`SELECT COUNT(*) AS totalRuns, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeededRuns, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRuns, SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialRuns, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningRuns, SUM(CASE WHEN status IN ('succeeded', 'failed', 'partial') THEN 1 ELSE 0 END) AS completedRuns, AVG(CASE WHEN finished_at IS NOT NULL THEN CASE WHEN julianday(finished_at) >= julianday(started_at) THEN (julianday(finished_at) - julianday(started_at)) * 86400 ELSE 0 END END) AS avgDurationSeconds, SUM(companies_failed) AS companiesFailed, SUM(alerts_created) AS alertsCreated, MAX(started_at) AS latestRunAt FROM automation_runs ${where}`);
    const failuresWhere = cutoff ? "WHERE started_at >= ? AND status IN ('failed', 'partial') AND error_summary IS NOT NULL AND TRIM(error_summary) <> ''" : "WHERE status IN ('failed', 'partial') AND error_summary IS NOT NULL AND TRIM(error_summary) <> ''";
    const failuresQuery = db.prepare(`SELECT error_summary AS errorSummary, COUNT(*) AS occurrences FROM automation_runs ${failuresWhere} GROUP BY error_summary ORDER BY occurrences DESC, MAX(started_at) DESC LIMIT 3`);
    const [rows, rawSummary, failureRows] = await Promise.all([
      cutoff ? runQuery.bind(cutoff, limit).all() : runQuery.bind(limit).all(),
      cutoff ? summaryQuery.bind(cutoff).first() : summaryQuery.first(),
      cutoff ? failuresQuery.bind(cutoff).all() : failuresQuery.all()
    ]);
    const summary = rawSummary ?? {};
    const completedRuns = Number(summary.completedRuns ?? 0);
    const succeededRuns = Number(summary.succeededRuns ?? 0);
    const insights = {
      totalRuns: Number(summary.totalRuns ?? 0),
      succeededRuns,
      failedRuns: Number(summary.failedRuns ?? 0),
      partialRuns: Number(summary.partialRuns ?? 0),
      runningRuns: Number(summary.runningRuns ?? 0),
      completedRuns,
      successRate: completedRuns > 0 ? Math.round(succeededRuns / completedRuns * 1e3) / 10 : null,
      avgDurationSeconds: summary.avgDurationSeconds == null ? null : Math.round(Number(summary.avgDurationSeconds)),
      companiesFailed: Number(summary.companiesFailed ?? 0),
      alertsCreated: Number(summary.alertsCreated ?? 0),
      latestRunAt: summary.latestRunAt ?? null,
      recurringFailures: failureRows.results ?? []
    };
    return jsonResponse({ runs: rows.results ?? [], insights, range }, 200, origin);
  }
  if (url.pathname === "/api/admin/overview" && request.method === "GET") {
    const metrics = await db.prepare("SELECT (SELECT COUNT(*) FROM players) AS members, (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM company_api_keys) AS companyKeys, (SELECT COUNT(*) FROM company_snapshots) AS companySnapshots, (SELECT COUNT(*) FROM faction_director_snapshots) AS directorSnapshots, (SELECT COUNT(*) FROM dashboard_member_status WHERE disabled_at IS NOT NULL) AS disabledMembers, (SELECT COUNT(*) FROM admin_jobs WHERE status IN ('queued','running')) AS activeJobs, (SELECT COUNT(*) FROM admin_jobs WHERE status = 'failed') AS failedJobs, (SELECT MAX(fetched_at) FROM companies) AS latestCompanyRefresh").first();
    const recent = await db.prepare("SELECT id, actor_player_id AS actorPlayerId, actor_player_name AS actorPlayerName, action, target_type AS targetType, target_id AS targetId, outcome, summary, created_at AS createdAt FROM admin_audit_log ORDER BY id DESC LIMIT 8").all();
    return jsonResponse({ metrics: metrics ?? {}, maintenanceMode: await readAdminBoolean(env, "maintenanceMode", false), recentActivity: recent.results ?? [], generatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
  }
  if (url.pathname === "/api/admin/members" && request.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const like = `%${q}%`;
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
    const base = "FROM players p LEFT JOIN companies c ON c.player_id = p.player_id AND c.fetched_at = (SELECT MAX(c2.fetched_at) FROM companies c2 WHERE c2.player_id = p.player_id) LEFT JOIN faction_member_cache f ON f.player_id = p.player_id AND f.is_director = 1 LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE (? = '' OR p.player_id LIKE ? OR p.player_name LIKE ? OR COALESCE(c.company_name, f.company_name, '') LIKE ?)";
    const [rows, count] = await Promise.all([
      db.prepare(`SELECT p.player_id AS playerId, p.player_name AS playerName, p.created_at AS createdAt, p.updated_at AS updatedAt, COALESCE(c.company_id, f.company_id) AS companyId, COALESCE(c.company_name, f.company_name) AS companyName, COALESCE(c.company_type, f.company_type) AS companyType, f.company_type_id AS companyTypeId, st.disabled_at AS disabledAt, st.disable_reason AS disableReason, (SELECT COUNT(*) FROM api_keys ak WHERE ak.player_id = p.player_id) AS loginKeySaved, (SELECT COUNT(*) FROM company_api_keys cak WHERE cak.player_id = p.player_id) AS companyKeyCount, (SELECT COUNT(*) FROM company_snapshots cs WHERE cs.player_id = p.player_id) AS snapshotCount ${base} ORDER BY p.player_name COLLATE NOCASE LIMIT ? OFFSET ?`).bind(q, like, like, like, limit, offset).all(),
      db.prepare(`SELECT COUNT(*) AS total ${base}`).bind(q, like, like, like).first()
    ]);
    const members = (rows.results ?? []).map((r) => ({ playerId: String(r.playerId), playerName: String(r.playerName), createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null, companyId: r.companyId == null ? null : String(r.companyId), companyName: r.companyName == null ? null : String(r.companyName), companyType: r.companyType == null ? null : String(r.companyType), companyTypeId: r.companyTypeId ?? null, disabled: r.disabledAt != null, disabledAt: r.disabledAt ?? null, disableReason: r.disableReason ?? null, loginKeySaved: Number(r.loginKeySaved ?? 0) > 0, companyKeyCount: Number(r.companyKeyCount ?? 0), snapshotCount: Number(r.snapshotCount ?? 0) }));
    return jsonResponse({ members, total: Number(count?.total ?? 0), limit, offset }, 200, origin);
  }
  if (memberMatch && request.method === "GET" && !memberMatch[2]) {
    const playerId = memberMatch[1];
    const member = await db.prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, p.created_at AS createdAt, p.updated_at AS updatedAt, st.disabled_at AS disabledAt, st.disable_reason AS disableReason FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.player_id = ?").bind(playerId).first();
    if (!member) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin);
    const [companies, counts] = await Promise.all([
      db.prepare("SELECT cak.company_id AS companyId, COALESCE(c.company_name, cak.company_name) AS companyName, COALESCE(c.company_type, cak.company_type) AS companyType, cak.last_four AS lastFour, cak.updated_at AS keyUpdatedAt, c.fetched_at AS fetchedAt FROM company_api_keys cak LEFT JOIN companies c ON c.player_id = cak.player_id AND c.company_id = cak.company_id WHERE cak.player_id = ? ORDER BY cak.updated_at DESC").bind(playerId).all(),
      db.prepare("SELECT (SELECT COUNT(*) FROM company_snapshots WHERE player_id = ?) AS companySnapshots, (SELECT COUNT(*) FROM faction_director_snapshots WHERE player_id = ?) AS directorSnapshots, (SELECT COUNT(*) FROM user_page_data WHERE player_id = ?) AS pageRecords, (SELECT COUNT(*) FROM company_financials WHERE player_id = ?) AS financialRecords, (SELECT COUNT(*) FROM api_keys WHERE player_id = ?) AS loginKeyCount, (SELECT COUNT(*) FROM company_keys WHERE player_id = ?) AS legacyCompanyKeyCount").bind(playerId, playerId, playerId, playerId, playerId, playerId).first()
    ]);
    const profile = await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC LIMIT 1").bind(playerId).first();
    return jsonResponse({ member: { ...member, disabled: member.disabledAt != null, company: profile ?? null }, connections: { companies: companies.results ?? [], loginKeySaved: Number(counts?.loginKeyCount ?? 0) > 0, legacyCompanyKeySaved: Number(counts?.legacyCompanyKeyCount ?? 0) > 0 }, history: { companySnapshots: Number(counts?.companySnapshots ?? 0), directorSnapshots: Number(counts?.directorSnapshots ?? 0), pageRecords: Number(counts?.pageRecords ?? 0), financialRecords: Number(counts?.financialRecords ?? 0) } }, 200, origin);
  }
  if (memberMatch && memberMatch[2] === "status" && request.method === "POST") {
    const targetId = memberMatch[1];
    if (targetId === ADMIN_PLAYER_ID) return jsonResponse({ error: "The primary administrator account cannot be disabled from the admin panel." }, 409, origin);
    const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(targetId).first();
    if (!target) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin);
    const body = await request.json().catch(() => null);
    if (!isRecord2(body) || typeof body.disabled !== "boolean") return jsonResponse({ error: "Choose whether to disable or restore this member." }, 400, origin);
    const disabled = body.disabled;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 180) : "";
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT INTO dashboard_member_status (player_id, disabled_at, disabled_by, disable_reason, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET disabled_at = excluded.disabled_at, disabled_by = excluded.disabled_by, disable_reason = excluded.disable_reason, updated_at = excluded.updated_at").bind(targetId, disabled ? now : null, disabled ? session.player_id : null, disabled ? reason || "Disabled by dashboard administrator." : null, now).run();
    if (disabled) await db.prepare("DELETE FROM sessions WHERE player_id = ?").bind(targetId).run();
    await writeAdminAudit(env, session, disabled ? "member.disabled" : "member.restored", "member", targetId, "succeeded", disabled ? "Dashboard member access disabled and active sessions revoked." : "Dashboard member access restored.", { reason: disabled ? reason : null, sessionsRevoked: disabled });
    return jsonResponse({ playerId: targetId, disabled, sessionsRevoked: disabled, updatedAt: now }, 200, origin);
  }
  if (memberMatch && (memberMatch[2] === "connection-test" || memberMatch[2] === "connection-repair") && request.method === "POST") {
    const targetId = memberMatch[1];
    const body = await request.json().catch(() => null);
    const requestedCompanyId = isRecord2(body) && (typeof body.companyId === "string" || typeof body.companyId === "number") ? String(body.companyId) : "";
    const isRepair = memberMatch[2] === "connection-repair";
    try {
      let apiKey = requestedCompanyId ? await savedCompanyApiKey(env, targetId, requestedCompanyId) : null;
      if (!apiKey && !requestedCompanyId) apiKey = await savedCompanyKey(env, targetId);
      if (!apiKey) apiKey = await savedKey(env, targetId);
      if (!apiKey) return jsonResponse({ error: "No saved credential is available for this account. Ask the member to reconnect; never request their key in chat." }, 409, origin);
      const validated = await validateCompanyKey(apiKey);
      if (requestedCompanyId && String(validated.companyId) !== requestedCompanyId) throw new Error("The saved credential returned a different company ID. No data was changed.");
      if (isRepair) await persistCompanyConnection(env, targetId, apiKey, validated);
      const root = companyProfileRoot(validated.profile);
      const summary = { playerId: targetId, companyId: String(validated.companyId), companyName: typeof root.name === "string" ? root.name : `Company #${validated.companyId}`, profileValid: true, employeesAvailable: validated.employees !== null, stockAvailable: validated.stock !== null, repaired: isRepair, checkedAt: (/* @__PURE__ */ new Date()).toISOString() };
      await writeAdminAudit(env, session, isRepair ? "connection.repaired" : "connection.tested", "member", targetId, "succeeded", isRepair ? "Company connection validated and saved." : "Saved company connection test passed.", { companyId: String(validated.companyId) });
      return jsonResponse(summary, 200, origin);
    } catch (error) {
      await writeAdminAudit(env, session, isRepair ? "connection.repair_failed" : "connection.test_failed", "member", targetId, "failed", isRepair ? "Company connection repair failed." : "Saved company connection test failed.", { companyId: requestedCompanyId || null, error: error instanceof Error ? error.message.slice(0, 180) : "Unknown error" });
      return jsonResponse({ error: error instanceof Error ? error.message : "Company connection could not be verified." }, 502, origin);
    }
  }
  if (url.pathname === "/api/admin/jobs" && request.method === "GET") {
    const rows = await db.prepare("SELECT job_id AS jobId, job_type AS jobType, target_player_id AS targetPlayerId, target_company_id AS targetCompanyId, status, requested_by AS requestedBy, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, result_json AS resultJson, error_message AS errorMessage FROM admin_jobs ORDER BY created_at DESC LIMIT ?").bind(limit).all();
    return jsonResponse({ jobs: (rows.results ?? []).map((row) => ({ ...row, result: parseStoredJson(row.resultJson), resultJson: void 0 })) }, 200, origin);
  }
  if (url.pathname === "/api/admin/jobs" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!isRecord2(body) || body.jobType !== "global-refresh" && body.jobType !== "company-refresh") return jsonResponse({ error: "Choose a supported administrative job type." }, 400, origin);
    if (!await readAdminBoolean(env, "manualRefreshEnabled", true)) return jsonResponse({ error: "Manual refresh operations are disabled in global settings." }, 409, origin);
    const targetPlayerId = body.jobType === "company-refresh" ? positiveId(body.targetPlayerId) : null;
    const targetCompanyId = body.jobType === "company-refresh" ? positiveId(body.targetCompanyId) : null;
    if (body.jobType === "company-refresh" && (!targetPlayerId || !targetCompanyId)) return jsonResponse({ error: "Select a member and one of their saved company IDs for a company refresh." }, 400, origin);
    if (targetPlayerId) {
      const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(targetPlayerId).first();
      if (!target) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin);
    }
    const duplicate = await db.prepare("SELECT job_id FROM admin_jobs WHERE status IN ('queued','running') AND job_type = ? AND COALESCE(target_player_id,'') = ? AND COALESCE(target_company_id,'') = ? LIMIT 1").bind(body.jobType, targetPlayerId ? String(targetPlayerId) : "", targetCompanyId ? String(targetCompanyId) : "").first();
    if (duplicate) return jsonResponse({ error: "An equivalent refresh job is already queued or running.", jobId: duplicate.job_id }, 409, origin);
    const jobId = randomToken().slice(0, 20);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.prepare("INSERT INTO admin_jobs (job_id, job_type, target_player_id, target_company_id, status, requested_by, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").bind(jobId, body.jobType, targetPlayerId ? String(targetPlayerId) : null, targetCompanyId ? String(targetCompanyId) : null, session.player_id, now).run();
    await writeAdminAudit(env, session, "job.queued", "job", jobId, "succeeded", `Queued ${body.jobType}.`, { targetPlayerId: targetPlayerId ? String(targetPlayerId) : null, targetCompanyId: targetCompanyId ? String(targetCompanyId) : null });
    const task = runAdminJob(env, jobId);
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
    return jsonResponse({ jobId, status: "queued", createdAt: now }, 202, origin);
  }
  if (url.pathname === "/api/admin/settings" && request.method === "GET") {
    const rows = await db.prepare("SELECT setting_key AS settingKey, value_json AS valueJson, updated_at AS updatedAt, updated_by AS updatedBy FROM admin_settings").all();
    const settings = { maintenanceMode: false, manualRefreshEnabled: true, historyImportEnabled: true };
    for (const row of rows.results ?? []) {
      if (row.settingKey === "maintenanceMode" || row.settingKey === "manualRefreshEnabled" || row.settingKey === "historyImportEnabled") {
        const value = parseStoredJson(row.valueJson);
        if (typeof value === "boolean") settings[String(row.settingKey)] = value;
      }
    }
    return jsonResponse({ settings, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
  }
  if (url.pathname === "/api/admin/settings" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!isRecord2(body) || !isRecord2(body.settings)) return jsonResponse({ error: "Provide a settings object." }, 400, origin);
    const allowed = ["maintenanceMode", "manualRefreshEnabled", "historyImportEnabled"];
    const unknown = Object.keys(body.settings).filter((key) => !allowed.includes(key));
    if (unknown.length) return jsonResponse({ error: `Unsupported settings: ${unknown.join(", ")}.` }, 400, origin);
    for (const key of allowed) {
      if (body.settings[key] !== void 0 && typeof body.settings[key] !== "boolean") return jsonResponse({ error: `Setting ${key} must be true or false.` }, 400, origin);
    }
    const changed = [];
    for (const key of allowed) {
      if (body.settings[key] === void 0) continue;
      await db.prepare("INSERT INTO admin_settings (setting_key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by").bind(key, JSON.stringify(body.settings[key]), (/* @__PURE__ */ new Date()).toISOString(), session.player_id).run();
      changed.push(key);
    }
    await writeAdminAudit(env, session, "settings.updated", "settings", "global", "succeeded", "Updated global dashboard settings.", { changed });
    return jsonResponse({ saved: true, changed, settings: { maintenanceMode: await readAdminBoolean(env, "maintenanceMode", false), manualRefreshEnabled: await readAdminBoolean(env, "manualRefreshEnabled", true), historyImportEnabled: await readAdminBoolean(env, "historyImportEnabled", true) } }, 200, origin);
  }
  if (url.pathname === "/api/admin/history/summary" && request.method === "GET") {
    const stats = await db.prepare("SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM company_financials) AS financialRecords, (SELECT COUNT(*) FROM company_snapshots) AS companySnapshots, (SELECT COUNT(*) FROM faction_director_snapshots) AS directorSnapshots, (SELECT COUNT(*) FROM user_page_data) AS pageRecords").first();
    const latest = await db.prepare("SELECT MAX(fetched_at) AS latestCompanySnapshot FROM company_snapshots").first();
    return jsonResponse({ stats: stats ?? {}, latestCompanySnapshot: latest?.latestCompanySnapshot ?? null, backupMode: "owner-matched merge; credentials and sessions excluded" }, 200, origin);
  }
  if (url.pathname === "/api/admin/history/backup" && request.method === "GET") {
    const playerId = positiveId(url.searchParams.get("playerId"));
    if (!playerId) return jsonResponse({ error: "Select a valid dashboard member to export." }, 400, origin);
    try {
      const backup = await adminBackupForPlayer(env, String(playerId));
      await writeAdminAudit(env, session, "history.backup_exported", "member", String(playerId), "succeeded", "Exported a dashboard member backup; credentials and sessions were excluded.", { counts: adminBackupCounts(backup.storage) });
      return jsonResponse(backup, 200, origin, { "content-disposition": `attachment; filename="ncd-admin-backup-${playerId}.json"` });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Could not export this member's data." }, 404, origin);
    }
  }
  if (url.pathname === "/api/admin/history/restore" && request.method === "POST") {
    const targetPlayerId = positiveId(url.searchParams.get("playerId"));
    if (!targetPlayerId) return jsonResponse({ error: "Select the dashboard member whose history should be restored." }, 400, origin);
    const restoreTarget = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(String(targetPlayerId)).first();
    if (!restoreTarget) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin);
    if (!await readAdminBoolean(env, "historyImportEnabled", true)) return jsonResponse({ error: "History imports and restores are disabled in global settings." }, 409, origin);
    const raw = await request.text();
    if (raw.length > 1e7) return jsonResponse({ error: "The JSON backup is too large. Keep imports under 10 MB." }, 413, origin);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "Upload a valid JSON backup." }, 400, origin);
    }
    if (!isRecord2(parsed) || !isRecord2(parsed.player) || String(parsed.player.id ?? "") !== String(targetPlayerId) || !((parsed.format === "naughty-company-dashboard-admin-backup" || parsed.format === "naughty-company-dashboard-backup") && parsed.version === 1) || !isRecord2(parsed.storage)) {
      await writeAdminAudit(env, session, "history.restore_rejected", "member", String(targetPlayerId), "failed", "Rejected a backup with an unsupported format or owner mismatch.");
      return jsonResponse({ error: "Backup format or owner does not match the selected dashboard member. The restore was not applied." }, 400, origin);
    }
    const storage = parsed.storage;
    const counts = adminBackupCounts(storage);
    const limits = { companies: 100, financials: 100, companySnapshots: 1e4, directorSnapshots: 1e4, pageData: 20, sharingPreferences: 1e3 };
    for (const key of Object.keys(limits)) if (Array.isArray(storage[key]) && storage[key].length > limits[key]) return jsonResponse({ error: `Backup exceeds the supported ${key} limit.` }, 413, origin);
    if (url.searchParams.get("preview") === "1") {
      await writeAdminAudit(env, session, "history.restore_previewed", "member", String(targetPlayerId), "succeeded", "Validated a dashboard history restore without applying it.", { counts });
      return jsonResponse({ preview: true, targetPlayerId: String(targetPlayerId), counts, warnings: ["Restore merges records and does not delete existing records.", "API credentials, sessions, and administrator settings are excluded.", "Confirm the target Torn ID and backup timestamp before applying."] }, 200, origin);
    }
    const confirmation = request.headers.get("x-admin-confirm-restore");
    if (confirmation !== "yes") return jsonResponse({ error: "Restore requires explicit confirmation after preview." }, 428, origin);
    try {
      const restored = await restoreAdminBackup(env, String(targetPlayerId), parsed);
      await writeAdminAudit(env, session, "history.restore_applied", "member", String(targetPlayerId), "succeeded", "Restored a validated owner-matched backup by merging historical records.", { counts: restored, exportedAt: parsed.exportedAt ?? null });
      return jsonResponse({ restored: true, targetPlayerId: String(targetPlayerId), counts: restored, message: "Backup records were merged. Existing unrelated records, API credentials, and sessions were left intact." }, 200, origin);
    } catch (error) {
      await writeAdminAudit(env, session, "history.restore_failed", "member", String(targetPlayerId), "failed", "A validated history restore failed.", { counts, error: error instanceof Error ? error.message.slice(0, 180) : "Unknown error" });
      return jsonResponse({ error: "Restore could not be completed. Existing records were not intentionally deleted; inspect the audit log before retrying." }, 500, origin);
    }
  }
  if (url.pathname === "/api/admin/audit" && request.method === "GET") {
    const before = Math.max(0, Number(url.searchParams.get("before") || 0) || 0);
    const rows = before ? await db.prepare("SELECT id, actor_player_id AS actorPlayerId, actor_player_name AS actorPlayerName, action, target_type AS targetType, target_id AS targetId, outcome, summary, details_json AS detailsJson, created_at AS createdAt FROM admin_audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").bind(before, limit).all() : await db.prepare("SELECT id, actor_player_id AS actorPlayerId, actor_player_name AS actorPlayerName, action, target_type AS targetType, target_id AS targetId, outcome, summary, details_json AS detailsJson, created_at AS createdAt FROM admin_audit_log ORDER BY id DESC LIMIT ?").bind(limit).all();
    return jsonResponse({ events: (rows.results ?? []).map((row) => ({ ...row, details: parseStoredJson(row.detailsJson), detailsJson: void 0 })) }, 200, origin);
  }
  return jsonResponse({ error: "Administration route not found." }, 404, origin);
}
var index_default = {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledAutomation(controller, env));
  },
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request, env);
    if (!origin) return jsonResponse({ error: "Origin not allowed." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, X-Admin-Confirm-Restore", "access-control-max-age": "86400", vary: "Origin" } });
    const url = new URL(request.url);
    const adminResponse = await handleAdminRequest(request, env, origin, ctx);
    if (adminResponse) return adminResponse;
    const automationResponse = await handleAutomationRequest(request, env, origin);
    if (automationResponse) return automationResponse;
    const insightsResponse = await handleUserInsightsRequest(request, env, origin);
    if (insightsResponse) return insightsResponse;
    if (url.pathname === "/health" && request.method === "GET") {
      const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
      try {
        await requireDb(env).prepare("SELECT 1 AS ok").first();
        return jsonResponse({ ok: true, service: "naughty-company-api", database: "ok", checkedAt }, 200, origin);
      } catch {
        return jsonResponse({ ok: false, service: "naughty-company-api", database: "error", checkedAt }, 503, origin);
      }
    }
    if (url.pathname === "/api/auth/sign-in" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const apiKey = isRecord2(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const secondaryCompanyKey = isRecord2(body) && typeof body.secondaryCompanyKey === "string" ? body.secondaryCompanyKey.trim() : "";
        if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 400, origin);
        const player = await validateTornKey(apiKey);
        if (player.id !== ADMIN_PLAYER_ID) {
          const memberStatus = await requireDb(env).prepare("SELECT disabled_at FROM dashboard_member_status WHERE player_id = ?").bind(player.id).first();
          if (memberStatus?.disabled_at) return jsonResponse({ error: "Dashboard access for this account has been disabled. Contact the dashboard administrator." }, 403, origin);
          if (await readAdminBoolean(env, "maintenanceMode", false)) return jsonResponse({ error: "The dashboard is in maintenance mode. Please try again later." }, 503, origin);
        }
        const directorCheck = await inspectDirectorKey(apiKey, player.id);
        let loginCompanyData = null;
        let loginCompanyError = null;
        try {
          loginCompanyData = await validateCompanyKey(apiKey);
        } catch (error) {
          loginCompanyError = error instanceof Error ? error.message : "Company access could not be verified.";
        }
        const db = requireDb(env);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await db.prepare("INSERT INTO players (player_id, player_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, updated_at = excluded.updated_at").bind(player.id, player.name, now, now).run();
        await saveKey(env, player.id, apiKey);
        try {
          await refreshGlobalRankingCache(env, apiKey);
        } catch {
        }
        let selectedCompanyData = loginCompanyData;
        let selectedCompanyApiKey = selectedCompanyData ? apiKey : "";
        if (!selectedCompanyData && secondaryCompanyKey) {
          selectedCompanyData = await validateCompanyKey(secondaryCompanyKey);
          selectedCompanyApiKey = secondaryCompanyKey;
        }
        if (selectedCompanyData) await persistCompanyConnection(env, player.id, selectedCompanyApiKey, selectedCompanyData);
        const companyKey = await companyKeyMeta(env, player.id);
        const token = randomToken();
        const expiresAt = Math.floor(Date.now() / 1e3) + 30 * DAY;
        await db.prepare("INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), player.id, expiresAt, now).run();
        const meta = await db.prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(player.id).first();
        return jsonResponse({ token, expiresAt, player, isAdmin: player.id === ADMIN_PLAYER_ID, key: { saved: true, lastFour: meta?.last_four, updatedAt: meta?.updated_at }, company: { isDirector: directorCheck.isDirector, key: companyKey, needsSecondaryKey: !companyKey.saved } }, 200, origin);
      } catch (error) {
        return tornError(error, origin);
      }
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      let companyConnectionError = null;
      try {
        await ensurePrimaryCompanyConnection(env, session.player_id);
      } catch (error) {
        companyConnectionError = error instanceof Error ? error.message : "Company connection could not be verified.";
      }
      const key = await requireDb(env).prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(session.player_id).first();
      const companyKey = await companyKeyMeta(env, session.player_id);
      const cachedDirector = await requireDb(env).prepare("SELECT is_director FROM faction_member_cache WHERE player_id = ?").bind(session.player_id).first();
      const isDirector = cachedDirector?.is_director === 1;
      return jsonResponse({ player: { id: session.player_id, name: session.player_name }, isAdmin: session.player_id === ADMIN_PLAYER_ID, key: key ? { saved: true, lastFour: key.last_four, updatedAt: key.updated_at } : { saved: false }, company: { isDirector, key: companyKey, needsSecondaryKey: !companyKey.saved, connectionError: companyConnectionError } }, 200, origin);
    }
    if (url.pathname === "/api/auth/key" && request.method === "POST") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      try {
        const body = await request.json().catch(() => null);
        const apiKey = isRecord2(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 400, origin);
        const player = await validateTornKey(apiKey);
        if (player.id !== session.player_id) return jsonResponse({ error: "That key belongs to a different Torn player. Sign out and sign in as that player to switch accounts." }, 403, origin);
        await saveKey(env, player.id, apiKey);
        return jsonResponse({ saved: true, lastFour: apiKey.slice(-4), updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
      } catch (error) {
        return tornError(error, origin);
      }
    }
    if (url.pathname === "/api/auth/company-key" && request.method === "POST") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      try {
        const body = await request.json().catch(() => null);
        const apiKey = isRecord2(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey) return jsonResponse({ error: "A secondary company API key is required." }, 400, origin);
        const validated = await validateCompanyKey(apiKey);
        await saveCompanyApiKey(env, session.player_id, validated.companyId, apiKey, validated.profile);
        const root = isRecord2(validated.profile) && isRecord2(validated.profile.company) ? validated.profile.company : isRecord2(validated.profile) && isRecord2(validated.profile.profile) ? validated.profile.profile : {};
        const type = isRecord2(root.type) ? root.type : {};
        return jsonResponse({ saved: true, companyId: validated.companyId, companyName: typeof root.name === "string" ? root.name : `Company #${validated.companyId}`, companyType: typeof type.name === "string" ? type.name : null }, 200, origin);
      } catch (error) {
        return tornError(error, origin);
      }
    }
    if (url.pathname === "/api/auth/key" && request.method === "DELETE") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      await requireDb(env).prepare("DELETE FROM api_keys WHERE player_id = ?").bind(session.player_id).run();
      await requireDb(env).prepare("DELETE FROM company_keys WHERE player_id = ?").bind(session.player_id).run();
      await requireDb(env).prepare("DELETE FROM company_api_keys WHERE player_id = ?").bind(session.player_id).run();
      return jsonResponse({ deleted: true, companyDataRetained: true }, 200, origin);
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (token && env.DB) await requireDb(env).prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
      return jsonResponse({ signedOut: true }, 200, origin);
    }
    if (url.pathname === "/api/dashboard-members" && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      const rows = await requireDb(env).prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, (SELECT c.company_name FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyName, (SELECT c.company_type FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyType, (SELECT c.profile_json FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS profileJson, (SELECT f.company_type_id FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyTypeId, (SELECT f.company_name FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyName, (SELECT f.company_type FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyType FROM players p ORDER BY p.player_name COLLATE NOCASE").all();
      const members = (rows.results ?? []).map((row) => {
        let profile = null;
        try {
          profile = typeof row.profileJson === "string" ? JSON.parse(row.profileJson) : row.profileJson;
        } catch {
          profile = null;
        }
        const root = isRecord2(profile) && isRecord2(profile.company) ? profile.company : isRecord2(profile) && isRecord2(profile.profile) ? profile.profile : isRecord2(profile) ? profile : {};
        const type = isRecord2(root.type) ? root.type : {};
        const typeId = type.id ?? root.company_type_id ?? root.type_id ?? row.cachedCompanyTypeId ?? null;
        return {
          playerId: String(row.playerId),
          playerName: String(row.playerName ?? "Dashboard member"),
          companyName: row.companyName == null ? row.cachedCompanyName == null ? null : String(row.cachedCompanyName) : String(row.companyName),
          companyType: row.companyType == null ? row.cachedCompanyType == null ? null : String(row.cachedCompanyType) : String(row.companyType),
          companyTypeId: typeof typeId === "number" || typeof typeId === "string" ? typeId : null
        };
      });
      return jsonResponse({ members, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
    }
    if (url.pathname === "/api/me/data-sharing" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      const db = requireDb(env);
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
      if (request.method === "GET") {
        const rows = await db.prepare("SELECT p.player_id AS playerId, p.player_name AS directorName, COALESCE(NULLIF((SELECT c.company_name FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1), ''), (SELECT f.company_name FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1)) AS companyName, COALESCE(NULLIF((SELECT c.company_type FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1), ''), (SELECT f.company_type FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1)) AS companyType, COALESCE(r.share_financial_data, 0) AS shareFinancialData, COALESCE(r.share_employee_data, 0) AS shareEmployeeData, COALESCE(r.share_trend_data, 0) AS shareTrendData FROM players p LEFT JOIN company_sharing_recipients r ON r.recipient_player_id = p.player_id AND r.owner_player_id = ? WHERE p.player_id != ? ORDER BY p.player_name COLLATE NOCASE").bind(session.player_id, session.player_id).all();
        const recipients = (rows.results ?? []).map((row) => ({ playerId: String(row.playerId), directorName: String(row.directorName ?? "Dashboard member"), companyName: row.companyName == null ? null : String(row.companyName), companyType: row.companyType == null ? null : String(row.companyType), shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1 }));
        return jsonResponse({ recipients, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
      }
      const body = await request.json().catch(() => null);
      const supplied = isRecord2(body) ? body : {};
      const recipientId = positiveId(supplied.recipientId);
      if (!recipientId || recipientId === session.player_id) return jsonResponse({ error: "Select another dashboard member to manage sharing." }, 400, origin);
      const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(recipientId).first();
      if (!target) return jsonResponse({ error: "That member does not have a dashboard account." }, 404, origin);
      const permissions = { shareFinancialData: supplied.shareFinancialData === true, shareEmployeeData: supplied.shareEmployeeData === true, shareTrendData: supplied.shareTrendData === true };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await db.prepare("INSERT INTO company_sharing_recipients (owner_player_id, recipient_player_id, share_financial_data, share_employee_data, share_trend_data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id, recipient_player_id) DO UPDATE SET share_financial_data = excluded.share_financial_data, share_employee_data = excluded.share_employee_data, share_trend_data = excluded.share_trend_data, updated_at = excluded.updated_at").bind(session.player_id, recipientId, Number(permissions.shareFinancialData), Number(permissions.shareEmployeeData), Number(permissions.shareTrendData), now).run();
      return jsonResponse({ recipient: { playerId: recipientId, ...permissions }, updatedAt: now }, 200, origin);
    }
    if (url.pathname === "/api/faction/shared-company-data" && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      const db = requireDb(env);
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
      const rows = await db.prepare("SELECT c.player_id AS playerId, p.player_name AS directorName, c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType, c.profile_json AS profileJson, c.employees_json AS employeesJson, c.fetched_at AS fetchedAt, f.stock_json AS stockJson, s.share_financial_data AS shareFinancialData, s.share_employee_data AS shareEmployeeData, s.share_trend_data AS shareTrendData FROM company_sharing_recipients s JOIN companies c ON c.player_id = s.owner_player_id JOIN players p ON p.player_id = c.player_id LEFT JOIN company_financials f ON f.player_id = c.player_id AND f.company_id = c.company_id WHERE s.recipient_player_id = ? AND (s.share_financial_data = 1 OR s.share_employee_data = 1) ORDER BY c.company_type, c.company_name").bind(session.player_id).all();
      const shared = (rows.results ?? []).flatMap((row) => {
        try {
          const profilePayload = JSON.parse(String(row.profileJson));
          const profile = companyProfileRoot(profilePayload);
          const companyType = isRecord2(profile.type) && typeof profile.type.name === "string" ? profile.type.name : String(row.companyType ?? "Unknown");
          const rowTypeValue = isRecord2(profile.type) ? profile.type.id : null;
          const rowTypeId = typeof rowTypeValue === "number" ? rowTypeValue : typeof rowTypeValue === "string" && /^\d+$/.test(rowTypeValue) ? Number(rowTypeValue) : null;
          const result = {
            playerId: String(row.playerId),
            directorName: String(row.directorName ?? "Faction member"),
            companyId: String(row.companyId),
            companyName: String(profile.name ?? row.companyName ?? `Company #${row.companyId}`),
            companyType,
            companyTypeId: rowTypeId,
            fetchedAt: String(row.fetchedAt),
            shareFinancialData: row.shareFinancialData === 1,
            shareEmployeeData: row.shareEmployeeData === 1,
            shareTrendData: row.shareTrendData === 1
          };
          if (row.shareFinancialData === 1) {
            const adBudgetKeys = ["advertisement_budget", "advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"];
            const findAdBudget = (value, depth) => {
              if (!isRecord2(value) || depth > 5) return null;
              for (const key of adBudgetKeys) if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
              for (const child of Object.values(value)) {
                const found = findAdBudget(child, depth + 1);
                if (found !== null) return found;
              }
              return null;
            };
            const adBudget = findAdBudget(profile, 0);
            if (adBudget !== null) result.adBudget = adBudget;
            if (row.stockJson) {
              const stockPayload = JSON.parse(String(row.stockJson));
              const stockRoot = isRecord2(stockPayload) && Array.isArray(stockPayload.stock) ? stockPayload.stock : Array.isArray(stockPayload) ? stockPayload : isRecord2(stockPayload) && isRecord2(stockPayload.stock) ? Object.values(stockPayload.stock) : [];
              result.stock = stockRoot.filter(isRecord2).map((item) => {
                const sharedItem = {};
                if (typeof item.name === "string") sharedItem.name = item.name;
                for (const key of ["in_stock", "quantity", "amount"]) if (typeof item[key] === "number" && Number.isFinite(item[key])) {
                  sharedItem.quantity = item[key];
                  break;
                }
                for (const key of ["price", "sell_price", "selling_price", "price_per_unit", "cost", "unit_cost", "cost_per_unit"]) if (typeof item[key] === "number" && Number.isFinite(item[key])) {
                  sharedItem.unitPrice = item[key];
                  break;
                }
                return sharedItem;
              });
            }
          }
          if (row.shareEmployeeData === 1) {
            const employeesPayload = JSON.parse(String(row.employeesJson));
            const employeeRoot = isRecord2(employeesPayload) && Array.isArray(employeesPayload.employees) ? employeesPayload.employees : Array.isArray(employeesPayload) ? employeesPayload : isRecord2(employeesPayload) && isRecord2(employeesPayload.employees) ? Object.values(employeesPayload.employees) : [];
            result.employees = employeeRoot.filter(isRecord2).map((employee) => {
              const item = {};
              if (typeof employee.name === "string") item.name = employee.name;
              const position = isRecord2(employee.position) ? employee.position.name : employee.position_name ?? employee.position;
              if (typeof position === "string") item.position = position;
              const stats = isRecord2(employee.stats) ? employee.stats : {};
              const normalizedStats = {};
              const statFields = [["MAN", "manual_labor"], ["INT", "intelligence"], ["END", "endurance"]];
              for (const [shortName, sourceName] of statFields) if (typeof stats[sourceName] === "number" && Number.isFinite(stats[sourceName])) normalizedStats[shortName] = stats[sourceName];
              if (Object.keys(normalizedStats).length) item.stats = normalizedStats;
              const effectiveness = isRecord2(employee.effectiveness) ? employee.effectiveness.total : employee.effectiveness;
              const totalEffectiveness = [effectiveness, employee.effectiveness_total, employee.total_effectiveness].find((value) => typeof value === "number" && Number.isFinite(value));
              if (typeof totalEffectiveness === "number") item.effectiveness = totalEffectiveness;
              const wage = [employee.wage, employee.salary].find((value) => typeof value === "number" && Number.isFinite(value));
              if (typeof wage === "number") item.wage = wage;
              return item;
            });
          }
          return [result];
        } catch {
          return [];
        }
      });
      return jsonResponse({ companies: shared, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), scope: "explicitly shared with this dashboard user" }, 200, origin);
    }
    if (url.pathname === "/api/rankings" && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      if (url.searchParams.get("scope") === "global") {
        try {
          const userKey = await savedKey(env, session.player_id).catch(() => null);
          await refreshGlobalRankingCache(env, userKey ?? void 0);
        } catch {
        }
        const db = requireDb(env);
        await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run();
        const cached = await db.prepare("SELECT companies_json AS companiesJson, fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first();
        const snapshotCompanies = cached ? JSON.parse(cached.companiesJson) : [];
        const requestedType = (url.searchParams.get("type") ?? "").trim().toLocaleLowerCase();
        const requestedTypeIdRaw = url.searchParams.get("typeId");
        const requestedTypeId = requestedTypeIdRaw && /^\d+$/.test(requestedTypeIdRaw) ? Number(requestedTypeIdRaw) : null;
        const companies2 = requestedTypeId !== null ? snapshotCompanies.filter((company) => Number(company.companyTypeId) === requestedTypeId) : requestedType ? snapshotCompanies.filter((company) => String(company.companyType ?? "").trim().toLocaleLowerCase() === requestedType) : snapshotCompanies;
        return jsonResponse({ companies: companies2, generatedAt: cached?.fetchedAt ?? "", source: "Daily cached Torn API v2 company snapshot", scope: "all-torn", companyType: requestedType || null, companyTypeId: requestedTypeId, incomeDataUpdatesAt: "18:10 UTC daily", starRatingUpdatesAt: "18:10 UTC Sundays", cacheAvailable: Boolean(cached) }, 200, origin, { "cache-control": "private, max-age=300" });
      }
      const rows = await requireDb(env).prepare("SELECT c.player_id, c.company_id, c.company_name, c.company_type, c.profile_json, c.fetched_at, p.player_name FROM companies c JOIN players p ON p.player_id = c.player_id WHERE c.player_id = ? ORDER BY c.fetched_at DESC").bind(session.player_id).all();
      const companies = (rows.results ?? []).flatMap((row) => {
        try {
          const profile = JSON.parse(String(row.profile_json));
          const root = isRecord2(profile) && isRecord2(profile.company) ? profile.company : isRecord2(profile) && isRecord2(profile.profile) ? profile.profile : isRecord2(profile) ? profile : {};
          const income = isRecord2(root.income) ? root.income : {};
          const type = isRecord2(root.type) ? root.type : {};
          const weeklyIncome = typeof income.weekly === "number" && Number.isFinite(income.weekly) ? income.weekly : null;
          const dailyIncome = typeof income.daily === "number" && Number.isFinite(income.daily) ? income.daily : null;
          const rating = typeof root.rating === "number" && Number.isFinite(root.rating) ? root.rating : null;
          return [{ companyId: String(row.company_id), companyName: String(root.name ?? row.company_name ?? `Company #${row.company_id}`), companyType: String(type.name ?? row.company_type ?? "Unknown"), companyTypeId: type.id ?? null, starRating: rating, weeklyIncome, dailyIncome, averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7, directorName: String(row.player_name ?? "Unknown director"), playerId: String(row.player_id), fetchedAt: String(row.fetched_at) }];
        } catch {
          return [];
        }
      }).sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1));
      return jsonResponse({ companies, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), source: "Dashboard-connected Naughty Souls companies", scope: "faction", incomeDataUpdatesAt: "18:10 UTC daily", starRatingUpdatesAt: "18:10 UTC Sundays" }, 200, origin);
    }
    if (url.pathname === "/api/faction/directors" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      try {
        if (request.method === "POST") {
          const userKey = await savedKey(env, session.player_id).catch(() => null);
          if (!userKey) return jsonResponse({ error: "Save a Torn API key to refresh the faction directory." }, 400, origin);
          const synced = await syncFactionDirectorDirectory(env, userKey, 20);
          const weeklyCounts2 = await getWeeklyFactionStarCounts(env);
          return jsonResponse({ ...synced, syncing: false, ...weeklyCounts2, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), source: "Live Torn API directory refresh" }, 200, origin);
        }
        const rows = await requireDb(env).prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 ORDER BY company_type ASC, weekly_income DESC").all();
        const weeklyCounts = await getWeeklyFactionStarCounts(env);
        const directors = rows.results ?? [];
        const generatedAt = directors.map((director) => String(director.fetchedAt ?? "")).filter(Boolean).sort().at(-1) || weeklyCounts.weeklyStarCountsCapturedAt || "";
        return jsonResponse({ directors, processed: 0, pending: 0, syncing: false, ...weeklyCounts, generatedAt, source: "Daily cached Torn API snapshots" }, 200, origin);
      } catch (error) {
        return tornError(error, origin);
      }
    }
    if (url.pathname === "/api/faction/compare" && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      const playerId = positiveId(url.searchParams.get("playerId"));
      if (!playerId) return jsonResponse({ error: "Select a valid faction director to compare." }, 400, origin);
      const db = requireDb(env);
      const director = await db.prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE player_id = ? AND faction_id = '8317' AND is_director = 1").bind(playerId).first();
      if (!director) return jsonResponse({ error: "That faction member has not been confirmed as a company director yet. Refresh the faction directory and try again." }, 404, origin);
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
      let mayShareStock = playerId === session.player_id;
      let mayShareTrends = playerId === session.player_id;
      if (!mayShareStock || !mayShareTrends) {
        const sharing = await db.prepare("SELECT share_financial_data AS shareFinancialData, share_trend_data AS shareTrendData FROM company_sharing_recipients WHERE owner_player_id = ? AND recipient_player_id = ?").bind(playerId, session.player_id).first();
        mayShareStock = sharing?.shareFinancialData === 1;
        mayShareTrends = sharing?.shareTrendData === 1;
      }
      const snapshots = await db.prepare("SELECT snapshot_day AS day, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? AND company_id = ? ORDER BY snapshot_day ASC LIMIT 120").bind(playerId, String(director.companyId)).all();
      const history = (snapshots.results ?? []).map((row) => {
        let root = {};
        let stock = null;
        try {
          root = companyProfileRoot(JSON.parse(row.profileJson));
        } catch {
        }
        try {
          stock = mayShareStock && row.stockJson ? JSON.parse(row.stockJson) : null;
        } catch {
        }
        const income = isRecord2(root.income) ? root.income : {};
        const profit = isRecord2(root.profit) ? root.profit : {};
        const dailyProfit = [profit.daily, root.daily_profit, root.dailyProfit, root.profit_daily].find((value) => typeof value === "number" && Number.isFinite(value));
        const stockRows = Array.isArray(stock) ? stock : isRecord2(stock) && Array.isArray(stock.stock) ? stock.stock : [];
        const stockQuantity = stockRows.reduce((sum, item) => {
          if (!isRecord2(item)) return sum;
          const quantity = [item.in_stock, item.quantity, item.amount].find((value) => typeof value === "number" && Number.isFinite(value));
          return sum + (quantity ?? 0);
        }, 0);
        return { day: row.day, dailyIncome: typeof income.daily === "number" ? income.daily : null, weeklyIncome: typeof income.weekly === "number" ? income.weekly : null, dailyProfit: mayShareTrends ? dailyProfit ?? null : null, stockQuantity: stock === null ? null : stockQuantity, stock };
      });
      return jsonResponse({ director, history, stockHistoryAvailable: mayShareStock && history.some((row) => row.stock !== null), generatedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, origin);
    }
    if (url.pathname === "/api/me/data-backup" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      if (request.method === "POST" && !await readAdminBoolean(env, "historyImportEnabled", true)) return jsonResponse({ error: "History imports are disabled by the dashboard administrator." }, 409, origin);
      const db = requireDb(env);
      await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run();
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
      const parseStored = (value) => {
        try {
          return JSON.parse(String(value));
        } catch {
          return null;
        }
      };
      const allowedPages = /* @__PURE__ */ new Set(["company", "employees", "charts", "rankings", "references", "settings", "dashboard-layout"]);
      const upsertPageData = async (pageKey2, value) => {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(session.player_id, pageKey2, asJson(value), now).run();
      };
      const restoreCompanies = async (value) => {
        if (!Array.isArray(value)) return;
        for (const item of value.slice(0, 100)) {
          if (!isRecord2(item)) continue;
          const companyId = positiveId(item.companyId ?? item.company_id);
          if (!companyId) continue;
          const existing = await db.prepare("SELECT company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? AND company_id = ?").bind(session.player_id, companyId).first();
          const profile = item.profile !== void 0 ? item.profile : existing ? parseStored(existing.profileJson) : null;
          const employees = item.employees !== void 0 ? item.employees : existing ? parseStored(existing.employeesJson) : [];
          if (profile === null) continue;
          const profileRoot = companyProfileRoot(profile);
          const companyName = typeof item.companyName === "string" ? item.companyName : typeof profileRoot.name === "string" ? profileRoot.name : String(existing?.companyName ?? `Company #${companyId}`);
          const companyType = typeof item.companyType === "string" ? item.companyType : isRecord2(profileRoot.type) && typeof profileRoot.type.name === "string" ? profileRoot.type.name : existing?.companyType == null ? null : String(existing.companyType);
          const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : String(existing?.fetchedAt ?? (/* @__PURE__ */ new Date()).toISOString());
          await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(session.player_id, companyId, companyName, companyType, asJson(profile), asJson(employees), fetchedAt).run();
        }
      };
      const restoreFinancials = async (value) => {
        if (!Array.isArray(value)) return;
        for (const item of value.slice(0, 100)) {
          if (!isRecord2(item)) continue;
          const companyId = positiveId(item.companyId ?? item.company_id);
          if (!companyId || item.stock === void 0) continue;
          const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
          await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(session.player_id, companyId, asJson(item.stock), fetchedAt).run();
        }
      };
      const restoreSharing = async (value) => {
        if (!Array.isArray(value)) return;
        await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run();
        for (const item of value.slice(0, 1e3)) {
          if (!isRecord2(item)) continue;
          const recipientId = positiveId(item.recipientId ?? item.recipient_id ?? item.playerId);
          if (!recipientId || recipientId === session.player_id) continue;
          const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(recipientId).first();
          if (!target) continue;
          await db.prepare("INSERT INTO company_sharing_recipients (owner_player_id, recipient_player_id, share_financial_data, share_employee_data, share_trend_data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id, recipient_player_id) DO UPDATE SET share_financial_data = excluded.share_financial_data, share_employee_data = excluded.share_employee_data, share_trend_data = excluded.share_trend_data, updated_at = excluded.updated_at").bind(session.player_id, recipientId, Number(item.shareFinancialData === true || item.share_financial_data === 1), Number(item.shareEmployeeData === true || item.share_employee_data === 1), Number(item.shareTrendData === true || item.share_trend_data === 1), (/* @__PURE__ */ new Date()).toISOString()).run();
        }
      };
      if (request.method === "GET") {
        const [companyRows, financialRows, snapshotRows, directorSnapshotRows, pageRows, sharingRows] = await Promise.all([
          db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all(),
          db.prepare("SELECT company_id AS companyId, stock_json AS stockJson, fetched_at AS fetchedAt FROM company_financials WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all(),
          db.prepare("SELECT company_id AS companyId, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? ORDER BY fetched_at ASC").bind(session.player_id).all(),
          db.prepare("SELECT company_id AS companyId, snapshot_day AS snapshotDay, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? ORDER BY snapshot_day ASC").bind(session.player_id).all(),
          db.prepare("SELECT page_key AS pageKey, data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ?").bind(session.player_id).all(),
          db.prepare("SELECT recipient_player_id AS recipientId, share_financial_data AS shareFinancialData, share_employee_data AS shareEmployeeData, share_trend_data AS shareTrendData, updated_at AS updatedAt FROM company_sharing_recipients WHERE owner_player_id = ? ORDER BY recipient_player_id").bind(session.player_id).all()
        ]);
        const companies = (companyRows.results ?? []).map((row) => ({ companyId: String(row.companyId), companyName: row.companyName == null ? null : String(row.companyName), companyType: row.companyType == null ? null : String(row.companyType), profile: parseStored(row.profileJson), employees: parseStored(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }));
        const financials = (financialRows.results ?? []).map((row) => ({ companyId: String(row.companyId), stock: parseStored(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }));
        const companySnapshots = (snapshotRows.results ?? []).map((row) => ({ companyId: String(row.companyId), profile: parseStored(row.profileJson), employees: parseStored(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }));
        const directorSnapshots = (directorSnapshotRows.results ?? []).map((row) => ({ playerId: session.player_id, companyId: String(row.companyId), snapshotDay: String(row.snapshotDay), profile: parseStored(row.profileJson), stock: parseStored(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }));
        const pageData = (pageRows.results ?? []).map((row) => ({ pageKey: String(row.pageKey), data: parseStored(row.dataJson), updatedAt: String(row.updatedAt ?? "") }));
        const sharingPreferences = (sharingRows.results ?? []).map((row) => ({ recipientId: String(row.recipientId), shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1, updatedAt: String(row.updatedAt ?? "") }));
        const charts = pageData.find((row) => row.pageKey === "charts")?.data ?? null;
        const rankings = pageData.find((row) => row.pageKey === "rankings")?.data ?? {};
        const references = pageData.find((row) => row.pageKey === "references")?.data ?? {};
        const settings = pageData.find((row) => row.pageKey === "settings")?.data ?? {};
        const backup = {
          format: "naughty-company-dashboard-backup",
          version: 1,
          exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
          player: { id: session.player_id, name: session.player_name },
          pages: {
            company: { companies, financials },
            employees: { companies },
            charts: { history: charts, companySnapshots, directorSnapshots },
            rankings,
            references,
            settings: { sharingPreferences, preferences: settings }
          },
          storage: { companies, financials, companySnapshots, directorSnapshots, pageData, sharingPreferences },
          excluded: ["Torn API keys and session tokens are intentionally never exported."]
        };
        return jsonResponse(backup, 200, origin, { "cache-control": "no-store" });
      }
      const rawBody = await request.text();
      if (rawBody.length > 1e7) return jsonResponse({ error: "The JSON backup is too large. Keep imports under 10 MB." }, 413, origin);
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: "Upload a valid JSON file." }, 400, origin);
      }
      if (!isRecord2(parsed)) return jsonResponse({ error: "The JSON backup must contain an object at its root." }, 400, origin);
      const master = parsed.format === "naughty-company-dashboard-backup" && parsed.version === 1;
      const pageKey = master ? "master" : typeof parsed.pageKey === "string" ? parsed.pageKey : typeof parsed.page === "string" ? parsed.page : "charts";
      if (!master && pageKey !== "master" && !allowedPages.has(pageKey)) return jsonResponse({ error: "Unknown dashboard page in this JSON backup." }, 400, origin);
      if (master) {
        const owner = isRecord2(parsed.player) ? String(parsed.player.id ?? "") : "";
        if (!owner || owner !== session.player_id) return jsonResponse({ error: "This master backup belongs to a different dashboard account or has no account owner. Sign in to the matching account before restoring it." }, 403, origin);
        const storage = isRecord2(parsed.storage) ? parsed.storage : {};
        const pages = isRecord2(parsed.pages) ? parsed.pages : {};
        const chartPage = isRecord2(pages.charts) ? pages.charts : {};
        const chartHistory = chartPage.history;
        await restoreCompanies(storage.companies);
        await restoreFinancials(storage.financials);
        if (Array.isArray(storage.companySnapshots)) {
          for (const item of storage.companySnapshots.slice(0, 1e4)) {
            if (!isRecord2(item)) continue;
            const companyId = positiveId(item.companyId);
            if (!companyId || item.profile === void 0) continue;
            const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
            const exists = await db.prepare("SELECT snapshot_id FROM company_snapshots WHERE player_id = ? AND company_id = ? AND fetched_at = ? LIMIT 1").bind(session.player_id, companyId, fetchedAt).first();
            if (!exists) await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(session.player_id, companyId, asJson(item.profile), asJson(item.employees ?? []), fetchedAt).run();
          }
        }
        if (Array.isArray(storage.directorSnapshots)) {
          for (const item of storage.directorSnapshots.slice(0, 1e4)) {
            if (!isRecord2(item) || item.playerId != null && String(item.playerId) !== session.player_id) continue;
            const companyId = positiveId(item.companyId);
            const day = typeof item.snapshotDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.snapshotDay) ? item.snapshotDay : null;
            if (!companyId || !day || item.profile === void 0) continue;
            const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
            await db.prepare("INSERT OR IGNORE INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").bind(session.player_id, companyId, day, asJson(item.profile), item.stock === void 0 ? null : asJson(item.stock), fetchedAt).run();
          }
        }
        const pageData = Array.isArray(storage.pageData) ? storage.pageData : [];
        for (const item of pageData.slice(0, 20)) if (isRecord2(item) && typeof item.pageKey === "string" && allowedPages.has(item.pageKey)) await upsertPageData(item.pageKey, item.data);
        for (const key of ["rankings", "references", "settings"]) if (pages[key] !== void 0) await upsertPageData(key, pages[key]);
        if (chartHistory !== void 0 && chartHistory !== null) await upsertPageData("charts", chartHistory);
        const settingsPage = isRecord2(pages.settings) ? pages.settings : {};
        await restoreSharing(storage.sharingPreferences ?? settingsPage.sharingPreferences);
        await restoreSharing(settingsPage.sharingPreferences);
        return jsonResponse({ imported: true, scope: "master", companies: Array.isArray(storage.companies) ? storage.companies.length : 0, message: "Your personal dashboard records were restored. API keys and sessions were left untouched." }, 200, origin);
      }
      const data = isRecord2(parsed.data) ? parsed.data : parsed;
      if (pageKey === "charts") {
        const companies = isRecord2(data) && Array.isArray(data.companies) ? data.companies : null;
        if (!companies || !companies.every((company) => isRecord2(company) && (typeof company.companyId === "string" || typeof company.companyId === "number") && Array.isArray(company.history))) return jsonResponse({ error: "Chart imports must use the earlier history JSON format with a companies array and a history array for each company." }, 400, origin);
        await upsertPageData("charts", data);
      } else if (pageKey === "company" || pageKey === "employees") {
        if (!isRecord2(data) || !Array.isArray(data.companies)) return jsonResponse({ error: "This page import must be a dashboard page JSON export containing a companies array." }, 400, origin);
        await restoreCompanies(data.companies);
        if (pageKey === "company") await restoreFinancials(data.financials);
      } else if (pageKey === "settings") {
        if (!isRecord2(data)) return jsonResponse({ error: "Settings import must be a JSON object." }, 400, origin);
        if (Array.isArray(data.sharingPreferences)) await restoreSharing(data.sharingPreferences);
        await upsertPageData("settings", data);
      } else {
        await upsertPageData(pageKey, data);
      }
      return jsonResponse({ imported: true, page: pageKey, message: `Imported ${pageKey} JSON data.` }, 200, origin);
    }
    if (url.pathname === "/api/me/companies" && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      const rows = await requireDb(env).prepare("SELECT company_id, company_name, company_type, fetched_at FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all();
      const keys = await requireDb(env).prepare("SELECT company_id, company_name, company_type, updated_at FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC").bind(session.player_id).all();
      const merged = /* @__PURE__ */ new Map();
      for (const row of rows.results ?? []) merged.set(String(row.company_id), row);
      for (const row of keys.results ?? []) {
        const id = String(row.company_id);
        const current = merged.get(id);
        merged.set(id, { company_id: id, company_name: current?.company_name ?? row.company_name, company_type: current?.company_type ?? row.company_type, fetched_at: current?.fetched_at ?? row.updated_at, has_api_key: true });
      }
      return jsonResponse({ companies: Array.from(merged.values()).sort((a, b) => String(b.fetched_at ?? "").localeCompare(String(a.fetched_at ?? ""))) }, 200, origin);
    }
    const savedMatch = url.pathname.match(/^\/api\/me\/companies\/(\d+)$/);
    if (savedMatch && request.method === "GET") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      const id = Number(savedMatch[1]);
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "Invalid company ID." }, 400, origin);
      const row = await requireDb(env).prepare("SELECT company_id, company_name, company_type, profile_json, employees_json, fetched_at FROM companies WHERE player_id = ? AND company_id = ?").bind(session.player_id, String(id)).first();
      if (!row) return jsonResponse({ error: "No saved data for this company yet. Refresh it from the saved company key first." }, 404, origin);
      const financials = await requireDb(env).prepare("SELECT stock_json FROM company_financials WHERE player_id = ? AND company_id = ?").bind(session.player_id, String(id)).first();
      const snapshots = await requireDb(env).prepare("SELECT profile_json, fetched_at FROM company_snapshots WHERE player_id = ? AND company_id = ? AND fetched_at >= ? ORDER BY fetched_at ASC").bind(session.player_id, String(id), new Date(Date.now() - 40 * DAY * 1e3).toISOString()).all();
      const incomeHistory = (snapshots.results ?? []).map((snapshot) => {
        const saved = JSON.parse(snapshot.profile_json);
        const profile = isRecord2(saved.company) ? saved.company : isRecord2(saved.profile) ? saved.profile : saved;
        const income = isRecord2(profile.income) ? profile.income : {};
        return { fetchedAt: snapshot.fetched_at, dailyIncome: typeof income.daily === "number" && Number.isFinite(income.daily) ? income.daily : null };
      }).filter((snapshot) => snapshot.dailyIncome !== null);
      return jsonResponse({ companyId: row.company_id, companyName: row.company_name, companyType: row.company_type, profile: JSON.parse(String(row.profile_json)), employees: JSON.parse(String(row.employees_json)), stock: financials ? JSON.parse(financials.stock_json) : null, incomeHistory, fetchedAt: row.fetched_at }, 200, origin);
    }
    if (url.pathname === "/api/company/refresh" && request.method === "POST") {
      const session = await authenticate(request, env);
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin);
      if (!await readAdminBoolean(env, "manualRefreshEnabled", true)) return jsonResponse({ error: "Manual refreshes are disabled by the dashboard administrator." }, 409, origin);
      try {
        const refreshBody = await request.json().catch(() => null);
        const requestedId = isRecord2(refreshBody) && (typeof refreshBody.companyId === "string" || typeof refreshBody.companyId === "number") ? String(refreshBody.companyId) : "";
        let apiKey = requestedId ? await savedCompanyApiKey(env, session.player_id, requestedId) : null;
        if (!apiKey && !requestedId) apiKey = await savedCompanyKey(env, session.player_id);
        if (!apiKey) return jsonResponse({ error: requestedId ? "No saved API key for that company. Add its authorized company key first." : "No saved company API key is available. Add an authorized company key first." }, 409, origin);
        const client = new TornApiClient({ apiKey });
        const { profile, employees, stock } = await client.getCompanySelections();
        const companyId = companyIdFromPayload(profile);
        if (!companyId) return jsonResponse({ error: "Torn did not return a valid company ID for this API key's company profile." }, 502, origin);
        if (requestedId && String(companyId) !== requestedId) return jsonResponse({ error: "The saved key returned a different company ID than expected. No company data was changed." }, 409, origin);
        const profileObj = isRecord2(profile) && isRecord2(profile.company) ? profile.company : isRecord2(profile) && isRecord2(profile.profile) ? profile.profile : {};
        const companyName = typeof profileObj.name === "string" ? profileObj.name : `Company #${companyId}`;
        const type = profileObj.type;
        const companyType = isRecord2(type) && typeof type.name === "string" ? type.name : null;
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const db = requireDb(env);
        await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(session.player_id, String(companyId), companyName, companyType, asJson(profile), asJson(employees), now).run();
        await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(session.player_id, String(companyId), asJson(profile), asJson(employees), now).run();
        await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(session.player_id, String(companyId), asJson(stock), now).run();
        await persistFactionDirectorSnapshot(env, profile, stock);
        await saveCompanyApiKey(env, session.player_id, companyId, apiKey, profile);
        return jsonResponse({ companyId, companyName, companyType, profile, employees, stock, fetchedAt: now }, 200, origin);
      } catch (error) {
        return tornError(error, origin);
      }
    }
    const legacyRoute = url.pathname.match(/^\/api\/company\/(?:\d+\/)?(profile|employees|stock)$/);
    if (legacyRoute && request.method === "GET") {
      const apiKey = request.headers.get("Authorization")?.match(/^ApiKey\s+(.+)$/i)?.[1]?.trim() ?? "";
      if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 401, origin);
      try {
        const client = new TornApiClient({ apiKey });
        const data = legacyRoute[1] === "profile" ? await client.getCompanyProfile() : legacyRoute[1] === "employees" ? await client.getCompanyEmployees() : await client.getCompanyStock();
        return jsonResponse(data, 200, origin, { "cache-control": "private, no-store" });
      } catch (error) {
        return tornError(error, origin);
      }
    }
    return jsonResponse({ error: "Route not found." }, 404, origin);
  }
};
export {
  index_default as default
};
