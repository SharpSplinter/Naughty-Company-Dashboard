import liveFixtures from "./fixtures/torn-personalstats-live-sanitized.json"

const INTEGRATION_API_KEY = "synthetic-faction-performance-test-key"
const PRIVATE_LIVE_API_KEY = "synthetic-private-live-staging-owner-key"
const PRIVATE_LIVE_OWNER_ID = 980000009
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

function factionStats() {
  return {
    stats: [
      { name: "medicalitemsused", value: 11 },
      { name: "attackswon", value: 23 },
      { name: "organisedcrimemoney", value: 123456789 },
      { name: "highestterritories", value: 17 },
      { name: "membersamount", value: 6 },
    ],
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405)
    const authorization = request.headers.get("Authorization")
    if (url.pathname === "/v2/key/info") {
      if (authorization === `ApiKey ${PRIVATE_LIVE_API_KEY}`) {
        return json({ info: { user: { id: PRIVATE_LIVE_OWNER_ID }, access: { type: "Custom Access" } } })
      }
      if (authorization === `ApiKey ${INTEGRATION_API_KEY}`) {
        return json({ info: { user: { id: 351311 }, access: { type: "Full Access" }, selections: {} } })
      }
      return json({ error: { code: 2, error: "Invalid integration fixture key." } }, 401)
    }
    const privateLiveRoute = url.pathname === "/v2/user/bars" ||
      url.pathname === "/v2/user/cooldowns" ||
      url.pathname === "/v2/user/networth"
    const expectedKey = privateLiveRoute ? PRIVATE_LIVE_API_KEY : INTEGRATION_API_KEY
    if (authorization !== `ApiKey ${expectedKey}`) {
      return json({ error: { code: 2, error: "Invalid integration fixture key." } }, 401)
    }
    if (url.pathname === "/v2/user/bars") {
      return json({ bars: {
        energy: { current: 91, maximum: 100 },
        nerve: { current: 42, maximum: 60 },
        happy: { current: 4500, maximum: 5000 },
        life: { current: 875, maximum: 1000 },
      } })
    }
    if (url.pathname === "/v2/user/cooldowns") {
      return json({ cooldowns: { drug: 120, booster: 0, medical: 60 } })
    }
    if (url.pathname === "/v2/user/networth") {
      return json({ networth: { total: 987654321, wallet: 12345, bank: 123456789 }, timestamp: 1793671200 })
    }

    if (url.pathname === "/v2/faction/members" && url.searchParams.get("striptags") === "true") {
      return json(factionRoster())
    }
    if (url.pathname === "/v2/faction/contributors" && url.searchParams.get("stat") === "gymenergy") {
      return json(gymEnergyContributors())
    }
    if (url.pathname === "/v2/faction/stats") return json(factionStats())
    const personalStatsMatch = url.pathname.match(/^\/v2\/user\/([1-9]\d*)\/personalstats$/)
    if (personalStatsMatch && url.searchParams.get("cat") === "popular") {
      if (personalStatsMatch[1] === "980000007") {
        return json({ error: { code: 3, error: "Fixture member key permission failure." } }, 403)
      }
      if (personalStatsMatch[1] === "980000008") {
        return json({ error: { code: 9, error: "Fixture Torn rate limit." } }, 429)
      }
      return json(liveFixtures.targetMemberPopular)
    }
    return json({ error: "Unknown integration fixture route." }, 404)
  },
}
