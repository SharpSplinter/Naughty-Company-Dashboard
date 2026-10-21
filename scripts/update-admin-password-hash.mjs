import { pbkdf2Sync, randomBytes, webcrypto } from "node:crypto";
import { validateAdminPassword } from "../src/lib/admin-password-policy.js";

const password = process.env.ADMIN_PASSWORD_ONESHOT ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/naughty-company-api`;

if (!password || !token || !accountId) {
  console.error("A required recovery secret is missing; values were not displayed.");
  process.exit(1);
}
if (/[\u0000-\u001f\u007f]/u.test(password) || password !== password.trim()) {
  console.error("Use a single-line passphrase without leading or trailing whitespace.");
  process.exit(1);
}
const policy = validateAdminPassword(password);
if (!policy.valid) {
  console.error(`ADMIN_PASSWORD_ONESHOT fails the current password policy: ${policy.reason}`);
  process.exit(1);
}

// Use the same PBKDF2-HMAC-SHA256 parameters as the deployed Worker, then independently
// compare Node's result with Web Crypto before changing the production secret.
const salt = randomBytes(16);
const digest = pbkdf2Sync(password, salt, 210000, 32, "sha256");
const key = await webcrypto.subtle.importKey(
  "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
);
const webDigest = Buffer.from(await webcrypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 }, key, 256,
));
if (!digest.equals(webDigest)) {
  console.error("Independent PBKDF2 implementations disagreed; no Cloudflare secret was changed.");
  process.exit(1);
}

const encodedHash = [
  "pbkdf2-sha256",
  "210000",
  salt.toString("base64"),
  digest.toString("base64"),
].join("$");
delete process.env.ADMIN_PASSWORD_ONESHOT;

const headers = {
  Authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json",
};
async function readJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const versionsUrl = `${apiBase}/versions?per_page=100`;
const before = await readJson(versionsUrl);
if (!before.response.ok || before.body?.success !== true || !Array.isArray(before.body?.result?.items)) {
  console.error(`Could not inspect Worker versions before upload: HTTP ${before.response.status}. No secret was changed.`);
  process.exit(1);
}
const priorIds = new Set(before.body.result.items.map((item) => item?.id).filter(Boolean));
const uploadStartedAt = Date.now();

// Direct Cloudflare API upload avoids Wrangler's stdin/prompt interpretation.
const upload = await readJson(`${apiBase}/secrets`, {
  method: "PUT",
  body: JSON.stringify({
    name: "ADMIN_PASSWORD_HASH",
    type: "secret_text",
    text: encodedHash,
  }),
});
if (!upload.response.ok || upload.body?.success !== true ||
    upload.body?.result?.name !== "ADMIN_PASSWORD_HASH" ||
    upload.body?.result?.type !== "secret_text") {
  const codes = Array.isArray(upload.body?.errors)
    ? upload.body.errors.map((item) => item?.code).filter(Number.isFinite).join(",")
    : "";
  console.error(`Cloudflare API rejected the hash update: HTTP ${upload.response.status}; errorCodes=${codes || "unavailable"}. Values were not logged.`);
  process.exit(1);
}
console.log("Cloudflare accepted the ADMIN_PASSWORD_HASH secret update; value not logged.");

let newVersion = null;
for (let attempt = 0; attempt < 20; attempt++) {
  const latest = await readJson(versionsUrl);
  if (latest.response.ok && latest.body?.success === true && Array.isArray(latest.body?.result?.items)) {
    newVersion = latest.body.result.items.find((item) =>
      item?.id &&
      !priorIds.has(item.id) &&
      Date.parse(item?.metadata?.created_on ?? "") >= uploadStartedAt - 5000
    ) ?? null;
    if (newVersion) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!newVersion) {
  console.error("Cloudflare accepted the secret but the new Worker version could not be identified. Traffic was not changed.");
  process.exit(1);
}

// The secret API creates a version. Deploy the exact new version to 100% of traffic.
const deploy = await readJson(`${apiBase}/deployments`, {
  method: "POST",
  body: JSON.stringify({
    strategy: "percentage",
    versions: [{ version_id: newVersion.id, percentage: 100 }],
    annotations: { "workers/message": "Administrator credential recovery" },
  }),
});
// Cloudflare's Create Deployment endpoint returns the deployment object at the top level
// (unlike list endpoints which use the standard { success, result } envelope). Accept either
// shape, but still require the exact newly generated version at 100% traffic.
const deploymentResult = deploy.body?.result ?? deploy.body;
const deployContainsVersion = deploymentResult?.versions?.some((item) =>
  item?.version_id === newVersion.id && item?.percentage === 100
);
const deploySucceeded = deploy.response.ok &&
  (deploy.body?.success === true || typeof deploymentResult?.id === "string");
if (!deploySucceeded || !deployContainsVersion) {
  const codes = Array.isArray(deploy.body?.errors)
    ? deploy.body.errors.map((item) => item?.code).filter(Number.isFinite).join(",")
    : "";
  console.error(`Cloudflare did not confirm full deployment of the new Worker version: HTTP ${deploy.response.status}; errorCodes=${codes || "unavailable"}.`);
  process.exit(1);
}

// Verify the active deployment now points to the exact version we created.
const active = await readJson(`${apiBase}/deployments?per_page=1`);
const activeHasVersion = active.body?.result?.deployments?.[0]?.versions?.some((item) =>
  item?.version_id === newVersion.id && item?.percentage === 100
);
if (!active.response.ok || active.body?.success !== true || !activeHasVersion) {
  console.error("Cloudflare accepted the deployment but the active deployment did not confirm the new version at 100% traffic.");
  process.exit(1);
}
console.log(`Cloudflare confirmed Worker version ${newVersion.number} is active at 100% traffic. Password and hash were not logged.`);
