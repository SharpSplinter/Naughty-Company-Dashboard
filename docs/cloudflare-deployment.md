# Cloudflare deployment plan

The repository is being prepared for a split deployment:

- **Cloudflare Pages** serves the Vite frontend.
- **Cloudflare Workers** runs the portable Torn API backend from `src/worker/index.ts`.
- **Database and application authentication** remain intentionally deferred.

## Initial API Worker

The first Worker has been created in the Cloudflare account at:

- Base URL: `https://naughty-company-api.kboone801.workers.dev`
- Health endpoint: `GET /health`
- Company profile: `GET /api/company/:companyId/profile`
- Company employees: `GET /api/company/:companyId/employees`

The company ID must be a positive integer. Torn API keys are accepted using the `Authorization: ApiKey <key>` request header. The key is forwarded to Torn by the Worker and is not persisted. Never put a key in a URL, source file, or logs.

The live Worker was uploaded through the Cloudflare API. Its deployment was accepted by Cloudflare, but an end-to-end runtime request has not yet been independently verified.

## Security notes

The initial API does not use a global Torn key because that would expose the same private key to every caller before application authentication exists. The current Worker accepts a caller-supplied key and has broad CORS enabled for early integration testing.

Before production, set `ALLOWED_ORIGIN` to the exact Pages origin and make the deployed Worker configuration match the source configuration. Authentication and authorization must be added before exposing private company data publicly. Do not treat CORS as an authentication mechanism.

## Deployment

1. Restore and verify the existing frontend's dependencies and build.
2. Keep the Worker source of truth in `src/worker/index.ts` and deploy it with `npx wrangler deploy --config wrangler.toml`.
3. Configure the frontend's API base URL as a Pages environment variable.
4. Connect the GitHub repository to Cloudflare Builds for preview and production deployments.
5. Add database-backed sessions and credential storage only after the non-database backend is stable.

The Worker uses the standard Fetch API and TypeScript, avoiding Node-specific server APIs so it can run on Cloudflare's runtime.
