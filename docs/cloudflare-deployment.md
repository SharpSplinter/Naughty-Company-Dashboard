# Cloudflare deployment

## Projects

- **Pages project:** `naughty-company-dashboard`
- **Pages URL:** https://naughty-company-dashboard.pages.dev
- **API Worker:** https://naughty-company-api.kboone801.workers.dev
- **Git repository:** `SharpSplinter/Naughty-Company-Dashboard`
- **Cloudflare Pages production branch:** `fix/missing-grok-pwa-plugin` while the project is under development; `main` is intentionally untouched.

Pages build settings:

- Build command: `npm run build`
- Output directory: `dist`
- Root directory: repository root
- Build variable: `VITE_API_BASE_URL=https://naughty-company-api.kboone801.workers.dev`

## API Worker

The Worker exposes:

- `GET /health`
- `GET /api/company/:companyId/profile`
- `GET /api/company/:companyId/employees`

The company ID must be a positive integer. Torn API keys are accepted using the `Authorization: ApiKey <key>` request header. The key is forwarded to Torn by the Worker and is not persisted. Never put a key in a URL, source file, or logs.

The Worker maps Torn API error codes into stable HTTP statuses, including rate limits (HTTP 429), invalid keys (HTTP 401), insufficient permissions (HTTP 403), and invalid company IDs (HTTP 400). It accepts requests from the production Pages domain, its Pages preview subdomains, and localhost port 3000 for local development.

## Security notes

Members authenticate with their own limited-access Torn API key. The Worker validates faction membership, encrypts saved Torn credentials at rest, and issues random bearer session tokens while storing only SHA-256 hashes in D1. The browser stores the session token locally; raw Torn keys are not stored in browser storage. Sessions expire after 30 days.

The regular sign-out action revokes the current server-side session. An authenticated all-devices action revokes every active session for that player. Members can also remove a single saved company key without deleting its company history; removing a key that is also required as the login key is blocked until the login key is replaced. Deleting all saved credentials preserves company history. CORS restrictions are useful browser hygiene but are not a replacement for authentication.

## Local development

- Node.js 20+
- `npm ci`
- `npm run dev`
- `npm run build`
- `npm run typecheck`

Cloudflare Pages is configured to build the repository with `npm run build` and publish `dist/`. The first deployment is triggered from the feature branch while `main` remains unchanged.
