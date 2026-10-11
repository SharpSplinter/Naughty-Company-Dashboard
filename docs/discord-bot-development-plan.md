# Naughty Company Discord Bot: Full Development Plan

## Scope and deployment boundary

The bot is a companion client for Naughty Company Dashboard. Development and tests must target the dedicated `naughty-company-bot-staging` Worker and the Discord test guild only. No production dashboard Worker, Pages project, D1 database, or production Discord guild should be modified as part of staging work.

## Architecture

- Discord interactions are verified with Ed25519 against the configured Discord public key; reject stale timestamps and invalid signatures before parsing commands.
- Keep slash-command responses ephemeral by default. Never echo API keys, dashboard session tokens, raw Torn responses, or provider error bodies.
- Account linking uses a Discord modal, never a public slash-command option or ordinary chat message for credentials.
- Exchange the member's limited Torn API key with the dashboard sign-in endpoint. Persist only the resulting dashboard session token, encrypted at rest in a bot-specific D1 database. Bind the record to the Discord user ID and the dashboard player ID returned by the server. Do not trust a user-supplied player/company ID as proof of ownership.
- Derive a key-encryption key from a dedicated Worker secret (AES-GCM, random 96-bit IV per encryption). If the secret is rotated, provide an explicit relink/re-encryption procedure. Never log decrypted credentials.
- All dashboard reads use the stored session as `Authorization: Bearer …`; only call member-scoped `/api/me/*` routes. Do not call admin routes or accept another member's owner/player ID.
- Use a bot-owned D1 database for Discord links, alert subscriptions, and delivery deduplication. Do not add Discord identity/link tables to the production dashboard database.
- Bound all fetches with timeouts, handle 401 by asking the user to relink, and rate-limit each Discord user. Use no-store responses for credential-bearing operations.

## Command surface

### Account
- `/link`: open a modal for the limited Torn API key; validate through dashboard sign-in; encrypt and store the resulting session token.
- `/unlink`: remove the current Discord user's link and alert subscriptions.
- `/status`: show linked player, link age, and whether the session is still valid without showing secrets.

### Company data
- `/company`: list connected companies or show a selected owned company's profile, daily/weekly income, profit where present, advertising budget, star rating, employee count, stock and freshness timestamp.
- `/employees`: display a paginated employee roster, wage totals, and available employee warnings. Keep private employee details out of public channels.
- `/rankings`: show company/faction rankings only where the dashboard's member-scoped data contract provides them; never infer missing rankings.
- `/trends`: query `/api/me/companies/{id}/history`, with supported windows 7, 30, 90, 365 days or all, and summarize change from first to latest available snapshot.
- `/alerts`: list recent dashboard alerts and configure bot-side subscriptions without creating duplicate deliveries.

### Operations
- `/help`: describe commands, privacy, and linking.
- `/ping`: basic interaction health check.
- All data commands default to ephemeral replies, cap output length, paginate large results, and state when data is stale or unavailable.

## Notifications

- Poll only the authenticated member's dashboard alert endpoint, on a bounded schedule or a user-initiated refresh.
- Store a delivery fingerprint and last-seen cursor in bot D1 to avoid duplicate notifications.
- Support per-user enable/disable and severity preferences. Respect Discord rate limits and back off on 429/5xx.
- Do not store Discord webhook URLs or post credentials in logs. Prefer bot-authenticated channel delivery with explicit guild/channel permissions.

## Data and migration

The bot D1 database should contain:
- `discord_links`: Discord user ID (primary key), dashboard player ID/name, encrypted session ciphertext, IV, expiry, linked/updated timestamps.
- `alert_preferences`: Discord user ID, enabled flag, severity selection, optional destination channel, update timestamp.
- `alert_deliveries`: Discord user ID, event fingerprint, delivered timestamp, unique constraint for deduplication.

Never store a plaintext Torn key. Session tokens must be encrypted at rest. Unlink deletes the encrypted session and associated preferences/deduplication state. Do not log interaction bodies for modal submissions.

## Acceptance criteria

1. Invalid signature and stale timestamp tests are rejected; Discord PING and `/ping` pass.
2. `/link` opens a modal and the modal submit is ephemeral. Invalid/expired/revoked keys are handled without echoing input.
3. Two Discord users can link independently; one user cannot access the other's companies by altering command options.
4. `/unlink` removes access immediately and `/status` reports unlinked state.
5. Company, employee, trend, ranking, and alert commands handle empty, stale, malformed, and unavailable data without crashing or leaking secrets.
6. Alerts deduplicate, respect preferences and rate limits, and can be disabled.
7. Automated tests cover signature verification, encryption/decryption, authorization boundaries, output formatting, and command registration payloads.
8. The staging Worker health check and all commands are verified in the test guild before any separately authorized production rollout.
9. A non-admin dashboard account completes end-to-end linking and verifies that admin-only routes remain inaccessible.

## Implementation order

1. Isolated staging Worker, D1 schema, environment bindings, CI checks and command registration.
2. Secure link/unlink/status and tests.
3. Company and employee commands.
4. Trends and rankings with explicit data-contract checks.
5. Alerts, delivery deduplication, preferences, and operational hardening.
6. Staging end-to-end verification and runbook.
