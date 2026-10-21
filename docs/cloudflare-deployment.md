# Cloudflare deployment

## Projects

- **Pages project:** `naughty-company-dashboard`
- **Pages URL:** https://naughty-company-dashboard.pages.dev
- **API Worker:** https://naughty-company-api.kboone801.workers.dev
- **Git repository:** `SharpSplinter/Naughty-Company-Dashboard`
- **Cloudflare Pages production branch:** `main`

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

Normal Torn sign-in always starts with standard-user permissions. The allowlisted owner player ID (`351311`) is permitted to request a separate administrator step-up, but the player ID alone does not grant administrator access. Successful step-up requires the `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` Cloudflare Worker secrets and elevates only the current session for 30 minutes. Every `/api/admin/*` request checks the session's server-side elevation expiry. Elevation can be revoked explicitly or by signing out; it expires automatically. Five failed attempts in a 15-minute window lock that player/IP attempt key for 15 minutes. The Worker fails closed if either administrator secret is missing or malformed.

### Configure administrator step-up credentials

Do this before deploying the step-up implementation, or administration will remain unavailable by design:

1. Choose a strong, unique administrator password of at least 16 characters. Do not send it in chat or commit it to the repository.
2. Generate a PBKDF2-SHA-256 hash locally without putting the password in shell history:

   ```sh
   read -s -p "Administrator password: " ADMIN_PASSWORD
   echo
   export ADMIN_PASSWORD
   node scripts/hash-admin-password.mjs
   unset ADMIN_PASSWORD
   ```

   Copy the emitted `pbkdf2-sha256$...` value temporarily. The helper uses 210,000 PBKDF2 iterations and a random 16-byte salt.
3. From the repository root, run `npx wrangler secret put ADMIN_USERNAME` and enter the administrator username when prompted.
4. Run `npx wrangler secret put ADMIN_PASSWORD_HASH` and paste the generated hash when prompted. Never set either value as a public `vars` entry or add it to GitHub.
5. Verify both secrets exist in the correct production Worker environment before merging/deploying the change. Rotate them with `wrangler secret put` if needed.

The regular sign-out action revokes the current server-side session and its elevation. An authenticated all-devices action revokes every active session for that player. Members can also remove a single saved company key without deleting its company history; removing a key that is also required as the login key is blocked until the login key is replaced. Deleting all saved credentials preserves company history. CORS restrictions are useful browser hygiene but are not a replacement for authentication.

## Administrator step-up authentication

Every Torn sign-in receives standard-user access. The primary owner Torn player ID is only an allowlist for *requesting* administrator elevation; it does not grant administrator privileges by itself. Access to every `/api/admin/*` route requires an active, server-checked elevation bound to the authenticated session. Elevation lasts 30 minutes and can be revoked explicitly or by signing out.

Before deploying a Worker version that requires step-up authentication, configure both secrets. If either is absent or invalid, administrator elevation fails closed and admin endpoints remain inaccessible.

1. Run `node scripts/generate-admin-password-hash.mjs` in a private interactive terminal. Type a unique passphrase of at least 14 characters; it is not echoed. The script prints a PBKDF2-SHA-256 hash, not the password.
2. Configure the administrator username as a Worker secret: `npx wrangler secret put ADMIN_USERNAME`.
3. Configure the generated hash as a Worker secret: `npx wrangler secret put ADMIN_PASSWORD_HASH`. Paste the generated hash into Wrangler's prompt. Never commit the username, password, or hash to the repository or expose them in build logs.
4. Deploy only after both secrets are present, then test that a normal Torn session is non-admin by default, the owner can elevate with the separate credentials, wrong credentials are rejected, and an unelevated session receives HTTP 403 for admin APIs.

The Worker verifies hashes in the format `pbkdf2-sha256$iterations$salt-base64$digest-base64`, using PBKDF2 with SHA-256 and 210,000 iterations from the supplied helper. Five failed attempts within 15 minutes trigger a 15-minute lockout keyed by the owner identity and a hashed Cloudflare client-IP value. Failure messages are generic; secrets and raw passwords are never written to D1 or application logs.

The account allowlist is intentionally narrow: only the configured primary owner Torn player ID can elevate. The username/password pair does not let arbitrary faction members obtain admin access. Keep the owner player ID allowlist under source review and do not add other identities without an explicit security review.

## Local development

- Node.js 20+
- `npm ci`
- `npm run dev`
- `npm run build`
- `npm run typecheck`

Cloudflare Pages production deployments build the repository's `main` branch with `npm run build` and publish `dist/`.
