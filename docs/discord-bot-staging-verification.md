# Discord Bot Staging Verification

Run only against `naughty-company-bot-staging` and test guild `1525623497999515770`.

- [ ] GET health endpoint returns healthy without exposing environment values.
- [ ] Discord PING returns PONG.
- [ ] Bad Ed25519 signature and stale timestamp are rejected.
- [ ] `/ping` responds ephemerally.
- [ ] `/link` opens a modal; no credential is sent in a public message.
- [ ] Invalid key failure contains no submitted key or raw provider response.
- [ ] Valid limited key creates an encrypted per-Discord-user link.
- [ ] Session token is not present in D1 plaintext columns, logs, or Discord output.
- [ ] `/status` works for linked user and reports unlinked state for another user.
- [ ] `/company`, `/employees`, `/trends`, `/rankings`, and `/alerts` enforce member-scoped authorization.
- [ ] Company IDs belonging to another user cannot be fetched by changing command options.
- [ ] Expired dashboard session returns a relink prompt; no retry loop.
- [ ] `/unlink` removes access immediately.
- [ ] Repeated alert event does not produce duplicate delivery.
- [ ] Discord 429 responses trigger bounded backoff.
- [ ] Typecheck/build and unit tests pass before staging deployment.
- [ ] No production Worker, Pages project, or production Discord guild was changed.
