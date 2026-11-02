# Faction Performance, Rankings & Member Management Dashboard

> Project plan and complete feature handoff. This document is the authoritative product scope for the next major development phase of the Naughty Family Portal. Keep the requirements intact as implementation is staged; do not silently remove, collapse, or reinterpret a feature.

## 1. Project objective

Build a comprehensive Torn City faction performance, statistics, activity-monitoring and member-management dashboard on top of the existing Naughty Family Portal.

The dashboard has four primary sections:

1. Weekly Rankings — the default landing tab and highest priority.
2. Live Member Status — current faction state, last action, hospital state, revive permissions and member-consented private bars/cooldowns.
3. Historical Performance — immutable completed weekly results and comparisons.
4. Faction Activity & Inactivity Monitoring — online/idle/offline and 24-hour/72-hour inactivity monitoring.

The product must separate three data classes:

- **Public/player data available through the faction's authorized key:** faction membership/status, public personal-stat counters and faction contributor values where the relevant faction permission is present.
- **Faction-permission data:** the faction member list's populated revive_setting and the faction contributors selection. These require the correct faction and key permissions.
- **Private owner-only data:** bars, cooldowns and detailed networth. These are collected only when that specific member voluntarily connects their own key and consents to the relevant selections.

Unknown, missing, unauthorized, stale, disconnected and failed data must remain distinct. None may be silently represented as zero.

## 2. Repository baseline and current implementation

Inspected the current PR branch and repository configuration.

| Area | Current baseline |
|---|---|
| Frontend | React 19, Vite 6, TypeScript 5 |
| API/backend | Cloudflare Worker, TypeScript |
| Database | Cloudflare D1 |
| Background work | Cloudflare Queues and scheduled Worker cron |
| Existing workspaces | Portal home, Company, Halloween, Faction, Account Settings, Admin |
| Existing member authentication | Personal Limited Access Torn key with Naughty Souls membership verification |
| Existing credential handling | Server-side encrypted storage; no plaintext browser storage |
| Existing quality gates | TypeScript, production build, backend regression tests, admin contract tests, Halloween consent tests |
| Current PR | Draft PR #152, branch portal-rebuild |

The current portal already provides the shared workspace foundation, faction authentication, Company operations, Halloween collection/archive/live intelligence, a faction director/member workspace, account credential controls and administrator-role management.

The current PR's migrations run through 0018. The repository does **not yet** contain the proposed weekly_rankings, member_stat_snapshots, gym_energy_snapshots or member_live_status data model, nor the requested weekly rankings/weekly comparison/live activity collection subsystem. Treat this handoff as the scope for that major next tranche, not as a claim that those features already exist.

The current application is defined in package.json and wrangler.toml. Preserve the existing React/Vite + Worker + D1 + Queue architecture unless an evidenced technical limitation requires a proposal and discussion first.

## 3. Verified Torn API v2 contract

The official Torn Swagger OpenAPI document was inspected on 2026-11-02. Its current published specification reports version **6.15.0**. Use the live OpenAPI document as the source of truth during implementation because Torn's API v2 continues to evolve.

Primary references:

- Official API documentation: https://www.torn.com/api.html
- Official Swagger UI: https://www.torn.com/swagger.php
- OpenAPI contract: https://www.torn.com/swagger/openapi.json
- Faction members playground: https://api-playground.torn.com/faction/:id/members
- Personal stats playground: https://api-playground.torn.com/user/:id/personalstats

### 3.1 Faction roster and revive fields

Use GET /v2/faction/{id}/members with the faction ID and striptags=true.

The current schema describes a FactionMember containing:
- id, name, position, level and days_in_faction
- is_revivable
- is_on_wall, is_in_oc and has_early_discharge
- last_action
- status
- revive_setting

The endpoint is documented as requiring a public access key. For the requesting faction's own members, revive_setting is populated rather than Unknown when the key also has faction permissions; the documented qualifying key tiers are Custom, Limited or Full.

**Keep the two revive values completely separate.**

- is_revivable is an owner-specific answer: whether the current API-key owner can revive that member. It is not a universal property of the target. The owner's Reviver skill matters, and friend/faction eligibility can matter. A false value must never be reinterpreted as the target's revive setting.
- revive_setting is the target member's configured permission. In the current v6.15.0 schema its enum is Everyone, Friends & faction, No one and Unknown. The UI must preserve Unknown. The requested Friends only filter is not in the current official enum; support it only if a future API schema actually returns such a value. Do not invent it.

The official Torn forum clarification for is_revivable explicitly states that it means revivable by this key owner and that a key owner without Reviver skill cannot use it to infer the target's permission setting:
https://www.torn.com/forums.php?a=0&b=0&f=19&p=threads&t=16496684

Display separate columns:
- Can I revive this member? Yes / No / Unknown.
- Member's revive setting: the actual API enum.

Add independent filters for each supported revive-setting value and for owner-specific can-revive yes/no/unknown. Do not infer a setting from is_revivable.

### 3.2 Last action, online status and current status

FactionMember.last_action is a UserLastAction with:
- status
- timestamp
- relative

The current status enum includes Online, Idle and Offline. Use timestamp for elapsed-time and inactivity calculations. relative is display-only supporting text. Label the value Last Action or Last Activity, never Last Login.

FactionMember.status is a UserStatus with description, details, state, until and color. until may be null. Use state/until for status display and remaining-time calculations where supplied. Do not assume hospital reason or a timer exists if the API response does not supply the needed field. Display unavailable when missing.

### 3.3 Public personal statistics

Use GET /v2/user/{id}/personalstats with a public access key.

The endpoint response is a union selected by access level and query parameters. The generated response contract supplied for this project defines:

- `UserPersonalStatsFull` when the full selection is requested with a Limited, Full or Custom key; its generated `personalstats` member is `unknown`.
- `UserPersonalStatsFullPublic` for `cat=all`; its generated `personalstats` member is `unknown`.
- `UserPersonalStatsPopular` for `cat=popular`; its generated `personalstats` member is `unknown`.
- `UserPersonalStatsCategory` for another matched category selection. Its generated schema describes nested category objects such as `drugs`, `items`, `other` and `networth`.
- `UserPersonalStatsHistoric` for historical requests using `stat` with `timestamp`; its `personalstats` member is an array of `{ name, value, timestamp }` records.

Torn recommends `cat=popular` over `cat=all` wherever Popular contains the required fields, to reduce server load. Keep a distinct decoder for each union variant. Do not cast the three generated `unknown` payloads to a known shape until sanitized live fixtures prove that shape. For category responses, use the nested property paths in the metric map below.

Use the public current personal-stat response for other faction members. Do not request another player's private stats. Historical `stat` requests require `timestamp`, accept up to 10 statistic names per call (additional names are trimmed), and return a list of records. A returned record's `timestamp` identifies when that particular stat was last updated. Statistics that did not exist at the requested timestamp may be omitted. An omitted item is unknown, not zero. Torn resolves a requested historical timestamp to the nearest date, so historical requests are useful for spot-checking/backfill only and are not the source of truth for exact weekly Sunday boundaries.

The complete generated response contract and decoder notes are maintained in [TORN-PERSONALSTATS-RESPONSE-SCHEMA.md](TORN-PERSONALSTATS-RESPONSE-SCHEMA.md).

Use these requested current lifetime counters, validating each current-response path and historical stat name against the live contract and sanitized fixtures:

| Display metric | Current category-response path | Historical `stat` name |
|---|---|---|
| Xanax taken | `drugs.xanax` | `xantaken` |
| LSD taken | `drugs.lsd` | `lsdtaken` |
| Total drugs used | `drugs.total` | `drugsused` |
| Drug overdoses | `drugs.overdoses` | `overdosed` |
| Alcohol consumed | `items.used.alcohol` | `alcoholused` |
| Boosters used | `items.used.boosters` | `boostersused` |
| Energy drinks consumed | `items.used.energy_drinks` | `energydrinkused` |
| Energy refills | `other.refills.energy` | `refills` |
| Stat enhancers used | `items.used.stat_enhancers` | `statenhancersused` |
| Current public total networth | `networth.total` | `networth` |
| Cannabis | `drugs.cannabis` | `cantaken` |
| Ecstasy | `drugs.ecstasy` | `exttaken` |
| Ketamine | `drugs.ketamine` | `kettaken` |
| Opium | `drugs.opium` | `opitaken` |
| Shrooms | `drugs.shrooms` | `shrtaken` |
| Speed | `drugs.speed` | `spetaken` |
| PCP | `drugs.pcp` | `pcptaken` |
| Vicodin | `drugs.vicodin` | `victaken` |

Xanax and LSD remain independent statistics, displayed side by side with separate weekly totals and separate ranks. Do not create a conversion ratio, composite, or penalty.

The current OpenAPI PersonalStatsStatName enum contains the drug keys above, including xantaken, lsdtaken, cantaken, exttaken, kettaken, opitaken, pcptaken, shrtaken, spetaken and victaken, plus drugsused, overdosed, alcoholused, boostersused, energydrinkused, statenhancersused, refills and networth. Confirm actual nested properties in the category schemas when writing the mapper.

Public personalstats networth data exposes a total. The extended networth breakdown is not generally public for arbitrary other users.

### 3.4 Gym energy contributors

Use GET /v2/faction/contributors?stat=gymenergy.

The required parameter is **stat=gymenergy**. Do not implement gymenergy=true.

The current OpenAPI contract documents this endpoint as requiring a Limited access key with faction API access permissions. The optional cat parameter accepts current or all; by default it returns current faction members. cat=all returns all contributors.

The response contains contributors with:
- id
- username
- value
- in_faction

Use id as the permanent join key. value is the faction contributor total for the requested stat; in_faction identifies current faction membership. Capture timestamped values on our own schedule and calculate interval deltas. Do not combine gym energy with drinks, refills or current energy bars.

### 3.5 Owner-only live selections

The current API exposes:
- GET /v2/user/bars — Minimal access key, key-owner endpoint.
- GET /v2/user/cooldowns — Minimal access key, key-owner endpoint.

These endpoints do not accept an arbitrary target player ID. They are owner-specific. Therefore each member must voluntarily connect their own key and grant the needed selections.

The bars schema includes bars.energy.current, maximum, increment, interval, tick_time and full_time. The cooldowns schema contains drug, medical and booster values.

Use only a member's own key for that member's bars/cooldowns. If the member has not connected, has not consented to the selection, or the call fails, show Not Connected, Unauthorized, Unavailable or Stale as appropriate. Never show zero or infer that a cooldown has expired.

Detailed networth is available through GET /v2/user/networth, which requires Limited access and is a key-owner selection. There is no arbitrary-user equivalent in the current contract. Collect detailed networth only for a member using their own key and explicit opt-in; public total networth remains sourced from public personalstats.

### 3.6 Rate limits and cache

Torn's official API documentation states a limit of up to 100 individual requests per minute per user across that user's keys, and notes that limits can change without notice. The official documentation also explains a service cache that may return identical results for up to 30 seconds.

Design a conservative shared throttle and request budget. Do not rely on the maximum as a target. Deduplicate and cache identical requests, batch where supported, spread member polling, and only bypass cache for genuinely necessary boundary/freshness calls. Handle error codes and HTTP responses together; do not assume every API failure uses a non-200 HTTP status. Invalid/disabled keys must be stopped and surfaced instead of retried indefinitely.

## 4. Weekly performance window — highest priority

All weekly rankings use this fixed reporting window:

**Sunday 00:00:00 TCT (UTC), inclusive, through the following Sunday 00:00:00 TCT (UTC), exclusive.**

- Duration: exactly 168 hours.
- All backend timestamps and database boundaries are UTC.
- Do not use the viewer's local timezone or daylight saving time.
- The weekly page must display the exact period and time remaining in the active week.

At each Sunday boundary, schedule dedicated starting/ending lifetime-counter snapshots for each member. Capture actual request/response timestamps. Record timing deviation and label late or incomplete boundary snapshots. A delayed job must not pretend it captured an exact boundary.

Torn historical personal-stat timestamp lookups convert to the nearest date. Therefore our own timestamped snapshots are the source of truth for exact weekly reporting. Do not use historical stat queries as a substitute for our own boundary snapshots.

For each counter:

    weekly usage = ending lifetime counter - starting lifetime counter

Examples for tests and UI illustration:

| Statistic | Sunday baseline | Next Sunday | Weekly usage |
|---|---:|---:|---:|
| Xanax | 1,240 | 1,247 | 7 |
| LSD | 380 | 390 | 10 |
| Alcohol | 500 | 508 | 8 |
| Boosters | 120 | 127 | 7 |
| Energy drinks | 250 | 265 | 15 |
| Energy refills | 42 | 44 | 2 |

These are illustrative only, not live faction values.

Rules:
- Never rank on lifetime totals. Rank on the weekly delta.
- Lifetime totals remain supplementary.
- Preserve actual snapshot times.
- A missing baseline or ending value is unknown/incomplete, not zero.
- A decreased lifetime counter is an anomaly/reset/invalid sample. Do not silently accept a negative weekly result.
- Do not fabricate missing values or replace them with zero.
- For a member joining midweek, capture a baseline on first observed membership and mark a partial-week result.
- For a member leaving midweek, use the last available in-faction snapshot, mark the result partial, and preserve it historically.
- Store baseline/ending snapshot IDs, timestamps, completeness and anomaly metadata with the calculated result.

## 5. Faction roster and member information

Collect the faction roster using the faction-authorized key and /faction/{id}/members.

Persist by Torn user ID:
- Torn user ID
- username
- faction position
- level
- days in faction
- first seen and last seen timestamps
- membership interval/status
- last_action.status, timestamp and relative
- current status description/details/state/until/color
- is_revivable
- revive_setting
- other useful current FactionMember fields provided by the current schema

Use striptags=true. Treat username as mutable display information; all relationships must use Torn user ID.

Capture member joins and departures as membership intervals. A current roster snapshot alone is not sufficient to reconstruct midweek membership accurately.

## 6. Inactivity monitoring

Calculate elapsed inactivity using server-side UTC now minus last_action.timestamp.

| Elapsed since last action | Classification |
|---|---|
| Under 24 hours | Normal |
| 24 hours to under 72 hours | 24H+ INACTIVE |
| 72 hours or more | 72H+ INACTIVE |
| Missing timestamp | Unknown |

72H+ takes priority; a member never shows both flags simultaneously.

Show exact elapsed duration such as 28h 15m, 49h 32m, 3d 6h or 7d 2h. Treat the API's relative text as supplemental only.

Add filters:
- All members
- Normal activity
- 24H+ inactive
- 72H+ inactive
- Unknown

Show warnings in both Live Member Status and Faction Activity. The 72-hour warning must be especially visible.

## 7. Public personal-stat collection

For every faction member, collect the public current personal stats through /v2/user/{id}/personalstats.

- Prefer `cat=popular` when all required counters are present; Torn specifically recommends Popular over FullPublic wherever possible.
- If Popular does not provide a required metric, request only the matching category where that is sufficient; use `cat=all` / FullPublic only when the needed public fields are not otherwise covered.
- Treat the endpoint as a response union. Decode Full (Limited/Full/Custom full selection), FullPublic (`cat=all`), Popular (`cat=popular`), category-specific and Historic responses separately.
- The generated schema marks the Full, FullPublic and Popular `personalstats` payloads as `unknown`. Add sanitized fixtures for each and validate their actual shape before mapping; do not use unchecked casts.
- For category-specific current responses, map using nested category paths such as `drugs.xanax`, `items.used.energy_drinks`, `other.refills.energy` and `networth.total`. Historical stat names such as `xantaken` are not current category object property paths.
- Historical `stat` requests require `timestamp`, accept no more than 10 names per call, and return an array of `{ name, value, timestamp }`. The returned per-stat timestamp is the stat's last-updated time; the item may be absent if the stat did not exist at the requested time.
- Do not rely on historical stat requests for exact weekly Sunday boundaries. They use nearest-date behavior; the application's own timestamped snapshots remain authoritative.
- Private stats remain owner-only.
- Record a captured_at timestamp and request freshness for each current sample.
- Missing fields or omitted historical items remain null/unknown, never zero.
- Keep all lifetime counters in storage.

Drug statistics must retain independent drug fields, especially Xanax and LSD. Alcohol, boosters, energy drinks, refills, drug overdoses and stat enhancers are also separate metrics.

## 8. Gym energy tracking

Collect GET /v2/faction/contributors?stat=gymenergy with the faction-authorized Limited key.

- Store faction contributor value by Torn ID and captured_at.
- Use in_faction for membership context.
- Calculate weekly delta from our own Sunday-boundary/periodic snapshots.
- Preserve contributors who leave midweek.
- Do not equate gym energy spent with current energy, energy drinks or refills.

## 9. Networth

Display:
- Current public total networth from public personalstats, with last refreshed timestamp.
- Weekly networth change = ending total minus starting total.
- Starting networth, ending networth and change separately.

Networth change is informational and must not be included in the default activity-ranking score.

The optional detailed breakdown is collected only from the member's own /user/networth call, using their voluntarily connected Limited-or-higher key and explicit opt-in. Do not request another member's private networth breakdown.

## 10. Live Member Status

Create a dedicated Live Member Status tab with columns:

| Column | Source/meaning |
|---|---|
| Member | Username and Torn ID |
| Position | Faction position |
| Online status | last_action.status: Online / Idle / Offline |
| Last action | Relative elapsed time plus formatted timestamp |
| Inactivity | Normal / 24H+ / 72H+ / Unknown |
| Status | Current Torn status |
| Hospital | Derived from status.state where the API says Hospital |
| Hospital timer | status.until when available |
| Can I revive? | is_revivable, specific to key owner |
| Revive setting | revive_setting, separate target preference |
| Energy | current / maximum from member's own connected key |
| Drug cooldown | Remaining value from own key |
| Booster cooldown | Remaining value from own key |
| Medical cooldown | Remaining value from own key |
| Networth | Public total; detailed breakdown only with consent |
| Last refreshed | Per-value freshness |

Filters for revive and inactivity must be independent. Unknown fields remain Unknown. A member without an opted-in personal key shows Not Connected for private live fields.

## 11. Weekly Rankings — default landing tab

Title: FACTION WEEKLY RANKINGS

Subtitle: Sunday 00:00 TCT - Sunday 00:00 TCT

Show the week start/end and countdown or time remaining.

Summary cards:
- Total faction members
- Members with complete weekly data
- Total Xanax used this week
- Total LSD used this week
- Total alcohol consumed this week
- Total boosters used this week
- Total energy drinks consumed this week
- Total gym energy spent this week

Main table columns:
- Rank
- Member
- Faction position
- Xanax this week
- LSD this week
- Alcohol this week
- Boosters this week
- Energy drinks this week
- Energy refills this week
- Gym energy this week
- Total drugs used
- Overdoses this week
- Stat enhancers this week
- Starting networth
- Current networth
- Networth change

Provide independently sortable/rankable metrics:
- Xanax
- LSD
- Alcohol
- Boosters
- Energy drinks
- Refills
- Gym energy
- Total drug usage
- Overdoses
- Networth change

Provide search and filters. Do not add a default composite formula. Any future composite ranking must be configurable and transparent.

Clicking a member opens a detailed profile with current lifetime statistics, weekly statistics, previous weekly results, online status, last action, inactivity, hospital status, both revive fields, available live cooldown/energy data and networth.

## 12. Historical Performance

Persist prior completed weeks permanently unless an administrator explicitly deletes them.

Leadership can:
- Select a previous week.
- Compare two weeks.
- View one member's weekly history.
- See faction-wide weekly totals.
- See member improvement/decline.
- Identify top Xanax and LSD usage separately.
- Compare alcohol, boosters, drinks, refills and gym energy.
- Review weekly networth changes.

Never overwrite a completed week when a new week begins.

**Retention requirement:** a member leaving the faction must retain the historical performance records for periods when they were a member. Historical records are not the same as active sessions, current roster rows or private API credentials.

## 13. Faction Activity

Provide a separate Faction Activity tab with overview counts for:
- Online
- Idle
- Offline
- Hospitalized
- Can be revived by the current faction API-key owner
- Each actual revive_setting value
- 24H+ inactive
- 72H+ inactive
- Connected live API information
- Not connected live API information

Provide filters and sorting. Highlight 72H+ inactivity prominently.

## 14. Database model

Use relational tables, D1 migrations and Torn user IDs as stable keys. The following are the target logical entities; adapt physical naming to existing conventions but preserve the data and history.

### faction_members
- user_id
- faction_id
- username
- position
- level
- days_in_faction
- first_seen_at
- last_seen_at
- membership_status

The production design must retain membership intervals, not only one current membership flag, so join/leave-in-week cases can be calculated.

### member_stat_snapshots
- id
- user_id
- captured_at
- xantaken
- lsdtaken
- alcoholused
- boostersused
- energydrinkused
- refills
- drugsused
- overdosed
- statenhancersused
- cantaken
- exttaken
- kettaken
- opitaken
- shrtaken
- spetaken
- pcptaken
- victaken
- networth

Keep values nullable and record source/freshness metadata. Optionally retain raw validated response JSON for future remapping, with appropriate retention and no API key material.

### gym_energy_snapshots
- id
- user_id
- captured_at
- gym_energy_total

Also retain source faction, in_faction flag and collection run metadata as needed.

### member_live_status
- user_id
- captured_at
- last_action_status
- last_action_timestamp
- status_state
- status_until
- is_revivable
- revive_setting
- energy_current
- energy_maximum
- drug_cooldown
- booster_cooldown
- medical_cooldown
- networth
- connection_status

Private data fields must be nullable and permission/consent aware. Preserve per-field timestamps/freshness.

### weekly_rankings
- id
- user_id
- week_start_utc
- week_end_utc
- xanax_used
- lsd_used
- alcohol_used
- boosters_used
- energy_drinks_used
- energy_refills
- gym_energy
- drugs_used
- overdoses
- stat_enhancers_used
- starting_networth
- ending_networth
- networth_change
- data_completeness
- ranking_metadata

Include references to baseline/ending snapshots and partial-week/anomaly/timing-deviation details.

### member_api_connections
- user_id
- encrypted_api_key
- connected_at
- last_successful_sync
- connection_status
- authorized_selections

Also record consent version, granted selections, consent timestamp, last error class and revocation/disconnect timestamps. Never return ciphertext or keys to the frontend.

Additional operational tables should be proposed as needed for collection runs, weekly boundary jobs, retry/backoff, request-budget accounting, consent audit, membership intervals and immutable report runs.

## 15. Automated collection

Configurable initial targets:
- Faction roster/live faction status: every 5 minutes.
- Public member personal stats: every 15 minutes.
- Gym energy contributor snapshots: every 15 minutes.
- Opted-in member bars/cooldowns: every 5 minutes, subject to consent and rate budget.
- Dedicated weekly baseline/ending snapshots: each Sunday 00:00 TCT boundary.

The scheduler must run without a browser being open.

Implement:
- API response caching
- Request deduplication
- Batching where supported
- Per-owner request budgets and global throttle
- Retry handling and exponential backoff
- Error logging without secrets
- Stale-data indicators
- Connection/key failure detection
- Idempotent queue jobs
- Missed/late boundary recovery without falsifying snapshot timestamps

Torn documents a maximum of 100 individual requests per minute per player across their keys and a service cache that may last up to 30 seconds. Treat the limit as an upper bound, not a target. Use timestamp cache-bypass only when genuinely required, especially for boundary snapshots.

## 16. Security, permissions and member privacy

- Keep API keys encrypted at rest.
- Never expose keys in frontend JavaScript, logs, source control or public database queries.
- Never request Torn passwords.
- Never use another member's private key.
- Faction-authorized collection must use the faction key only for selections it can access.
- Individual live fields are voluntary and owner-specific.
- Members may disconnect and revoke their connection.
- Collect only opted-in private fields.
- Apply least privilege: use the minimum key tier/selections required for each endpoint.
- Rate-limit, deduplicate and audit connection use.
- Restrict administrative controls to authorized leadership/admin roles.
- Do not let an invalid/missing member key disable public-stat collection for that player.

A visible data usage disclosure must explain:
- What is collected
- Why it is collected
- Retention period
- Who can see it
- Whether it is shared with the faction
- Required access level/selections
- Encryption and credential handling
- How to revoke access

Review the design against Torn's API documentation and Terms of Service before production.

### Historical retention and member departure

This handoff adds an important retention requirement to the current portal's departure-cleanup behavior.

The current portal's security model removes sessions, saved faction credentials, admin privileges, private connections, live/ephemeral data and some Halloween contribution data on confirmed departure. The weekly-performance specification explicitly requires historical weekly results to remain available for periods when a member belonged to the faction.

Before implementing the weekly system, separate:
1. **Access/secrets/live-private data** — revoke/delete promptly on departure or disconnect.
2. **Current roster/active membership** — mark ended and remove from current roster views.
3. **Historical public performance records** — retain immutable snapshots and completed weekly results for the member's in-faction periods, as explicitly requested.

Do not let a generic member purge delete weekly history. Define a reviewed retention policy for the pre-existing Halloween log archive separately; do not silently change the current Halloween consent/privacy policy as a side effect of the weekly-stat work.

## 17. Data accuracy and edge cases

- Missing values are unknown, not zero.
- API failures do not erase valid history.
- Missing personal key does not stop public faction data collection.
- Midweek joiners are partial-week participants with a first-seen baseline.
- Midweek leavers keep history and use their final in-faction snapshot.
- Counter decreases are anomaly/reset cases, never silent negative usage.
- Missing baseline/end snapshots mean incomplete data.
- Unknown revive status remains Unknown.
- Disconnected private bars/cooldowns are Not Connected or Unavailable, never zero.
- Every API field has its own last-updated timestamp.
- All data links to Torn ID, not username.
- Distinguish stale from unavailable, unauthorized, disconnected and not yet collected.
- Record membership and snapshot boundary deviations.

## 18. User interface and design

Use a polished, modern, information-dense faction management interface, consistent with the existing portal.

Prioritize:
- Weekly Rankings as default tab
- Clear Sunday UTC reporting period
- Clear summary cards and ranking table
- Sortable columns and independent metric selection
- Member search and filters
- Member profile drilldown
- Weekly navigation and comparisons
- Historical charts and trend summaries
- Live status and freshness
- Mobile responsiveness and keyboard accessibility

Visual semantics:
- Green: normal activity or connected/successful data
- Yellow/orange: 24H+ inactive, partial data, stale
- Red: 72H+ inactive and important errors
- Grey: unknown, unavailable or not connected

Do not use color as the only status signal; include readable text and accessible contrast.

## 19. Implementation phases

### Phase 0 — Contract and architecture verification
- Preserve current app architecture.
- Generate typed Torn response fixtures from the current v2 OpenAPI schema, including the /user/personalstats response union.
- Add sanitized fixtures for Full, FullPublic, Popular, category-specific and Historic response variants; test unknown payloads before mapping.
- Verify nested current-response metric paths separately from historical stat names, and validate each required field and permission.
- Build data-source/permission matrix and request-budget estimate.
- Decide and document historical retention separation before coding.
- Define weekly boundary scheduler and late/missed capture policy.

### Phase 1 — Faction roster and public-data ingestion
- Faction member collection and membership interval tracking.
- Public personalstats collection for all required counters.
- Faction gymenergy contributors.
- D1 migrations, timestamps, caching, throttling, retries and monitoring.
- API fixture tests and data-quality validation.

### Phase 2 — Weekly calculation engine
- Sunday 00:00 UTC boundary jobs.
- Baseline and ending snapshots.
- Weekly delta calculations and data-completeness metadata.
- Partial weeks and membership changes.
- Anomaly handling for decreased counters and missing snapshots.
- Historical immutable weekly rankings.

### Phase 3 — Weekly Rankings UI
- Default weekly tab.
- Summary cards.
- Independent metric sorting/ranking.
- Search, filters and member profiles.
- Lifetime vs weekly values and freshness.

### Phase 4 — Live Member Status and faction activity
- Faction member online/idle/offline, last action and status.
- Hospital and timer display where returned.
- Separate is_revivable and revive_setting.
- Inactivity thresholds at 24h and 72h.
- Filters and activity overview.

### Phase 5 — Voluntary private live connections
- Consent and disclosure.
- Own-key connection and validation.
- Minimal bars/cooldowns selections.
- Optional own-key detailed networth.
- Revocation and key failure handling.
- Per-member request budgets and freshness.

### Phase 6 — Historical performance and comparisons
- Week selector and two-week comparison.
- Member history.
- Faction aggregate history.
- Independent Xanax/LSD/alcohol/booster/energy/refill/gym-energy/networth trends.

### Phase 7 — Acceptance and production readiness
- Real faction-key integration with permission validation.
- Volunteer member-key tests.
- Admin/non-admin acceptance.
- Mobile/accessibility checks.
- Rate-limit/load tests.
- Migration backup and review.
- Deployment and rollback runbook.
- Explicit approval before production cutover.

## 20. Required test plan

### Weekly calculation unit tests
- A member with seven Xanax between snapshots produces weekly Xanax usage 7.
- A member with ten LSD between snapshots produces weekly LSD usage 10.
- Xanax and LSD never merge or convert.
- A member joining halfway through a week is marked partial with correct baseline time.
- A member leaving halfway through a week remains historically available and uses the last in-faction snapshot.
- A missing ending snapshot is incomplete/unknown, not zero.
- A missing starting snapshot is incomplete/unknown, not zero.
- A decreased counter is flagged as an anomaly and is not silently ranked as negative usage.
- A Sunday 00:00 start is inclusive.
- The following Sunday 00:00 end is exclusive.
- UTC boundaries are unchanged by local timezone or daylight saving transitions.
- Late boundary jobs record actual capture timestamp and deviation.

### Live status and permissions tests
- Online, Idle and Offline map from last_action.status.
- Last action timestamp, not relative text, drives elapsed time.
- 24 hours is the first inactivity threshold.
- 72 hours takes priority over the 24-hour flag.
- Missing timestamps remain Unknown.
- is_revivable and revive_setting are independently stored/displayed.
- Owner without Reviver skill must not infer target's revive_setting from is_revivable.
- API-provided Unknown remains Unknown.
- Hospital state and until are nullable and not fabricated.

### API and privacy tests
- Faction members requires the expected faction key permissions.
- revive_setting Unknown when insufficient faction permission.
- Contributors call uses stat=gymenergy.
- Contributor values map by Torn ID and in_faction.
- Public personalstats does not attempt to access other members' private stats.
- Full, FullPublic, Popular, category-specific and Historic response variants are decoded independently.
- Popular is preferred over FullPublic when it covers the required metrics.
- Category current-response nested paths are not confused with historical stat names.
- Historical requests require timestamp, are capped at 10 stat names per request, and handle omitted stats as unknown.
- Historical per-stat timestamps are retained as last-updated timestamps, not falsely treated as exact requested-time samples.
- bars and cooldowns are called only using the member's own opted-in key.
- Detailed networth is called only using the member's own authorized key.
- Missing/invalid keys do not stop public-stat collection.
- API response failure does not erase prior data.
- Rate-limit/backoff prevents repeated invalid or throttled calls.
- Keys never appear in logs or client responses.
- Disconnect revokes future private data collection.

## 21. Definition of done

The project is not complete until all of the following are implemented and tested:

1. Faction roster loads automatically using the faction-authorized API key.
2. Public drug, alcohol, booster and energy-related lifetime counters are collected.
3. LSD is separate from Xanax.
4. Gym energy is collected through faction contributors.
5. Weekly calculations use Sunday 00:00 TCT to Sunday 00:00 TCT.
6. Lifetime counters and weekly usage are displayed separately.
7. Members can be ranked independently by every requested statistic.
8. Networth and weekly networth change are displayed without being folded into the default activity score.
9. is_revivable and revive_setting have independent columns and filters.
10. Last action and online status are displayed.
11. 24H+ and 72H+ inactivity flags are displayed accurately.
12. Hospital status and remaining time are shown where the API supplies them.
13. Members can voluntarily connect personal keys for live energy/cooldown information.
14. Unknown/unavailable/disconnected/stale information is represented correctly.
15. Completed weekly rankings remain historically available.
16. Members joining/leaving midweek are handled accurately.
17. API keys and private information remain secure.
18. The dashboard is responsive, accessible and automatically refreshed.
19. Collection continues while nobody has the dashboard open.
20. Operational logs, retries, request budgets and stale-data monitoring are in place.
21. Migrations, configuration, data disclosure, deployment and rollback documentation are complete.
22. Real-account acceptance tests pass before production approval.

## 22. API and design decision log

| Topic | Decision |
|---|---|
| Weekly timezone | UTC/TCT only; Sunday 00:00 inclusive to next Sunday 00:00 exclusive |
| Personal stats | Decode the response union; prefer cat=popular when it covers the required public fields, then request a specific category where practical, and use cat=all only when needed |
| Personalstats response | Full (Limited/Full/Custom full selection), FullPublic (cat=all), Popular (cat=popular), category-specific or Historic; generated Full/FullPublic/Popular payloads are unknown pending sanitized fixtures |
| Current category mapping | Use nested category paths, e.g. drugs.xanax, items.used.energy_drinks, other.refills.energy, networth.total |
| Historical personalstats | stat + timestamp, max 10 stat names; returns name/value/last-updated timestamp records; not the exact weekly boundary source because Torn resolves timestamp to nearest date |
| Gym energy | stat=gymenergy, not gymenergy=true |
| Gym contributor schema | id, username, value, in_faction |
| Revive flags | is_revivable is owner-specific; revive_setting is member preference |
| Current revive enum | Everyone, Friends & faction, No one, Unknown |
| Friends only | Not in current schema; do not hardcode unless future API returns it |
| Live bars/cooldowns | Owner-only / member key and consent required |
| Bars/cooldown access | Current Swagger documents Minimal access key |
| Detailed networth | Current /user/networth is owner-only and requires Limited access |
| Public networth | Use public personalstats total |
| Rate limits | Official docs: up to 100 calls/minute per player across keys; limits may change; design conservatively |
| Service cache | Identical requests may be cached for up to 30 seconds |
| History on departure | Keep weekly/public performance history; remove secrets and private live connections |

## 23. Sources checked

- Torn API docs, including rate limits, caching and key access levels: https://www.torn.com/api.html
- Torn OpenAPI 6.15.0: https://www.torn.com/swagger/openapi.json
- Faction member endpoint contract: https://api-playground.torn.com/faction/:id/members
- Personal stats endpoint contract: https://api-playground.torn.com/user/:id/personalstats
- Generated personalstats response schema and metric-path reference: [TORN-PERSONALSTATS-RESPONSE-SCHEMA.md](TORN-PERSONALSTATS-RESPONSE-SCHEMA.md)
- Official Torn clarification on is_revivable being owner-specific: https://www.torn.com/forums.php?a=0&b=0&f=19&p=threads&t=16496684

---

**Scope rule:** This plan is additive to the existing portal and Halloween work. Do not remove existing Company, Faction, Account Settings, Admin or individualized Halloween event-time features while implementing the faction-performance system. If an API field is unavailable, permission-restricted or changes in the current schema, document that and adapt based on the official contract rather than inventing a field or silently dropping a requirement.
