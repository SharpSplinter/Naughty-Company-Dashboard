import type { WeeklyMemberResult, WeeklyRankingMetric } from "./weekly"

export type WeeklyLeaderboardSortKey =
  | "rank" | "name" | "position" | "selectedMetric"
  | "xantaken" | "lsdtaken" | "alcoholused" | "boostersused"
  | "energydrinkused" | "refills" | "gymEnergy"
  | "startingNetworth" | "endingNetworth" | "networth" | "completeness"

export type WeeklyLeaderboardStatusFilter = "all" | WeeklyMemberResult["status"]
export type WeeklyLeaderboardParticipationFilter = "all" | WeeklyMemberResult["participation"]
export type WeeklyLeaderboardDirection = "asc" | "desc"

export type WeeklyLeaderboardMember = Pick<
  WeeklyMemberResult,
  | "userId" | "name" | "position" | "participation" | "status"
  | "metrics" | "startingNetworth" | "endingNetworth" | "gymEnergy"
  | "knownMetricCount" | "anomalyMetrics"
> & { rank: number | null }

export type WeeklyLeaderboardOptions = {
  search?: string
  status?: WeeklyLeaderboardStatusFilter
  participation?: WeeklyLeaderboardParticipationFilter
  anomaliesOnly?: boolean
  sortBy?: WeeklyLeaderboardSortKey
  direction?: WeeklyLeaderboardDirection
  selectedMetric?: WeeklyRankingMetric
}

function selectedValue(member: WeeklyLeaderboardMember, metric: WeeklyRankingMetric): number | null {
  return metric === "gymEnergy" ? member.gymEnergy : member.metrics[metric]
}

function valueFor(
  member: WeeklyLeaderboardMember,
  key: WeeklyLeaderboardSortKey,
  selectedMetric: WeeklyRankingMetric,
): number | string | null {
  switch (key) {
    case "rank": return member.rank
    case "name": return member.name
    case "position": return member.position
    case "selectedMetric": return selectedValue(member, selectedMetric)
    case "xantaken": return member.metrics.xantaken
    case "lsdtaken": return member.metrics.lsdtaken
    case "alcoholused": return member.metrics.alcoholused
    case "boostersused": return member.metrics.boostersused
    case "energydrinkused": return member.metrics.energydrinkused
    case "refills": return member.metrics.refills
    case "gymEnergy": return member.gymEnergy
    case "startingNetworth": return member.startingNetworth
    case "endingNetworth": return member.endingNetworth
    case "networth": return member.metrics.networth
    case "completeness": return member.knownMetricCount
  }
}

/** Filter and sort a weekly leaderboard without ever promoting unknown values over known values. */
export function filterAndSortWeeklyMembers(
  members: WeeklyLeaderboardMember[],
  options: WeeklyLeaderboardOptions = {},
): WeeklyLeaderboardMember[] {
  const search = options.search?.trim().toLocaleLowerCase() ?? ""
  const status = options.status ?? "all"
  const participation = options.participation ?? "all"
  const anomaliesOnly = options.anomaliesOnly ?? false
  const sortBy = options.sortBy ?? "rank"
  const direction = options.direction ?? "asc"
  const selectedMetric = options.selectedMetric ?? "xantaken"
  const multiplier = direction === "asc" ? 1 : -1

  return members.filter((member) => {
    if (status !== "all" && member.status !== status) return false
    if (participation !== "all" && member.participation !== participation) return false
    if (anomaliesOnly && member.anomalyMetrics.length === 0) return false
    if (!search) return true
    return [member.name, member.userId, member.position ?? ""]
      .some((value) => String(value).toLocaleLowerCase().includes(search))
  }).slice().sort((left, right) => {
    const leftValue = valueFor(left, sortBy, selectedMetric)
    const rightValue = valueFor(right, sortBy, selectedMetric)
    const leftUnknown = leftValue === null
    const rightUnknown = rightValue === null
    // Unknown remains last for both ascending and descending order.
    if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1
    if (!leftUnknown && !rightUnknown) {
      const comparison = typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue, undefined, { sensitivity: "base" })
        : Number(leftValue) - Number(rightValue)
      if (comparison !== 0) return comparison * multiplier
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.userId.localeCompare(right.userId)
  })
}
