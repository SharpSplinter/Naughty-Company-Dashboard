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

**Do not merge/deploy the feature until both `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` are configured on the production Worker.** If either is missing or invalid, administrator elevation fails closed and administrator APIs remain unavailable. Ordinary Torn sign-in continues to use standard-user permissions.

**Important deployment behavior:** Cloudflare's `wrangler secret put` command immediately deploys a new version of the currently targeted Worker. It does not deploy the feature branch unless that branch's code has already been deployed. Treat setting these secrets as a production operation and do it during an approved deployment window. See the [Cloudflare Worker secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

Run the following from the repository root in a private interactive terminal:

1. Verify that Wrangler is authenticated to the intended Cloudflare account with `npx wrangler whoami`. The repository's `wrangler.toml` names the Worker `naughty-company-api`; the commands below target that Worker explicitly.
2. Choose a strong, unique administrator passphrase of at least 16 characters. Do not send it in chat or commit it to the repository.
3. Generate the hash by running:

   ```sh
   node scripts/generate-admin-password-hash.mjs
   ```

   At `Administrator password (input hidden):`, type the passphrase and press Enter. The helper does not echo the passphrase. It prints one hash line beginning with `pbkdf2-sha256$210000$` and containing a random salt and derived hash. Keep that line available for the next step; do not commit or publish it.

4. Set the separate administrator username:

   ```sh
   npx wrangler secret put ADMIN_USERNAME --name naughty-company-api
   ```

   At Wrangler's `Enter a secret value:` prompt, type the chosen administrator username and press Enter.

5. Set the generated hash:

   ```sh
   npx wrangler secret put ADMIN_PASSWORD_HASH --name naughty-company-api
   ```

   At Wrangler's `Enter a secret value:` prompt, paste the **entire one-line output** from the hash helper and press Enter. Paste it into Wrangler's prompt, not into the shell command. The hash contains `$` characters, which shells can interpret when the value is entered as a command argument.

6. Confirm that both names are configured:

   ```sh
   npx wrangler secret list --name naughty-company-api
   ```

   This lists secret names/types, not their values. Check that `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` are listed; do not print, screenshot, or share secret values.

### Android-only path (no desktop computer)

You can generate the hash locally on an Android phone. Install Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or the [official Termux GitHub releases](https://github.com/termux/termux-app/releases). Avoid unofficial APK download sites, and do not mix Termux installations from different sources.

Open Termux and run these commands one at a time:

```sh
pkg update
pkg install git nodejs
git clone https://github.com/SharpSplinter/Naughty-Company-Dashboard.git
cd Naughty-Company-Dashboard
git checkout feat/admin-step-up-auth
node scripts/generate-admin-password-hash.mjs
```

At the hidden prompt, type your new passphrase and press Enter. Copy only the generated `pbkdf2-sha256$...` hash line. Never paste the password or hash into ChatGPT, a message, or a screenshot. Keep the hash temporarily on your phone and clear it from the clipboard after you have entered it into Cloudflare.

To configure the secrets without a desktop, open the [Cloudflare dashboard](https://dash.cloudflare.com/) in your Android browser. If needed, use the browser menu's **Desktop site** option. Go to **Workers & Pages** > **naughty-company-api** > **Settings** > **Variables and Secrets**. Choose **Add**, select type **Secret**, and add `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`. Add both before clicking **Deploy** once.

**Do not click Deploy until the production configuration change is approved.** Cloudflare deploys a new version of the currently deployed Worker when you save and deploy secret changes; this does not deploy the PR's feature-branch code. See [Cloudflare's official secret setup guide](https://developers.cloudflare.com/workers/configuration/secrets/).

Do not place either value in `wrangler.toml`, a public `vars` entry, a frontend environment variable, a GitHub Actions output, or source control. Do not send the password or hash in chat. If you are not ready for Wrangler to publish a new version of the currently deployed Worker, do not run `secret put` yet.

After the feature is deployed, verify that a normal Torn session is non-admin by default, only the allowlisted owner identity can attempt elevation, correct credentials elevate that session, incorrect credentials are rejected and rate-limited, a standard session receives HTTP 403 from admin APIs, and explicit revocation, sign-out, or expiry removes elevated access.

CORS restrictions are useful browser hygiene but are not a replacement for authentication. The regular sign-out action revokes the current server-side session. An authenticated all-devices action revokes every active session for that player. Removing saved credentials preserves company history.

## Local development

- Node.js 20+
- `npm ci`
- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm test`

Cloudflare Pages production deployments build the repository's `main` branch with `npm run build` and publish `dist/`.
