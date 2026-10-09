# Cloudflare deployment plan

The repository is being prepared for a split deployment:

- **Cloudflare Pages** serves the Vite frontend.
- **Cloudflare Workers** runs the portable Torn API backend from `src/worker/index.ts`.
- **Database and application authentication** remain intentionally deferred.

## API Worker

The Worker exposes:

- `GET /health` for a lightweight health check.
- `GET /api/company/:companyId/profile` for a Torn company profile.
- `GET /api/company/:companyId/employees` for company employee data.

The company ID must be a positive integer. Torn API keys are accepted using the `Authorization: ApiKey <key>` request header. The key is forwarded to Torn by the Worker and is not persisted. Never put a key in a URL, source file, or logs.

For local development, configure a secret only when the Worker has a deliberate server-side authentication boundary in front of it. The initial API does not use a global Torn key because that would expose the same private key to every caller before application authentication exists.

Before production, set `ALLOWED_ORIGIN` to the exact Pages origin. Authentication and authorization must be added before exposing private company data publicly. Do not treat CORS as an authentication mechanism.

## Deployment

1. Install the project's dependencies and verify the existing Vite app builds.
2. Deploy the API Worker with `npx wrangler deploy --config wrangler.toml`.
3. Configure the frontend's API base URL as a Pages environment variable.
4. Connect the GitHub repository to Cloudflare Builds for preview and production deployments.
5. Add database-backed sessions and credential storage only after the non-database backend is stable.

The Worker uses the standard Fetch API and TypeScript, avoiding Node-specific server APIs so it can run on Cloudflare's runtime.
