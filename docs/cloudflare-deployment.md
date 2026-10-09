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

The initial API accepts a caller-supplied Torn key and does not use a global shared key. This is not account authentication and no credentials are persisted. The API key is held in frontend component memory and forwarded in an Authorization header.

Database-backed sessions, account authentication, and persisted key management are intentionally deferred. CORS restrictions are useful browser hygiene but are not a replacement for authentication.

## Local development

- Node.js 20+
- `npm ci`
- `npm run dev`
- `npm run build`
- `npm run typecheck`

Cloudflare Pages is configured to build the repository with `npm run build` and publish `dist/`. The first deployment is triggered from the feature branch while `main` remains unchanged.
