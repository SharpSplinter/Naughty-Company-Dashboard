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

## Torn API

The frontend sends the API key to the Worker in the `Authorization: ApiKey <key>` header. The key is held only in component memory and is not written to browser storage. This is a development-stage connection flow, not account authentication. Do not use shared devices, and do not treat CORS as a security boundary.

Database-backed sessions, account authentication, and persisted key management are intentionally deferred.

## Intelligence and automation

See [Automation Center](docs/automation-center.md) for alert rules, notification preferences, quiet hours, and webhook delivery. See [Company Intelligence Workspaces](docs/company-intelligence.md) for API health, data freshness, historical comparisons, roster insights, executive overview, and saved dashboard layouts. Apply pending files in `migrations/auth/` to D1 before deploying Worker routes that depend on new schema.
