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

The PR branch contains migrations through 0025; the portal staging D1 has successfully applied the complete branch chain through 0025 (30 migration records, 64 tables), confirmed on 2026-11-13 by the final isolated D1/Queue integration run #43508964870. Full quality gates passed on run #43508964744. Migration 0019 adds public faction-performance collection runs, membership intervals, roster snapshots, 18-counter public personalstats snapshots and gym-energy snapshots. Migration 0020 adds the idempotent Sunday-boundary run registry; 0021 adds immutable completed-week reports/member results with database-level update/delete protection; and 0022 adds faction-wide stats snapshots. The Worker now includes scheduled public collection, Sunday UTC boundary capture/finalization, active-week rankings, immutable weekly history/comparisons, faction totals, public Live Member Status, and a range-aware 7/30/90-day Faction Activity history sampled from immutable roster captures. Member-specific inactivity trends use each sampled Torn last-action timestamp with explicit 24h/72h/Unknown bands. Administrator-only boundary diagnostics and audited recovery remain available. Historical faction activity acceptance [Run 25](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43512489832) passed against isolated staging D1 and fixture Workers. It verified a 7-day sampled timeline, three member-specific last-action observations (8h, 32h and 79h), exact 24h/72h inactivity bands, and Unknown for a missing timestamp. Full quality gates passed on [run #43512499313](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43512499313); Discord Bot Quality Gates passed on [run #43512499285](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/43512499285). Remaining roadmap work includes member-consented private owner-key bars/cooldowns/detailed networth, richer member drilldowns and filters, operational request-budget reporting, and production readiness/cutover.

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

Live verification on 2026-11-02 called `GET /v2/faction/members?striptags=true` with the repository's faction-enabled key. Torn returned HTTP 200 with 100 member records. The sanitized fixture confirmed these fields are present: id, name, level, days_in_faction, last_action, status, revive_setting, position, is_revivable, is_on_wall, is_in_oc and has_early_discharge. Nested `last_action` contained status/timestamp/relative; nested `status` contained description/details/state/color/until. Member identifiers, names and values were scrubbed before persistence.

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

Use GET /v2/user/{id}/personalstats with a public access key for faction members other than the key owner. For the API-key owner, use GET /v2/user/personalstats. Current owner requests must include a category (for example, cat=popular or cat=all) or a historical stat+timestamp query; a no-category/no-stat request is invalid.

The endpoint response is a union selected by access level and query parameters. The generated response contract supplied for this project defines:

- `UserPersonalStatsFull` when the full selection is requested with a Limited, Full or Custom key; its generated `personalstats` member is `unknown`.
- `UserPersonalStatsFullPublic` for `cat=all`; its generated `personalstats` member is `unknown`.
- `UserPersonalStatsPopular` for `cat=popular`; its generated `personalstats` member is `unknown`.
- `UserPersonalStatsCategory` for another matched category selection. Its generated schema describes nested category objects such as `drugs`, `items`, `other` and `networth`.
- `UserPersonalStatsHistoric` for historical requests using `stat` with `timestamp`; its `personalstats` member is an array of `{ name, value, timestamp }` records.

Torn recommends `cat=popular` over `cat=all` wherever Popular contains the required fields, to reduce server load. The sanitized owner-key capture on 2026-11-02 confirmed that `cat=popular` contains all 18 required dashboard counters, with 0 missing fields. Routine faction-member collection should therefore use Popular only. The separate category calls were also live-verified and are available as narrow fallbacks if a future API shape stops exposing a required counter in Popular.

The owner key was checked through `GET /v2/key/info`; the sanitized result recorded access level 4 (Full Access), without retaining the owner, faction or company identifiers. The owner-only `cat=all` response returned the broad Full shape, including `battle_stats` and an expanded `networth` object. A public target's `cat=all` response corresponds to the generated FullPublic variant. The API's no-category owner request returned HTTP 200 with Torn error code 21 (Incorrect category), so never request `/user/personalstats` without either a category or a historical `stat`+ `timestamp`.

Keep a distinct runtime decoder for current category responses and historic arrays. The generated schema marks the Full, FullPublic and Popular payloads as `unknown`; the captured fixtures now provide sanitized, live shape evidence. Do not cast any payload before validating its runtime structure. For category responses, use the nested property paths in the metric map below.

Use the public current personal-stat response for other faction members. Do not request another player's private stats. Historical `stat` requests require `timestamp`, accept up to 10 statistic names per call (additional names are trimmed), and return a list of records. A returned record's `timestamp` identifies when that particular stat was last updated. Statistics that did not exist at the requested timestamp may be omitted. An omitted item is unknown, not zero. Torn resolves a requested historical timestamp to the nearest date, so historical requests are useful for spot-checking/backfill only and are not the source of truth for exact weekly Sunday boundaries.

The complete generated response contract and decoder notes are maintained in [TORN-PERSONALSTATS-RESPONSE-SCHEMA.md](TORN-PERSONALSTATS-RESPONSE-SCHEMA.md).

#### Phase 0 implementation status: personalstats contract slice

The request builder, runtime decoder, live capture and fixture tests are now implemented on the PR branch:

- `src/lib/torn/personalstats.ts` defines typed request variants for `cat=popular`, `cat=all`, category-specific calls and historical calls. The path builder supports both the owner route (`/user/personalstats`) and public target route (`/user/{id}/personalstats`), and does not allow the invalid no-category request.
- `TornApiClient.getMyPersonalStats()` and `getUserPersonalStatsFor()` share the existing authenticated API transport.
- The decoder validates object envelopes for current responses and array records for historical responses. It keeps missing values null, retains returned per-stat timestamps and reports requested-but-omitted historical stats.
- Manually dispatched GitHub Actions run #14 used the repository's `TORN_API_KEY` secret only in the runner environment. The workflow called only read endpoints and uploaded a 7-day artifact after replacing every numeric value with 0, redacting arbitrary strings and retaining only recognized historical stat enum names and structural field names. It verified owner personalstats, current faction roster, two other members' public personalstats, faction gym-energy contributors and historical batches; all strict acceptance flags passed. The artifact and logs contain no credentials, member identifiers or live stat/contributor values.
- The live capture confirmed `cat=popular` contains all 18 requested metrics: Xanax, LSD, total drugs, overdoses, alcohol, boosters, energy drinks, energy refills, stat enhancers, public total networth and the eight separate drug counters. The required energy-drink metric is `items.used.energy_drinks`, distinct from `items.used.energy`.
- Live category responses confirmed the nested mappings for `drugs`, `items`, `other` and `networth`. These are fallback selections only; normal member polling should use `cat=popular` and avoid extra category calls.
- Historical batches of 10 and 8 stat names returned arrays of `{ name, value, timestamp }`. The sanitized fixture preserves enum names and substitutes a fixed valid timestamp; raw values remain scrubbed.
- The key-info response confirmed access level 4 (Full Access) and a faction-permission field. Only the access level/type and a boolean permission-presence marker were retained.

The decoder has been checked against synthetic fixtures and sanitized live structural fixtures for both the owner route and the public target-member route. During the Phase 1 live probe, two different current faction members were sampled through `/user/{id}/personalstats?cat=popular`; both returned HTTP 200 with all 18 required counters and no missing metric paths. No IDs, names or live values were written to the fixture.

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

Live verification called `GET /v2/faction/contributors?stat=gymenergy` and returned HTTP 200 with 100 contributor records. The sanitized response confirmed exactly the expected four fields: `id`, `username`, `value` and `in_faction`. The actual identifiers, usernames and numeric contributor totals were replaced before the fixture was committed.

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

- Use `cat=popular` for routine public member collection. Live owner-key verification on 2026-11-02 confirmed every one of the 18 required metrics is present in Popular, so no extra category calls are needed for the current dashboard metric set.
- If a future Popular response is missing a required metric, request only the matching category. Use `cat=all` only when the required public data cannot be covered by Popular or a narrower category selection.
- Treat the endpoint as a response union. For the owner route, a Limited/Full/Custom key can receive Full; for another player, `cat=all` returns FullPublic. `cat=popular` returns Popular, category selections return their category variant, and `stat`+`timestamp` returns Historic.
- The generated schema marks Full, FullPublic and Popular `personalstats` payloads as `unknown`. Runtime guards and sanitized live fixtures now validate the captured owner response shapes; continue validating the target-player route during Phase 1.
- Do not request the owner route without a category or historical stat query; the live call returned Torn error 21 (Incorrect category).
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

The optional detailed breakdown is collected only from the member's own /user/networth call, using their canonical sign-in key and explicit opt-in. Do not request another member's private networth breakdown.

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
| Energy | current / maximum from member's own canonical portal key after private-live sharing opt-in |
| Drug cooldown | Remaining value from own key |
| Booster cooldown | Remaining value from own key |
| Medical cooldown | Remaining value from own key |
| Networth | Public total; detailed breakdown only with consent |
| Last refreshed | Per-value freshness |

Filters for revive and inactivity must be independent. Unknown fields remain Unknown. A member without an opted-in portal-key private-live connection shows Not Connected for private live fields.

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
- Missing member portal key does not stop public faction data collection.
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
- [x] Preserve current app architecture; use the existing Torn client, typed Worker library and backend test harness.
- [x] Add a typed personalstats selection/path builder for owner, target, Popular, all, category-specific and historic requests. Current requests always include a category.
- [x] Add runtime-safe separate decoders for current object responses, category paths and historical arrays.
- [x] Add synthetic schema-shaped fixtures and regression tests for selection, nested mappings, omitted historical stats, per-stat timestamps and the 10-stat cap.
- [x] Capture sanitized live owner-key fixtures for Popular, owner Full/All, category-specific and Historic variants via Actions secret `TORN_API_KEY`.
- [x] Verify all 18 requested dashboard metrics are present in Popular; normal collection needs no category fallback.
- [x] Verify category paths and historical `name/value/timestamp` record shape against live sanitized fixtures.
- [x] Confirm the configured key reports access level 4 (Full Access) and faction permission is present, without retaining owner/faction identifiers.
- [x] Exercise the public-member `/user/{id}/personalstats?cat=popular` route against two current faction members; both returned all 18 required counters.
- [ ] Complete the collection request-budget estimate and scheduler strategy with the faction roster size.
- [x] Decide and document historical retention separation before weekly data migrations.
- [x] Define and exercise the Sunday-boundary scheduler, actual-capture timing/late labels, missed/failed-run diagnostics and audited recovery policy in the staging integration acceptance.

### Phase 1 — Faction roster and public-data ingestion

**Implemented on the PR branch and statefully validated against isolated non-production D1/Queues; not deployed to production.**

Live API contract checks and client entry points:

- [x] Verify faction roster response shape with the faction-enabled key; the live response returned 100 members and the required status/revive fields.
- [x] Add `TornApiClient.getFactionMembersForRoster()` using `/faction/members?striptags=true`.
- [x] Verify two other faction members' public `cat=popular` requests; each returned all 18 required public counters.
- [x] Add `TornApiClient.getFactionGymEnergyContributors()` using `stat=gymenergy`.
- [x] Verify live gym-energy contributor response; 100 rows returned with `id`, `username`, `value`, `in_faction`.
- [x] Add migration `0019_faction_performance_collection.sql` for collection runs/state, membership intervals, roster snapshots, 18-metric public-stat snapshots and gym-energy snapshots. These records intentionally have no foreign key to `players`, so departure cleanup cannot cascade-delete public performance history.
- [x] Add the Worker collection pipeline using the dedicated Cloudflare secret `TORN_FACTION_API_KEY`; it never borrows an individual member login key.
- [x] Extend the existing five-minute cron and serialized queue. Roster runs are bucketed every five minutes; Popular stats and gym-energy contributor runs are bucketed every fifteen minutes.
- [x] Make scheduled runs idempotent with a unique collection key, durable run state, resumable five-member stat pages, queue retry/dead-letter handling and safe error summaries.
- [x] Pace public-stat requests by 800 ms between member calls, leaving margin under Torn's 100-request/minute upper bound. Rate-limit, transient upstream and network failures retry the current member rather than being written as a permanent zero/failed sample.
- [x] Persist missing metrics as NULL and classify samples complete/partial/failed. A partial collection does not advance `last_success_at`.
- [x] Add parser, sanitized-live-fixture, migration and Worker scheduling/retry regression checks.
- [x] Add `GET /api/faction/performance`, protected by current faction membership, to return the latest public roster, Popular stats and gym-energy snapshots with per-source timestamps and collection status. It never returns API keys, bars or cooldowns.

Still to implement or validate:

- [x] Apply migration 0019 and subsequent faction-performance migrations to isolated non-production D1; verify the remote migration ledger.
- [x] Exercise the real Worker queue handler, D1 writes, resume across the five-member page boundary, membership join/leave retention, complete-only freshness advancement, weekly finalizer, immutable report triggers, authenticated faction APIs, boundary recovery/audit lock, retry and DLQ behavior. See [staging integration Run 20](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41565717801).
- [ ] Add broader leadership/admin diagnostics for ordinary roster, public-stat and gym-energy collection runs, including partial samples and last successful capture.
- [ ] Run a controlled live collection against the configured Worker secret after deployment, then confirm row counts and captured timestamps. No deployment or production migration has been performed in this work session.

### Phase 2 — Weekly calculation engine

**Active-week and immutable closed-week reporting, 26-week history/comparison, admin diagnostics and audited boundary recovery are implemented on the PR branch. Stateful staging acceptance passed in [Run 20](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41565717801).**

- [x] Add a unique Sunday 00:00 UTC boundary registry and idempotently enqueue dedicated personalstats and gym-energy baseline runs through the existing serialized collection queue.
- [x] Preserve scheduled boundary time separately from each actual API response capture time; expose first-capture timestamps and timing deviation, and label captures more than five minutes late.
- [x] Calculate weekly deltas from the dedicated baseline run and the latest later in-week samples; keep all 18 counters independent, including separate Xanax and LSD.
- [x] Rank faction gym-energy contribution independently from the personalstats counters.
- [x] Keep missing baseline/ending fields unknown and exclude unknown values from ranks and faction totals.
- [x] Flag decreased lifetime counters as anomalies instead of presenting negative usage.
- [x] Mark midweek joiners as partial-week participants using their first observed sample as baseline.
- [x] Include membership intervals overlapping the reporting week so a midweek leaver remains visible, using only samples captured before their observed departure.
- [x] Persist finalized week headers and member deltas after both Sunday ending-boundary runs reach a terminal state.
- [x] Protect report headers and member rows with database triggers that reject updates and deletes; preserve raw source snapshots and actual capture timestamps.
- [x] Use the next Sunday's dedicated boundary run as the ending sample for members still present; use the last observed in-faction sample for a midweek leaver.
- [x] Expose the latest 26 completed reports through an authenticated history API, with prior value, week-over-week change, previous rank and rank movement.
- [x] Add administrator-only Sunday boundary diagnostics for the most recent 26 boundaries, including frozen-cohort size, run status, retry age, expected/captured member counts, first/last actual capture times, timing deviation and adjacent immutable-report references.
- [x] Add audited recovery for a missing boundary only within 24 hours, or for failed/partial/stale existing runs within eight days. Recovery reuses the original frozen cohort and queue run IDs, uses an optimistic status/timestamp claim, and refuses any boundary referenced by either adjacent finalized weekly report.
- [x] Add a read-only-by-default Admin Panel section; recovery actions require enabling admin actions and explicit per-boundary confirmation. Staging integration exercises diagnostics, a failed-run retry through Cloudflare Queues, audit evidence, and the immutable-report 409 lock.

### Phase 3 — Weekly Rankings UI

**Active-week rankings, filtering/sorting, and current/archived member drilldowns implemented on the PR branch.**

- [x] Make Weekly Rankings the default Faction workspace tab while retaining the previous Company directory as a separate tab.
- [x] Show the fixed Sunday 00:00 UTC reporting period, remaining time, boundary run state and actual first-capture timing.
- [x] Add faction summary cards for member count, complete public-stat coverage, Xanax, LSD, alcohol, boosters, energy drinks and gym energy.
- [x] Add independent metric ranking selection across all 18 public counters and gym-energy contribution.
- [x] Display starting and latest public networth balances beside the weekly networth change.
- [x] Show each member's actual baseline/ending capture timestamps and name any decreased counters.
- [x] Add member search and a weekly leaderboard with rank, member, position, weekly deltas and completeness/anomaly/partial-week labels.
- [x] Keep unavailable values as an em dash rather than zero, and keep Xanax/LSD separately ranked.
- [x] Add clickable current-week and archived-week member profiles with member identity, reporting window, data status, participation, known-counter coverage, networth balances, public stats/gym capture timestamps, Sunday-boundary provenance and all weekly metric deltas.
- [x] Add lifetime-counter context alongside weekly deltas and expose per-metric freshness/coverage detail in the member profile, using the immutable baseline/ending source snapshots.
- [x] Add completed-week selection and optional earlier-week comparison, including weekly-value movement and rank movement.
- [x] Add faction-wide lifetime totals from `/faction/stats` with scheduled timestamped snapshots, freshness and missing/unrecognized field reporting in the Faction totals tab.
- [x] Add sortable leaderboard columns, case-insensitive member search, status and participation filters, anomalies-only filtering, result counts and a clear-filters action. Unknown metrics remain below known values in both sort directions; helper behavior is covered by backend regression tests.
- [x] Add lifetime-counter context and finer per-metric freshness detail from the original per-member capture timestamps and NULL-aware source values.

### Phase 4 — Live Member Status and faction activity

**Public-roster Live Member Status, sampled historical faction activity, and member-specific inactivity trends are implemented on the PR branch; manual mobile/accessibility acceptance remains.**

- [x] Display Online / Idle / Offline / Unknown from the latest completed faction roster and use the Unix last-action timestamp for relative time and inactivity.
- [x] Add independent 24-hour and 72-hour inactivity summary counts and filters. Missing timestamps remain Unknown.
- [x] Display public status description/details and a returned status-until timer when the field can be parsed; do not manufacture a hospital reason or countdown.
- [x] Keep the target's configured `revive_setting` separate from owner/key-specific `is_revivable`.
- [x] Display wall, OC and early-discharge flags.
- [x] Add roster capture time, collection freshness warning, search and status filters.
- [x] Add an authenticated, bounded activity feed across sampled completed public rosters. It reports membership interval first-seen/departure observations plus changes in activity state, member status/timer, wall/OC/early-discharge flags, configured revive setting and position. Event times identify the first sampled observation of a change, not an inferred exact event time.
- [x] Add an authenticated 7/30/90-day activity timeline from completed immutable roster snapshots. Sample hourly over 7 days, every 4 hours over 30 days and daily over 90 days; return up to 500 recent observed changes and expose sampling/truncation metadata.
- [x] Add member-specific inactivity trends using the public last-action timestamp at each sampled roster capture, with exact 24-hour and 72-hour thresholds. Missing timestamps remain Unknown, and the range selector/member selector are mobile responsive.

### Phase 5 — Unified member API key and voluntary private live sharing

**The portal uses one owner-verified primary Torn key at sign-in. Company, private-live and Halloween features reuse the encrypted canonical `api_keys` credential; optional secondary company keys are independently encrypted and scoped to the Torn company profile they return. Separate per-feature data-sharing consent remains required. Synthetic Worker tests cover key ownership, consent, encryption, selection minimization, opt-in networth, request throttling and revocation. Real-key company refresh acceptance is now confirmed on staging for primary Full Access, primary Custom Access and secondary company keys; secondary-key add/remove also passed. This company-data acceptance does not yet cover private bars/cooldowns, detailed networth or Halloween historical logs.**

- [x] Add migration 0023 with private-live consent/feature metadata, latest-only snapshots and a per-member API request-throttle table. The canonical member Torn credential remains the single encrypted `api_keys` record; the feature registry does not require a second member key submission.
- [x] Require an authenticated current Naughty Souls session, explicit versioned data-sharing consent, and explicit selection of faction sharing. Reuse the canonical sign-in key and validate its Torn owner ID against the signed-in player before fetching bars, cooldowns or networth.
- [x] Request only the owner's /user/bars and /user/cooldowns selections. Parse and persist an allowlist of four bars and three cooldowns; unknown or missing values remain unknown. Do not retain arbitrary response fields.
- [x] Make detailed /user/networth a separate opt-in. If Torn denies only that optional selection, keep the bars/cooldowns connection and leave detailed networth off. Preserve Torn's networth source timestamp and show it separately from the Worker capture time.
- [x] Keep the canonical portal key encrypted at rest with the existing AES-GCM Worker secret. Feature metadata cannot return ciphertext or plaintext key material. The faction performance API joins only the latest snapshot for members with explicit sharing enabled and excludes disabled accounts.
- [x] Keep the latest snapshot only; no historical private bars/cooldowns archive is created. An owner can refresh through Account Settings; there is no background private-live collector in this phase.
- [x] Enforce one shared 30-second per-member D1 throttle across connect and refresh attempts, including failed key validation, to constrain Torn request volume.
- [x] Allow the owner to disable private-live sharing and delete the current faction-shared snapshot. The canonical portal key remains available to other enabled portal features. Replacing or deleting the portal key invalidates private-live/Halloween opt-in metadata and company-key copies tied to the old credential. Confirmed faction departure removes the canonical credential and private live data. Temporary jail/inactivity/API outages and rate limits retain the last successful snapshot.
- [x] Add Account Settings disclosure and consent controls, owner refresh/disable controls, and an opt-in Live Member Status display for shared values with capture age and separate networth source time. No separate key-entry form is used.
- [x] Add parser allowlist tests, Worker-level synthetic tests for wrong owner/consent/encrypted storage/networth opt-in/request throttle/disconnect, and a dedicated consent/security contract test.
- [x] Apply migration 0023 to isolated staging D1, verify the remote migration ledger and smoke-check all three private-live tables. Staging [Run 21](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41569343997) passed; no production D1 or Worker was contacted.
- [x] Extend stateful staging integration to exercise private-live connect/refresh/revocation routes and the Torn fixture Service Binding with a synthetic authenticated member. [Run 22](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41570310084) passed missing-consent and wrong-owner rejection, encrypted key persistence/decryption, authenticated snapshot read, shared connect/refresh throttle, bars/cooldowns collection, explicit detailed-networth opt-in/source timestamp, disconnect deletion, cleanup, and the full public faction D1/Queue regression. The run confirmed no production D1 or Worker was contacted.
- [x] Confirm real-key company-data refresh acceptance on the isolated staging portal for a primary Full Access key, a primary Custom Access key and secondary company keys; secondary keys were also added and removed successfully. Secondary-key validation is based on the returned company profile/company ID, not equality with the authenticated portal player's Torn ID.
- [ ] Complete separate real-key acceptance for owner-only bars/cooldowns, optional detailed networth and Halloween summaries/historical logs, with each feature's own required Torn selections and explicit consent.
- [ ] Add private-live freshness/error visibility to administrator diagnostics and complete the API request-budget review before considering any scheduled refresh.


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
- Historical inactivity trend retains per-sample timestamp provenance and reports missing timestamps as Unknown.
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
- bars and cooldowns are called only using the member's own canonical portal key after explicit private-live sharing opt-in.
- Detailed networth is called only using the member's own canonical portal key after separate networth opt-in and Torn permission validation.
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
13. Members can voluntarily opt in to live energy/cooldown sharing using the same portal key they use to sign in.
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
| Personal stats | Use cat=popular for routine member polling; live verification found all 18 required dashboard metrics and no missing paths |
| Personalstats implementation | Owner and target request paths plus guarded decoders are implemented; owner/target Popular, category/historic variants have sanitized live fixtures |
| Faction collection runtime | Worker uses TORN_FACTION_API_KEY, five-minute roster and fifteen-minute Popular/gym-energy queue buckets; awaits deployment and D1 integration validation |
| Faction collection throttling | Public member-stat fan-out is five per queue page with 800 ms spacing and retry/backoff for 429/5xx/network failures |
| Faction collection history | Migration 0019 creates no player foreign keys; departure cleanup remains scoped to access/secrets and does not delete faction-performance history |
| Faction performance read API | GET /api/faction/performance requires a current faction session and returns only public roster, public personalstats and gym-energy snapshots; no member credentials or owner-only live fields |
| Personalstats fallback | Category fallback is available but not needed with current Popular coverage; missing paths remain null |
| Personalstats response | Owner route with key access level 4 returned the broad Full shape for cat=all; target route cat=all maps to FullPublic; cat=popular returns Popular; stat+timestamp returns Historic |
| Personalstats route selection | Owner current requests require cat; no-category request produced Torn error 21 (Incorrect category) |
| Current category mapping | Use nested category paths, e.g. drugs.xanax, items.used.energy_drinks, other.refills.energy, networth.total |
| Historical personalstats | stat + timestamp, max 10 stat names; returns name/value/last-updated timestamp records; not the exact weekly boundary source because Torn resolves timestamp to nearest date |
| Gym energy | stat=gymenergy, not gymenergy=true |
| Gym contributor schema | id, username, value, in_faction |
| Revive flags | is_revivable is owner-specific; revive_setting is member preference |
| Current revive enum | Everyone, Friends & faction, No one, Unknown |
| Friends only | Not in current schema; do not hardcode unless future API returns it |
| Member API credential | The primary encrypted `api_keys` credential is owner-verified at sign-in and reused for identity, private-live and Halloween features. Company features use it by default. Optional secondary company keys are encrypted, validated by a successful company-profile response, and stored under the authenticated portal account plus the returned company ID; they do not need to match the portal player's Torn ID |
| Service-owned public company key | `TORN_API_KEY_CUSTOM` is used only for public global-company catalogue/ranking requests; it is not a member credential |
| Faction collection key | `TORN_FACTION_API_KEY` remains dedicated to scheduled public faction collection and is never substituted for a member key |
| Live bars/cooldowns | Owner-only / canonical member portal key and explicit faction-sharing consent required |
| Bars/cooldown access | Current Swagger documents Minimal access key |
| Detailed networth | Current /user/networth is owner-only and requires Limited access; separately opt-in, using the same canonical member key |
| Halloween historical logs | Uses the same canonical member key when Torn reports Full Access or a Custom Access key with User → Log permission; historical data sharing remains separately consented |
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
- Sanitized live response-shape capture workflow: [run #13](https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41525791088)
- Sanitized live mapping/roster/contributor fixture: [scripts/fixtures/torn-personalstats-live-sanitized.json](../scripts/fixtures/torn-personalstats-live-sanitized.json)
- Phase 1 D1 schema: [migrations/auth/0019_faction_performance_collection.sql](../migrations/auth/0019_faction_performance_collection.sql)
- Scheduled collection and queue dispatcher: `src/worker/index.ts` (`TORN_FACTION_API_KEY` is a Cloudflare Worker secret binding; its value is never stored in source).
- Official Torn clarification on is_revivable being owner-specific: https://www.torn.com/forums.php?a=0&b=0&f=19&p=threads&t=16496684

---

**Scope rule:** This plan is additive to the existing portal and Halloween work. Do not remove existing Company, Faction, Account Settings, Admin or individualized Halloween event-time features while implementing the faction-performance system. If an API field is unavailable, permission-restricted or changes in the current schema, document that and adapt based on the official contract rather than inventing a field or silently dropping a requirement.

## Member drilldowns and private-live operations visibility

- The member activity drilldown combines the latest public roster context (level, position, activity/status, wall/OC/early-discharge flags and configured revive setting), the member's sampled last-action trend, and up to ten recent observed changes in the selected range.
- Membership dates are labelled as first observed and estimated join separately; neither is presented as an exact join event. Change timestamps represent when a completed roster first showed the change.
- Administrator-only `/api/admin/private-live` reports opted-in connection metadata, latest successful snapshot age, last attempt/validation timestamps and sanitized last errors. Freshness bands are fresh (15 minutes or less), ageing (over 15 through 60 minutes), stale (over 60 minutes), and no snapshot.
- Private-live refresh remains member-triggered. The admin endpoint never returns bars, cooldowns, networth values, Torn credentials, encryption fields or private snapshot JSON. Staleness is a diagnostic age, not proof that a scheduled collector failed.
- The staging integration exercises rich member profile/event serialization, non-admin denial, stale/error diagnostics, and confirms private-resource and credential fields are absent from the admin response.
