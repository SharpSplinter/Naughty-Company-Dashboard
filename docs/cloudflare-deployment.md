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

The Pages project has been created and connected to the repository in Cloudflare's project configuration. At initial verification, no deployment had yet been reported by the Pages API, so the Pages URL may not serve a successful build until the first build completes.

## API Worker

The Worker exposes:

- `GET /health`
- `GET /api/company/:companyId/profile`
- `GET /api/company/:companyId/employees`

The company ID must be a positive integer. Torn API keys are accepted using the `Authorization: ApiKey <key>` request header. The key is forwarded to Torn by the Worker and is not persisted. Never put a key in a URL, source file, or logs.

The first Worker was uploaded through the Cloudflare API. The live health URL has not been successfully verified from the current execution environment, so the source configuration remains the intended source of truth.

## Security notes

The initial API accepts a caller-supplied Torn key and does not use a global shared key. The deployed prototype currently allows broad CORS for integration testing. Before production, restrict the allowed origin and ensure the deployed Worker matches `src/worker/index.ts`. Authentication and authorization must be added before exposing private company data publicly. CORS is not authentication.

Database-backed sessions, account authentication, and persisted key management are intentionally deferred.

## Local development

- Node.js 20+
- `npm install`
- `npm run dev`
- `npm run build`
- `npm run typecheck`
