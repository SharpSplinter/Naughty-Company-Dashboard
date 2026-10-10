type RankableCompany = { companyId: string; companyType: string; companyTypeId: number | string | null; starRating: number | null; weeklyIncome: number | null }

export function placement(company: RankableCompany, dimension: "type" | "stars", globalRankingCompanies: RankableCompany[]): string {
    const target = dimension === "stars"
      ? globalRankingCompanies.find((row) => row.companyId === company.companyId) ?? company
      : company
    if (target.weeklyIncome === null) return "—"
    const reference = globalRankingCompanies.filter((row) => {
      const sameType = target.companyTypeId != null && row.companyTypeId != null
        ? Number(row.companyTypeId) === Number(target.companyTypeId)
        : row.companyType.toLocaleLowerCase() === target.companyType.toLocaleLowerCase()
      const sameStar = dimension !== "stars" || (target.starRating !== null && row.starRating === target.starRating)
      return sameType && sameStar && row.weeklyIncome !== null
    })
    if (!reference.length) return "—"
    const rank = reference.filter((row) => row.weeklyIncome !== null && row.weeklyIncome > target.weeklyIncome!).length + 1
    return `${rank}/${reference.length}`
}
