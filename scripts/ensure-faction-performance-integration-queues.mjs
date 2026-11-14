const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "6c03b978ed9a59adc3f61c715bdad45c"
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const QUEUE_NAMES = [
  "ncd-faction-performance-integration",
  "ncd-faction-performance-integration-dlq",
]

if (!API_TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is required.")
  process.exit(1)
}

async function cloudflareRequest(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) {
    const messages = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => item.message).filter(Boolean).join("; ")
      : "Cloudflare API request failed."
    throw new Error(`${response.status}: ${messages}`)
  }
  return payload
}

const existingPayload = await cloudflareRequest(
  `/accounts/${ACCOUNT_ID}/queues?page=1&per_page=100`,
)
const existingNames = new Set(
  (existingPayload.result ?? []).map((queue) => queue.queue_name),
)

for (const queueName of QUEUE_NAMES) {
  if (existingNames.has(queueName)) {
    console.log(`Queue already exists: ${queueName}`)
    continue
  }
  await cloudflareRequest(`/accounts/${ACCOUNT_ID}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: queueName }),
  })
  console.log(`Created isolated integration queue: ${queueName}`)
}
