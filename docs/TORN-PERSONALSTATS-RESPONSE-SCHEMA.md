# Torn `/user/personalstats` response schema snapshot

> Generated response-schema reference, supplemented with sanitized live owner-key captures from 2026-11-02. All numeric values in the live fixture are replaced with zero; arbitrary strings are redacted. No API key, player ID, faction ID or live player-stat value is retained.

Endpoints:
- Owner: `GET /v2/user/personalstats`
- Public target: `GET /v2/user/{id}/personalstats`

For current requests, specify `cat=popular`, `cat=all` or a category. For historical requests, specify `stat` plus `timestamp`. A no-category/no-stat request to the owner endpoint returned Torn error 21 (Incorrect category) in the live probe.

## Response selection

```ts
type UserPersonalStatsResponse =
  | UserPersonalStatsFull
  | UserPersonalStatsFullPublic
  | UserPersonalStatsPopular
  | UserPersonalStatsCategory
  | UserPersonalStatsHistoric;

interface UserPersonalStatsFull {
  personalstats: unknown;
}

interface UserPersonalStatsFullPublic {
  personalstats: unknown;
}

interface UserPersonalStatsPopular {
  personalstats: unknown;
}

/** Schema name corresponds to the requested category. */
interface UserPersonalStatsCategory {
  personalstats:
    | PersonalStatsAttackingPublic
    | PersonalStatsJobsPublic
    | PersonalStatsTrading
    | PersonalStatsJail
    | PersonalStatsHospital
    | PersonalStatsFinishingHits
    | PersonalStatsCommunication
    | PersonalStatsCrimes
    | PersonalStatsBounties
    | PersonalStatsItems
    | PersonalStatsTravel
    | PersonalStatsDrugs
    | PersonalStatsMissions
    | PersonalStatsRacing
    | PersonalStatsNetworthPublic
    | PersonalStatsOther;
}

interface UserPersonalStatsHistoric {
  personalstats: PersonalStatsHistoricStat[];
}

interface PersonalStatsHistoricStat {
  /** Requested stat name. */
  name: string;
  value: number;
  /** Timestamp when the stat was last updated. */
  timestamp: number;
}
```

## Category response types

```ts
interface PersonalStatsAttackingPublic {
  attacking: PersonalStatsAttackingPublicAttacking;
}

interface PersonalStatsAttackingPublicAttacking {
  attacks: PersonalStatsAttackingPublicAttackingAttacks;
  defends: PersonalStatsAttackingPublicAttackingDefends;
  elo: number;
  unarmored_wins: number;
  highest_level_beaten: number;
  escapes: PersonalStatsAttackingPublicAttackingEscapes;
  killstreak: PersonalStatsAttackingPublicAttackingKillstreak;
  hits: PersonalStatsAttackingPublicAttackingHits;
  damage: PersonalStatsAttackingPublicAttackingDamage;
  networth: PersonalStatsAttackingPublicAttackingNetworth;
  ammunition: PersonalStatsAttackingPublicAttackingAmmunition;
  faction: PersonalStatsAttackingPublicAttackingFaction;
}

interface PersonalStatsAttackingPublicAttackingAttacks {
  won: number;
  lost: number;
  stalemate: number;
  assist: number;
  stealth: number;
}

interface PersonalStatsAttackingPublicAttackingDefends {
  won: number;
  lost: number;
  stalemate: number;
  total: number;
}

interface PersonalStatsAttackingPublicAttackingEscapes {
  player: number;
  foes: number;
}

interface PersonalStatsAttackingPublicAttackingKillstreak {
  best: number;
}

interface PersonalStatsAttackingPublicAttackingHits {
  success: number;
  miss: number;
  critical: number;
  one_hit_kills: number;
}

interface PersonalStatsAttackingPublicAttackingDamage {
  total: number;
  best: number;
}

interface PersonalStatsAttackingPublicAttackingNetworth {
  money_mugged: number;
  largest_mug: number;
  items_looted: number;
}

interface PersonalStatsAttackingPublicAttackingAmmunition {
  total: number;
  special: number;
  hollow_point: number;
  tracer: number;
  piercing: number;
  incendiary: number;
}

interface PersonalStatsAttackingPublicAttackingFaction {
  respect: number;
  retaliations: number;
  ranked_war_hits: number;
  raid_hits: number;
  territory: PersonalStatsAttackingPublicAttackingFactionTerritory;
}

interface PersonalStatsAttackingPublicAttackingFactionTerritory {
  wall_joins: number;
  wall_clears: number;
  wall_time: number;
}

interface PersonalStatsJobsPublic {
  jobs: PersonalStatsJobsPublicJobs;
}

interface PersonalStatsJobsPublicJobs {
  job_points_used: number;
  trains_received: number;
}

interface PersonalStatsTrading {
  trading: PersonalStatsTradingTrading;
}

interface PersonalStatsTradingTrading {
  items: PersonalStatsTradingTradingItems;
  trades: number;
  points: PersonalStatsTradingTradingPoints;
  bazaar: PersonalStatsTradingTradingBazaar;
  item_market?: PersonalStatsTradingTradingItemMarket;
}

interface PersonalStatsTradingTradingItems {
  bought: PersonalStatsTradingTradingItemsBought;
  auctions: PersonalStatsTradingTradingItemsAuctions;
  sent: number;
}

interface PersonalStatsTradingTradingItemsBought {
  market: number;
  shops: number;
}

interface PersonalStatsTradingTradingItemsAuctions {
  won: number;
  sold: number;
}

interface PersonalStatsTradingTradingPoints {
  bought: number;
  sold: number;
}

interface PersonalStatsTradingTradingBazaar {
  customers: number;
  sales: number;
  profit: number;
}

interface PersonalStatsTradingTradingItemMarket {
  customers: number;
  sales: number;
  revenue: number;
  fees: number;
}

interface PersonalStatsJail {
  jail: PersonalStatsJailJail;
}

interface PersonalStatsJailJail {
  times_jailed: number;
  busts: PersonalStatsJailJailBusts;
  bails: PersonalStatsJailJailBails;
}

interface PersonalStatsJailJailBusts {
  success: number;
  fails: number;
}

interface PersonalStatsJailJailBails {
  amount: number;
  fees: number;
}

interface PersonalStatsHospital {
  hospital: PersonalStatsHospitalHospital;
}

interface PersonalStatsHospitalHospital {
  times_hospitalized: number;
  medical_items_used: number;
  blood_withdrawn: number;
  reviving: PersonalStatsHospitalHospitalReviving;
}

interface PersonalStatsHospitalHospitalReviving {
  skill: number;
  revives: number;
  revives_received: number;
}

interface PersonalStatsFinishingHits {
  finishing_hits: PersonalStatsFinishingHitsFinishingHits;
}

interface PersonalStatsFinishingHitsFinishingHits {
  heavy_artillery: number;
  machine_guns: number;
  rifles: number;
  sub_machine_guns: number;
  shotguns: number;
  pistols: number;
  temporary: number;
  piercing: number;
  slashing: number;
  clubbing: number;
  mechanical: number;
  hand_to_hand: number;
}

interface PersonalStatsCommunication {
  communication: PersonalStatsCommunicationCommunication;
}

interface PersonalStatsCommunicationCommunication {
  mails_sent: PersonalStatsCommunicationCommunicationMailsSent;
  classified_ads: number;
  personals: number;
}

interface PersonalStatsCommunicationCommunicationMailsSent {
  total: number;
  friends: number;
  faction: number;
  colleagues: number;
  spouse: number;
}

/** Response for PersonalStatsCrimes depends on which crime version user is currently. */
interface PersonalStatsCrimes {
  crimes: PersonalStatsCrimesV1 | PersonalStatsCrimesV2;
}

interface PersonalStatsCrimesV1 {
  total: number;
  sell_illegal_goods: number;
  theft: number;
  auto_theft: number;
  drug_deals: number;
  computer: number;
  fraud: number;
  murder: number;
  other: number;
  organized_crimes: number;
  version: string;
}

interface PersonalStatsCrimesV2 {
  offenses: PersonalStatsCrimesV2Offenses;
  skills: PersonalStatsCrimesV2Skills;
  version: string;
}

interface PersonalStatsCrimesV2Offenses {
  vandalism: number;
  fraud: number;
  theft: number;
  counterfeiting: number;
  illicit_services: number;
  cybercrime: number;
  extortion: number;
  illegal_production: number;
  organized_crimes: number;
  total: number;
}

interface PersonalStatsCrimesV2Skills {
  search_for_cash: number;
  bootlegging: number;
  graffiti: number;
  shoplifting: number;
  pickpocketing: number;
  card_skimming: number;
  burglary: number;
  hustling: number;
  disposal: number;
  cracking: number;
  forgery: number;
  scamming: number;
  arson: number;
}

interface PersonalStatsBounties {
  bounties: PersonalStatsBountiesBounties;
}

interface PersonalStatsBountiesBounties {
  placed: PersonalStatsBountiesBountiesPlaced;
  collected: PersonalStatsBountiesBountiesCollected;
  received: PersonalStatsBountiesBountiesReceived;
}

interface PersonalStatsBountiesBountiesPlaced {
  amount: number;
  value: number;
}

interface PersonalStatsBountiesBountiesCollected {
  amount: number;
  value: number;
}

interface PersonalStatsBountiesBountiesReceived {
  amount: number;
  value: number;
}

interface PersonalStatsItems {
  items: PersonalStatsItemsItems;
}

interface PersonalStatsItemsItems {
  found: PersonalStatsItemsItemsFound;
  trashed: number;
  used: PersonalStatsItemsItemsUsed;
  viruses_coded: number;
}

interface PersonalStatsItemsItemsFound {
  city: number;
  dump: number;
  easter_eggs: number;
}

interface PersonalStatsItemsItemsUsed {
  books: number;
  boosters: number;
  consumables: number;
  candy: number;
  alcohol: number;
  energy_drinks: number;
  stat_enhancers: number;
  easter_eggs: number;
}

interface PersonalStatsTravel {
  travel: PersonalStatsTravelTravel;
}

interface PersonalStatsTravelTravel {
  total: number;
  time_spent: number;
  items_bought: number;
  hunting: PersonalStatsTravelTravelHunting;
  attacks_won: number;
  defends_lost: number;
  argentina: number;
  canada: number;
  cayman_islands: number;
  china: number;
  hawaii: number;
  japan: number;
  mexico: number;
  united_arab_emirates: number;
  united_kingdom: number;
  south_africa: number;
  switzerland: number;
}

interface PersonalStatsTravelTravelHunting {
  skill: number;
}

interface PersonalStatsDrugs {
  drugs: PersonalStatsDrugsDrugs;
}

interface PersonalStatsDrugsDrugs {
  cannabis: number;
  ecstasy: number;
  ketamine: number;
  lsd: number;
  opium: number;
  pcp: number;
  shrooms: number;
  speed: number;
  vicodin: number;
  xanax: number;
  total: number;
  overdoses: number;
  rehabilitations: PersonalStatsDrugsDrugsRehabilitations;
}

interface PersonalStatsDrugsDrugsRehabilitations {
  amount: number;
  fees: number;
}

interface PersonalStatsMissions {
  missions: PersonalStatsMissionsMissions;
}

interface PersonalStatsMissionsMissions {
  missions: number;
  contracts: PersonalStatsMissionsMissionsContracts;
  credits: number;
}

interface PersonalStatsMissionsMissionsContracts {
  total: number;
  duke: number;
}

interface PersonalStatsRacing {
  racing: PersonalStatsRacingRacing;
}

interface PersonalStatsRacingRacing {
  skill: number;
  points: number;
  races: PersonalStatsRacingRacingRaces;
}

interface PersonalStatsRacingRacingRaces {
  entered: number;
  won: number;
}

interface PersonalStatsNetworthPublic {
  networth: PersonalStatsNetworthPublicNetworth;
}

interface PersonalStatsNetworthPublicNetworth {
  total: number;
}

interface PersonalStatsOther {
  other: PersonalStatsOtherOther;
}

interface PersonalStatsOtherOther {
  activity: PersonalStatsOtherOtherActivity;
  awards: number;
  merits_bought: number;
  refills: PersonalStatsOtherOtherRefills;
  donator_days: number;
  ranked_war_wins: number;
}

interface PersonalStatsOtherOtherActivity {
  /** Time played in seconds. */
  time: number;
  streak: PersonalStatsOtherOtherActivityStreak;
}

interface PersonalStatsOtherOtherActivityStreak {
  best: number;
  current: number;
}

interface PersonalStatsOtherOtherRefills {
  energy: number;
  nerve: number;
  token: number;
}
```

## Dashboard metric mapping

The current category schema describes nested object paths. The historical-stat `name` values are separate API identifiers; do not use those names as property paths in a current category response.

| Dashboard metric | Category response path | Historical `stat` name |
|---|---|---|
| Xanax taken | `drugs.xanax` | `xantaken` |
| LSD taken | `drugs.lsd` | `lsdtaken` |
| Total drugs used | `drugs.total` | `drugsused` |
| Overdoses | `drugs.overdoses` | `overdosed` |
| Alcohol used | `items.used.alcohol` | `alcoholused` |
| Boosters used | `items.used.boosters` | `boostersused` |
| Energy drinks used | `items.used.energy_drinks` | `energydrinkused` |
| Energy refills | `other.refills.energy` | `refills` |
| Stat enhancers used | `items.used.stat_enhancers` | `statenhancersused` |
| Public total networth | `networth.total` | `networth` |
| Cannabis used | `drugs.cannabis` | `cantaken` |
| Ecstasy used | `drugs.ecstasy` | `exttaken` |
| Ketamine used | `drugs.ketamine` | `kettaken` |
| Opium used | `drugs.opium` | `opitaken` |
| Shrooms used | `drugs.shrooms` | `shrtaken` |
| Speed used | `drugs.speed` | `spetaken` |
| PCP used | `drugs.pcp` | `pcptaken` |
| Vicodin used | `drugs.vicodin` | `victaken` |

This table is the intended mapping for the supplied generated category schema. Confirm every mapping against sanitized live fixtures for each response variant before production ingestion. In particular, do not assume the generated `unknown` payloads for `Popular`, `FullPublic` or `Full` have exactly the same shape without fixture validation.

## Selection and historical-query behavior

- `UserPersonalStatsFull` is returned for the key owner's full selection when the key has Limited, Full or Custom access.
- For a public target player, `cat=all` returns `UserPersonalStatsFullPublic`.
- For the key owner, the live `cat=all` call with the configured level-4 Full Access key returned the broader Full shape. The sanitized live capture recorded only key access level/type, never the owner's identifiers.
- `cat=popular` returns `UserPersonalStatsPopular`. Torn recommends using Popular over FullPublic wherever the requested metrics are covered, to reduce server load.
- Other category selections return `UserPersonalStatsCategory` for the matched category.
- The live owner-key Popular response contained all 18 required faction dashboard counters, with no missing metric paths. Routine faction-member collection should use `cat=popular`; current requested counters do not require fallback category requests.
- Live category captures verified `drugs`, `items`, `other` and `networth` object shapes. In Items, `used.energy` and `used.energy_drinks` are distinct fields; the dashboard energy-drink counter maps only to `items.used.energy_drinks`.
- The owner-only Full response for `cat=all` contained additional top-level sections including `battle_stats`, `trading`, `investments`, `missions` and `racing`, plus a detailed `networth` breakdown. Do not store or expose that owner-only breakdown for other members; public faction networth uses only `networth.total`.
- Historical stats are requested with the `stat` query parameter and a `timestamp`. Up to 10 historical stat names can be requested in one call; additional names are trimmed.
- Historical calls return `UserPersonalStatsHistoric`, whose `personalstats` is an array of `{ name, value, timestamp }` records. Live probes successfully returned arrays for both a 10-name batch and an 8-name batch.
- Each historic record's `timestamp` is when that stat was last updated. It is not proof that the value was sampled exactly at the requested timestamp.
- Stats that did not exist at the requested timestamp may be omitted. An omitted item is unknown/unavailable, never zero.
- Torn may resolve a requested historical timestamp to the nearest date. Historical calls must not replace the application's own exact Sunday-boundary snapshots.

The committed live fixture at `scripts/fixtures/torn-personalstats-live-sanitized.json` is a minimized projection of the Actions capture. All numbers are placeholders; it demonstrates presence and nesting only, not anyone's actual stats.

## Decoder and fixture requirements

1. Model the response as a union with separate runtime validation for owner Full, target-player FullPublic, Popular, category-specific and Historic response variants.
2. Full, FullPublic and Popular remain generated as `unknown` in the OpenAPI schema. The live owner-key fixtures establish the captured response paths, but runtime guards remain required.
3. For category responses, decode the wrapper and the selected category object, then map using the nested category paths above.
4. For historical responses, decode an array and map by each item's `name`; retain each item's returned `timestamp` independently.
5. Validate values as finite numbers. Preserve missing fields as null/unknown.
6. Keep the current lifetime counter representation separate from historical-stat samples and from the application's own captured-at snapshots.
7. The synthetic and sanitized live fixtures cover Popular, owner Full/All, each needed category, Historic arrays, omitted historical stats, more than 10 requested stat names and partial category objects.
8. The live fixture's numeric values are intentionally zeroed and its historical timestamps are fixed placeholders. Never use them as sample member totals or real-time data.

## Live verification record (2026-11-02)

A manually dispatched GitHub Actions workflow used the existing repository secret `TORN_API_KEY` only inside the runner environment. It called owner read endpoints and uploaded a sanitized artifact retained for seven days. The action log never printed the key or raw response bodies.

- `GET /key/info` returned access level 4, type `Full Access`, and a populated faction-permission field. Only access level/type and a boolean permission-presence marker were retained.
- `GET /user/personalstats?cat=popular` returned HTTP 200 and all 18 required dashboard counters.
- `cat=all`, `cat=drugs`, `cat=items`, `cat=other`, and `cat=networth` returned HTTP 200 with object payloads.
- Two historical requests (10 stat names and 8 stat names) returned HTTP 200 with array payloads.
- The invalid owner route without `cat` or `stat` returned Torn error 21, Incorrect category.

Workflow: https://github.com/SharpSplinter/Naughty-Company-Dashboard/actions/runs/41524558224

Committed sanitized fixture: `scripts/fixtures/torn-personalstats-live-sanitized.json`.
