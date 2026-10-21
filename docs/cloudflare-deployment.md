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

The Worker exposes health, authenticated dashboard, company intelligence, automation, and administrator routes. The current health check is `GET /health`. Company IDs must be positive integers. Torn API keys are validated through the Worker; never put a key in a URL, source file, or logs.

The Worker maps Torn API errors into stable HTTP statuses and accepts browser requests from the production Pages domain, Pages preview subdomains, and localhost port 3000 for local development.

## Security notes

Members authenticate with their own limited-access Torn API key. The Worker validates Naughty Souls faction membership, encrypts saved Torn credentials at rest, and issues random bearer session tokens while storing only SHA-256 hashes in D1. The browser stores the session token locally; raw Torn keys are not stored in browser storage. Dashboard sessions expire after 30 days.

All Torn sign-ins start with standard-user permissions. The primary owner Torn player ID (`351311`) is an explicit allowlist for *requesting* administrator elevation, but the player ID alone never grants administrator access. A successful administrator step-up applies only to the current session for 30 minutes. Every `/api/admin/*` request checks that server-side elevation and its expiry; the frontend is not trusted to authorize administrator work. Elevation can be revoked explicitly and is removed when the session is signed out. Five failed attempts in a 15-minute window trigger a 15-minute lockout for that owner/client-IP attempt key. Raw passwords, usernames, and password hashes are never written to D1 or application logs.

### Configure administrator step-up credentials

**Configure both secrets before deploying this change.** If either secret is missing or invalid, administrator elevation fails closed and administrator APIs remain unavailable by design. Ordinary Torn sign-in continues to use standard-user permissions.

1. Choose a strong, unique administrator password of at least 16 characters. Do not send it in chat or commit it to the repository.
2. From a private interactive terminal in the repository, run:

   ```sh
   node scripts/generate-admin-password-hash.mjs
   ```

   Type the passphrase at the hidden prompt. The helper does not echo the password; it prints a `pbkdf2-sha256$...` hash using PBKDF2-SHA-256, 210,000 iterations, and a random 16-byte salt. Do not commit or publish the hash.
3. Configure the administrator username as a Cloudflare Worker secret: `npx wrangler secret put ADMIN_USERNAME`.
4. Configure the generated hash as a Worker secret: `npx wrangler secret put ADMIN_PASSWORD_HASH`. Paste the hash into Wrangler's prompt. Do not set either value as a public `vars` entry, frontend variable, or GitHub repository secret.
5. Confirm both secrets are present in the correct production Worker environment before merging/deploying the code. The Worker deployment workflow applies pending D1 migrations before deploying the Worker.

After deployment, verify that a normal Torn session is non-admin by default, only the allowlisted owner identity can attempt elevation, correct credentials elevate that session, incorrect credentials are rejected and rate-limited, a standard session receives HTTP 403 from admin APIs, and explicit lock/sign-out or expiry removes elevated access.

CORS restrictions are useful browser hygiene but are not a replacement for authentication. The regular sign-out action revokes the current server-side session. An authenticated all-devices action revokes every active session for that player. Removing saved credentials preserves company history.

## Local development

- Node.js 20+
- `npm ci`
- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm test`

Cloudflare Pages production deployments build the repository's `main` branch with `npm run build` and publish `dist/`.
