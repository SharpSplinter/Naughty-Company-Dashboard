import liveFixtures from "./fixtures/torn-personalstats-live-sanitized.json"

const INTEGRATION_API_KEY = "synthetic-faction-performance-test-key"
const MEMBER_IDS = [980000001, 980000002, 980000003, 980000004, 980000005, 980000006]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}

function factionRoster() {
  return {
    members: MEMBER_IDS.map((id, index) => ({
      id,
      name: `Integration Member ${index + 1}`,
      position: index === 0 ? "Member" : "Enforcer",
      level: 100 + index,
      days_in_faction: 30 + index,
      last_action: {
        status: "Online",
        timestamp: 1794000000 + index,
        relative: "active now",
      },
      status: {
        description: "Okay",
        details: null,
        state: "Okay",
        until: null,
        color: "green",
      },
      is_revivable: false,
      revive_setting: "Friends & faction",
      is_on_wall: false,
      is_in_oc: false,
      has_early_discharge: false,
    })),
  }
}

function gymEnergyContributors() {
  return {
    contributors: MEMBER_IDS.map((id, index) => ({
      id,
      username: `Integration Member ${index + 1}`,
      value: 5000 + index * 250,
      in_faction: true,
    })),
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405)
    if (request.headers.get("Authorization") !== `ApiKey ${INTEGRATION_API_KEY}`) {
      return json({ error: { code: 2, error: "Invalid integration fixture key." } }, 401)
    }

    if (url.pathname === "/v2/faction/members" && url.searchParams.get("striptags") === "true") {
      return json(factionRoster())
    }
    if (url.pathname === "/v2/faction/contributors" && url.searchParams.get("stat") === "gymenergy") {
      return json(gymEnergyContributors())
    }
    if (/^\/v2\/user\/[1-9]\d*\/personalstats$/.test(url.pathname) && url.searchParams.get("cat") === "popular") {
      return json(liveFixtures.targetMemberPopular)
    }
    return json({ error: "Unknown integration fixture route." }, 404)
  },
}
