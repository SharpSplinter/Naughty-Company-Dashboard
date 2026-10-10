# Naughty Company Dashboard

A React + Vite dashboard for Torn company operations, designed for Cloudflare Pages with a separate Cloudflare Worker API.

## Local development

- Install Node.js 20 or later.
- Run `npm install`.
- Run `npm run dev` to start the frontend.
- Run `npm run build` to create the production static site in `dist/`.
- Run `npm run typecheck` to check TypeScript.

## Cloudflare Pages

Connect this repository to Cloudflare Pages using:

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root

Set `VITE_API_BASE_URL` to the deployed API Worker origin if it differs from the current development endpoint.

## Account security and Torn API

Members sign in with a limited-access Torn API key. The Worker validates faction membership, encrypts saved API credentials at rest, and issues a random bearer session token whose SHA-256 hash is stored in D1. The browser stores the session token locally; the Torn API key itself is not written to browser storage. Sessions expire after 30 days, and sign-out revokes the current server-side session. Account security controls also support revoking every active session for the signed-in player.

Use the minimum Torn permissions needed, avoid signing in on shared devices, and never share API keys or session tokens. CORS is browser hygiene, not an authentication boundary. Deleting saved credentials does not delete recorded company history. Members can remove an individual company key from connection settings without deleting that company’s saved history; a connection that also serves as the login key must be replaced before it can be disconnected.

## Intelligence and automation

See [Automation Center](docs/automation-center.md) for alert rules, notification preferences, quiet hours, and webhook delivery. See [Company Intelligence Workspaces](docs/company-intelligence.md) for API health, data freshness, historical comparisons, roster insights, executive overview, and saved dashboard layouts. Apply pending files in `migrations/auth/` to D1 before deploying Worker routes that depend on new schema.
