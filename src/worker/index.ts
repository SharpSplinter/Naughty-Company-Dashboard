import { TornApiClient, TornApiClientError } from "../lib/torn/client"

type WorkerEnv = {
  ALLOWED_ORIGIN?: string
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
}

function jsonResponse(
  body: unknown,
  status = 200,
  origin = "null",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...jsonHeaders,
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      vary: "Origin",
      ...extraHeaders,
    },
  })
}

function allowedOrigin(request: Request, env: WorkerEnv): string | null {
  const incoming = request.headers.get("Origin")
  if (!incoming) return "null"

  const configured = env.ALLOWED_ORIGIN?.trim()
  if (configured && configured !== "*" && incoming === configured) return incoming

  try {
    const url = new URL(incoming)
    const isDashboard = url.protocol === "https:" &&
      /^(?:[a-z0-9-]+\.)?naughty-company-dashboard\.pages\.dev$/.test(url.hostname)
    const isLocalDev = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === "3000"
    return isDashboard || isLocalDev ? incoming : null
  } catch {
    return null
  }
}

function parseCompanyRoute(pathname: string): {
  companyId: number
  resource: "profile" | "employees"
} | null {
  const match = pathname.match(/^\/api\/company\/(\d+)\/(profile|employees)$/)
  if (!match) return null

  const companyId = Number(match[1])
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return null

  return { companyId, resource: match[2] as "profile" | "employees" }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = allowedOrigin(request, env)
    if (!origin) {
      return jsonResponse({ error: "Origin not allowed." }, 403)
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-max-age": "86400",
          vary: "Origin",
        },
      })
    }

    const url = new URL(request.url)
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405, origin, {
        allow: "GET, OPTIONS",
      })
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "naughty-company-api" }, 200, origin)
    }

    const route = parseCompanyRoute(url.pathname)
    if (!route) {
      return jsonResponse({ error: "Route not found." }, 404, origin)
    }

    const authorization = request.headers.get("Authorization")
    const apiKey = authorization?.startsWith("ApiKey ")
      ? authorization.slice("ApiKey ".length).trim()
      : ""

    if (!apiKey) {
      return jsonResponse(
        { error: "A Torn API key is required. Send it in the Authorization: ApiKey header." },
        401,
        origin,
      )
    }

    try {
      const client = new TornApiClient({ apiKey })
      const data =
        route.resource === "profile"
          ? await client.getCompanyProfile(route.companyId)
          : await client.getCompanyEmployees(route.companyId)

      return jsonResponse(data, 200, origin, {
        "cache-control": "private, no-store",
      })
    } catch (error) {
      if (error instanceof TornApiClientError) {
        const headers: Record<string, string> = {}
        if (error.retryAfter) headers["retry-after"] = error.retryAfter
        return jsonResponse({ error: error.message }, error.status, origin, headers)
      }

      return jsonResponse({ error: "Unexpected server error." }, 500, origin)
    }
  },
}
