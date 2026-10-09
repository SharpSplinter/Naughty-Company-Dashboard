# Torn company data model

The app consumes Torn API v2 company profile and employee responses.

- Company profile response: `{ profile: ... }`
- Employee response: `{ employees: [...] }`
- Employee position: `position.id`, `position.name`
- Work stats, when authorized: `stats.manual_labor`, `stats.intelligence`, `stats.endurance`
- Effectiveness, when authorized: `effectiveness.total`
- Full director response may additionally include `wage`, `joined_at`, and `value`.

The normalization engine does not infer restricted values. Missing employee stats are represented as unavailable and produce a `unknown` role-fit status, not zero stats or an incorrect failure.

Position matching uses the company type's name and the position name from the API against `src/lib/company/positions.json`. Unknown company types and roles are retained as unmapped data instead of being silently assigned to a different role.
