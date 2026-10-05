# ATLAS PROOF — Wave 1 deployment runbook

The smallest production-faithful environment for 10–20 private-beta users:
**one Linux server** running Caddy, the Next.js web app, **one** research
worker and PostgreSQL 16. No Docker, no Kubernetes, no extra services.

This runbook changes no product semantics. Every step that writes to a
database, creates a bot, provisions a server or calls a provider needs
**separate Founder approval** at the time it is done.

Files in this directory:

| File | Installed as |
|---|---|
| `atlas.env.example` | `/etc/atlas/atlas.env` (root:atlas 0640) — shared env |
| `worker.env.example` | `/etc/atlas/worker.env` (root:atlas 0640) — worker-only env |
| `atlas-web.service` | `/etc/systemd/system/atlas-web.service` |
| `atlas-worker.service` | `/etc/systemd/system/atlas-worker.service` |
| `atlas-backup.service` + `.timer` | `/etc/systemd/system/` |
| `Caddyfile` | `/etc/caddy/Caddyfile` |
| `preflight-env.sh` | used in place (ExecStartPre) — refuses a wrong environment |
| `with-env.sh` | used in place — runs migrations / owner CLIs with the env loaded |
| `atlas-backup.sh` | used in place by the backup timer |

---

## 1. Topology

```
Telegram client (phone) ──https──▶ Caddy :443 ──▶ next start 127.0.0.1:3000 ─┐
                                                                             ├─▶ PostgreSQL 16 (127.0.0.1:5432)
                          atlas-worker (SEARCH_EXTRACT,FETCH) ───────────────┘     data + pg-boss + LISTEN/NOTIFY
                               │ direct egress (no proxy)
                               ├─▶ api.anthropic.com      (also from the web: Interpreter)
                               ├─▶ api.search.brave.com
                               ├─▶ public https pages (SSRF-validated, IP-pinned) + headless Chromium
                               └─▶ Solana / Ethereum RPC
```

Why it is exactly this:

- **Long-running processes are required.** The research event stream holds a
  connection open, `src/server/events/job-events.ts` keeps a permanent
  `LISTEN` connection, and the web process runs pg-boss itself. Serverless
  hosting does not fit.
- **One worker is enough.** The local two-worker split (D-149) exists only
  because the laptop's network cannot reach Anthropic and documentation
  hosts in the same state. A server with clean, direct egress reaches both,
  and the code accepts `ATLAS_WORKER_CAPABILITIES=SEARCH_EXTRACT,FETCH` in one
  process (the FETCH role only refuses a proxy). This combined mode is
  supported by code and tests but **has not yet been run live**.
- **No public database.** Postgres listens on loopback only; owner commands run
  on the server over SSH.

## 2. Server requirements

- Ubuntu Server **24.04 LTS** (ships PostgreSQL 16 in its own archive).
- ~**2 vCPU / 4 GB RAM / 40 GB disk** (Next + worker + headless Chromium).
- A region where **Anthropic's API is served**. The laptop needs a proxy only
  because of its own region; the server must not.
- Public IPv4 (IPv6 optional). Inbound: 22 (SSH, key-only), 80 and 443
  (Caddy, TLS issuance). Nothing else.
- A domain with an A (and optionally AAAA) record pointing at the server
  **before** Caddy starts.
- Node.js **24.x** — the version the repository is developed and tested on
  (local: v24.20.0). The repo pins no `engines`.

## 3. Build/runtime facts (verified offline at the commit this file landed in)

| Step | Command | Notes |
|---|---|---|
| Install | `npm ci --include=dev` | **Never** `--omit=dev`, and never a bare `npm ci` with `NODE_ENV=production` in the shell (npm then omits devDependencies). `tsx` and `drizzle-kit` are devDependencies and the worker, the migrator and every owner CLI run through `tsx`. |
| Build | `npx next build` | Needs outbound HTTPS to **Google Fonts** at build time (`next/font/google`, Geist + Geist Mono). Offline it fails with `Failed to fetch 'Geist' from Google Fonts`; everything else compiled and type-checked offline. No secret is needed at build time (no `NEXT_PUBLIC_*` variables exist) — *a build with no env file present was not verified*. |
| Web start | `node_modules/.bin/next start -H 127.0.0.1 -p 3000` | in `atlas-web.service` |
| Worker start | `node --import tsx src/server/jobs/worker.ts` | in `atlas-worker.service`; one node process, so SIGTERM reaches the worker's graceful shutdown. |
| Migrations | `with-env.sh npm run db:migrate` | `scripts/migrate.ts` reads only `DATABASE_URL` from the process environment, hence `with-env.sh`. |
| Private-beta owner CLI | `with-env.sh npm run admin:private-beta -- status \| config … \| grant … \| revoke …` | dry run unless `--apply`. |
| Renderer probe | `with-env.sh --worker npm run probe:renderer -- <url> <slug>` | uses the same installer as the worker; see §9 check 16. |

## 4. First-time server setup

Run as a sudo-capable admin over SSH. *Package commands follow each vendor's
published instructions; re-check them against the vendor pages on the day.*

```sh
# 4.1 base
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl ca-certificates gnupg ufw postgresql
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable

# 4.2 Node.js 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt -y install nodejs
node -v   # expect v24.x

# 4.3 Caddy (official apt repository — see caddyserver.com/docs/install)
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy

# 4.4 service user and directories
sudo useradd --system --create-home --home-dir /opt/atlas --shell /usr/sbin/nologin atlas
sudo install -d -o root -g atlas -m 0750 /etc/atlas
sudo install -d -o postgres -g postgres -m 0700 /var/backups/atlas
sudo install -d -o atlas -g atlas -m 0755 /opt/atlas/ms-playwright
```

### 4.5 Get the code onto the server

The deployed commit must be reachable from the server. Local `HEAD` is ahead
of `origin`, so pick one (each needs Founder approval):

- **A. push + deploy key**: push the branch, add a read-only GitHub deploy key
  for the `atlas` user, then
  `sudo -u atlas git clone <repo> /opt/atlas/app && sudo -u atlas git -C /opt/atlas/app checkout <commit>`.
- **B. bundle (no push)**: on the laptop
  `git bundle create atlas-<commit>.bundle <branch>`, copy it with `scp`, then
  `sudo -u atlas git clone atlas-<commit>.bundle /opt/atlas/app && sudo -u atlas git -C /opt/atlas/app checkout <commit>`.

Never copy `.env.local` to the server.

### 4.6 Install, Chromium, build

```sh
cd /opt/atlas/app
sudo -u atlas npm ci --include=dev
# Chromium for rendered fetch. --with-deps installs OS libraries via apt, so
# it needs sudo; the browser itself lands in PLAYWRIGHT_BROWSERS_PATH.
sudo PLAYWRIGHT_BROWSERS_PATH=/opt/atlas/ms-playwright npx playwright install --with-deps chromium
sudo chown -R atlas:atlas /opt/atlas/ms-playwright
sudo -u atlas npx next build
```

`npx playwright install` run from the repo installs the browser build that
matches the locked `playwright` package (1.62.1 at the time of writing).

### 4.7 Environment files

```sh
sudo install -o root -g atlas -m 0640 deploy/wave1/atlas.env.example  /etc/atlas/atlas.env
sudo install -o root -g atlas -m 0640 deploy/wave1/worker.env.example /etc/atlas/worker.env
sudoedit /etc/atlas/atlas.env    # fill every '' value; see §5
```

### 4.8 Database: see §6 (restore the atlas_dev copy), then migrate.

### 4.9 Services

```sh
sudo cp deploy/wave1/atlas-web.service deploy/wave1/atlas-worker.service \
        deploy/wave1/atlas-backup.service deploy/wave1/atlas-backup.timer /etc/systemd/system/
sudo cp deploy/wave1/Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile    # replace atlas.example.com with the real domain
sudo systemctl daemon-reload
sudo systemctl enable --now atlas-web atlas-worker atlas-backup.timer
sudo systemctl reload caddy
```

Both services refuse to start if `preflight-env.sh` rejects the environment;
`journalctl -u atlas-web -n 50` names the offending variable (never its value).

## 5. Environment checklist

| Variable | Process | Value |
|---|---|---|
| `NODE_ENV` | all | `production` |
| `DATABASE_URL` | all | `postgres://atlas:<pw>@127.0.0.1:5432/atlas_beta` |
| `BOT_TOKEN` | web | from @BotFather (§8) |
| `TELEGRAM_WEBHOOK_SECRET` | web | optional; random, e.g. `openssl rand -hex 32` — only if the forward-to-bot webhook is registered (§8) |
| `CSRF_SECRET` | web | **new** random value, e.g. `openssl rand -hex 32` |
| `ALLOWED_ORIGINS` | web | `https://<domain>` exactly |
| `ANTHROPIC_API_KEY` | web + worker | secret |
| `BRAVE_SEARCH_API_KEY` | worker | secret |
| `SOLANA_MAINNET_RPC_URL` | worker | https, treat as a credential |
| `ETHEREUM_MAINNET_RPC_URL` | worker | https, treat as a credential |
| `ONCHAIN_RESEARCH_ENABLED` | worker | `1` (exactly) |
| `RENDERED_DOCS_ENABLED` | worker | `1` |
| `ATLAS_WORKER_CAPABILITIES` | worker | `SEARCH_EXTRACT,FETCH` |
| `PLAYWRIGHT_BROWSERS_PATH` | worker | `/opt/atlas/ms-playwright` |

Leave unset: `MODEL_GATEWAY` (default `anthropic`), `SEARCH_GATEWAY_PROVIDER`
(default `brave`), `AUTH_MAX_AGE_SEC` (600), `AUTH_CLOCK_SKEW_SEC` (60).

**Production must NOT have** — the preflight refuses to start if any is set:
`AUTH_DEV_BYPASS`, `ATLAS_DEV_PROVIDER_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY` (and their lower-case forms), `NODE_USE_ENV_PROXY`.

Product configuration (`product_config`) arrives with the database copy and
is not an environment variable: `private_beta_enabled=true`,
`private_beta_project_slugs=["raydium","pump_fun","lido"]`,
`private_beta_research_limit=5`, `research_enabled=false`. **D-170:** the
copied rows are NOT changed by the new code defaults — the database keeps
`private_beta_research_limit=5` and has no `private_beta_global_research_limit`
row, which reads as **0 (closed: no new beta Research, no beta Interpreter
call)** until the owner sets the creator-beta values (§13).

## 6. Database: atlas_dev → hosted beta database

The hosted database is a **copy** of `atlas_dev` because `atlas_dev` holds
owner-confirmed records that migrations and the seed do not recreate: one
`PROJECT_IDENTITY` per beta project, the ACTIVE `SOURCE_ROUTE` /
`SOURCE_RESOURCE` rows, Pattern v5 ACTIVE, and the private-beta config.
After the copy, the hosted database is the beta's source of truth and
`atlas_dev` stays a development database.

Extensions in use: `pg_trgm`, `plpgsql` (both ship with Ubuntu's
`postgresql-16`). Schemas: `public`, `drizzle`, `pgboss`.

### 6.1 Dump (laptop; read-only on atlas_dev)

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker exec atlas-postgres pg_dump -U atlas -d atlas_dev --format=custom --no-owner --no-acl -f /tmp/atlas_dev-$STAMP.dump
docker cp atlas-postgres:/tmp/atlas_dev-$STAMP.dump .
docker exec atlas-postgres rm /tmp/atlas_dev-$STAMP.dump
pg_restore --list atlas_dev-$STAMP.dump > /dev/null && sha256sum atlas_dev-$STAMP.dump
```

(`pg_restore` can also be run inside the container if the laptop has no
client: `docker exec atlas-postgres pg_restore --list /tmp/…` before the rm.)

### 6.2 Copy securely

```sh
scp atlas_dev-$STAMP.dump <admin>@<server>:/tmp/
ssh <admin>@<server> "sha256sum /tmp/atlas_dev-$STAMP.dump"   # must match
```

The dump contains user rows and sessions: keep it off shared storage and
delete the copies once the restore is verified.

### 6.3 Restore (server)

```sh
sudo -u postgres createuser --pwprompt atlas          # NOT a superuser
sudo -u postgres createdb --owner=atlas atlas_beta
sudo -u postgres pg_restore --no-owner --role=atlas --exit-on-error \
     --dbname=atlas_beta /tmp/atlas_dev-$STAMP.dump
sudo rm /tmp/atlas_dev-$STAMP.dump
```

### 6.4 Run the normal migrator

```sh
sudo -u atlas /opt/atlas/app/deploy/wave1/with-env.sh npm run db:migrate
```

Expected: `migrations applied` with nothing new — the copy already holds
every migration up to the deployed commit. The ledger's historical row 45
(created_at `1788202800000`, a side-branch migration) comes along; it is
harmless and must not be repaired.

### 6.5 Verify (read-only)

```sh
sudo -u postgres psql -d atlas_beta -At <<'SQL'
BEGIN READ ONLY;
SELECT 'ledger_rows', count(*) FROM drizzle.__drizzle_migrations;
SELECT 'ledger_max',  max(created_at) FROM drizzle.__drizzle_migrations;
SELECT 'origin_enum', enum_range(NULL::research_job_origin)::text;
SELECT 'pattern', version, status FROM research_patterns WHERE status='ACTIVE';
SELECT 'config', key, value::text FROM product_config
  WHERE key IN ('private_beta_enabled','private_beta_project_slugs','private_beta_research_limit','private_beta_global_research_limit','research_enabled','internal_alpha_enabled')
  ORDER BY key;
SELECT 'prepared', p.slug, m.kind, count(*) FROM project_memory_items m JOIN projects p ON p.id=m.project_id
  WHERE p.slug IN ('raydium','pump_fun','lido') AND m.lifecycle_state='ACTIVE' GROUP BY 2,3 ORDER BY 2,3;
COMMIT;
SQL
```

Expected (values as of `2392acd`): 65 ledger rows, max `1790380800000`;
`{PRODUCT,OWNER_MANUAL_ALPHA,OWNER_OBSERVATION,PRIVATE_BETA}`; Pattern 5
ACTIVE; `private_beta_enabled=true`, slugs `["raydium","pump_fun","lido"]`,
limit `5`, `research_enabled=false`; per project one ACTIVE `PROJECT_IDENTITY`
and ACTIVE `SOURCE_ROUTE` rows (raydium 4, pump_fun 3, lido 3) plus
`SOURCE_RESOURCE` (raydium 2, pump_fun 1). A later commit with new
migrations raises the ledger count accordingly.

Then the owner tool's own view:
`sudo -u atlas deploy/wave1/with-env.sh npm run admin:private-beta -- status`.

## 7. Post-restore leftovers (nothing is deleted by this runbook)

| Leftover (counts at `2392acd`) | Effect in production | Cleanup |
|---|---|---|
| `TELEGRAM_DEV` identity `dev_user_1` on the ADMIN user | Unreachable: the dev bypass requires `NODE_ENV=development` **and** `AUTH_DEV_BYPASS=1`; the preflight forbids both. | OPTIONAL — keep: owner-alpha history references that user. |
| 35 USER rows with no sign-in identity | Nobody can sign in as them; never used as beta users. | OPTIONAL |
| 27 stale `QUEUED` research jobs | Each belongs to a different identityless USER; the "one active job" check is per user, pg-boss holds no message for them and the restart sweep only touches `RUNNING`. Inert. | OPTIONAL (owner decision; affects only counts in owner tooling) |
| 1 session (the ADMIN dev session) | Its cookie lives on the laptop's `localhost`, is never sent to the hosted domain, expires within 7 days and is removed by maintenance. | OPTIONAL |
| 6 completed pg-boss rows | Historical; pg-boss maintenance archives them. | OPTIONAL |
| 2 smoke projects `rc1_*_smoke_*` with status `ACTIVE_CORE` | **User-visible**: `/api/projects` lists every `ACTIVE_CORE` project. | **REQUIRED before inviting users** — already on the Founder's BEFORE-BETA list; a status change through the approved tooling, never ad-hoc SQL. |

## 8. Telegram setup (Founder, manual)

1. In Telegram open **@BotFather** → `/newbot` → choose a display name and a
   username ending in `bot`. Use a bot dedicated to ATLAS (no bot exists in
   the repo; the only identity ever used is the dev-only `TELEGRAM_DEV`).
2. BotFather returns the **token**: put it in `/etc/atlas/atlas.env` as
   `BOT_TOKEN`, restart `atlas-web`. Never paste it into chat, git or logs.
3. **Mini App URL**: BotFather → `/mybots` → the bot → *Bot Settings* →
   *Configure Mini App* → enable, URL `https://<domain>/` (or `/newapp`).
4. *Optional* menu button: *Bot Settings* → *Menu Button* → same URL.
   (`/setdomain` is for the Login Widget and is not needed.)
4a. *Optional* **forward-to-bot intake** (`POST /api/telegram/webhook`). A
   user forwards a message to the bot; the bot stores a bounded intake and
   replies with one button that opens `https://<domain>/ask?intake=<id>`
   (a `web_app` inline button; the id is opaque and useless without the
   owner's session). Research still starts only from the Ask screen through
   the normal path. To enable: set `TELEGRAM_WEBHOOK_SECRET` in
   `/etc/atlas/atlas.env`, restart `atlas-web`, then register the webhook
   ONCE from the Founder's machine:
   `curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -d "url=https://<domain>/api/telegram/webhook" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" -d "allowed_updates=[\"message\"]"`.
   Nothing registers it automatically, and nothing in the repository has
   made this call. **Verify against the current Bot API documentation
   before registering** (not verifiable offline from the repository):
   the `secret_token` parameter and the `X-Telegram-Bot-Api-Secret-Token`
   header; the `forward_origin` field with `type` channel / user /
   hidden_user / chat on forwarded messages; that a `web_app` inline button
   may carry a URL with a query string; and that a `start_param` in a
   direct-link launch (`https://t.me/<bot>/<app>?startapp=<intake id>`)
   arrives inside the signed `initData` — the app accepts both launch
   forms. To disable: `setWebhook` with an empty `url`, or unset the secret
   (the route then answers 503 and Telegram stops retrying after its own
   limit).
5. From the **second, non-Founder** Telegram account, open the bot and launch
   the Mini App once. Use the **mobile or desktop Telegram app**: Telegram Web
   embeds the Mini App in a third-party iframe where browsers may block the
   `SameSite=None` session cookie (*not verified*).
6. Verify (read-only):
   ```sh
   sudo -u postgres psql -d atlas_beta -At -c "SELECT ui.provider_user_id, u.role, u.created_at FROM user_identities ui JOIN users u ON u.id=ui.user_id WHERE ui.provider='TELEGRAM';"
   ```
   Exactly one row, role `USER`.

## 9. Deployment verification — before any live Research

Each provider check below is a **live call** and runs only with Founder
approval, once, bounded, zero retries. None creates a Research job.

| # | Check | How | Pass |
|---|---|---|---|
| 1 | HTTPS | `curl -sSI https://<domain>/` | `HTTP/2 200`, valid cert |
| 2 | HTTP→HTTPS | `curl -sSI http://<domain>/` | redirect to https |
| 3 | Origin guard | `curl -s -X POST https://<domain>/api/auth/telegram -H 'Origin: https://evil.example' -d '{}'` | `403 FORBIDDEN_ORIGIN` |
| 4 | Real initData only | same with `-H 'Origin: https://<domain>' -H 'content-type: application/json' -d '{"dev":true}'` | `401 INITDATA_MALFORMED` (no dev bypass in production) |
| 5 | Telegram sign-in | §8 step 5–6 | one `TELEGRAM` identity, role USER |
| 6 | Secure cookie | browser devtools on the Mini App, or the response of step 5 | `atlas_session`: `HttpOnly; Secure; SameSite=None` |
| 7 | DB connection | `systemctl status atlas-web atlas-worker` | both `active (running)` |
| 8 | pg-boss + worker | `journalctl -u atlas-worker -b \| grep '\[worker\]'` | `started, queues: research, research-fetch, research-extract`, `capabilities: SEARCH_EXTRACT,FETCH`, renderer `INSTALLED`, on-chain `INSTALLED` |
| 9 | No proxy vars | `journalctl -u atlas-web -u atlas-worker -b \| grep atlas-preflight` | `ok` for both |
| 10 | DNS is clean | `getent ahosts docs.raydium.io api.anthropic.com api.search.brave.com` | public addresses only |
| 11 | Anthropic | `with-env.sh sh -c 'curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"'` | `200` |
| 12 | Brave | `… curl -s -o /dev/null -w "%{http_code}\n" "https://api.search.brave.com/res/v1/web/search?q=lido&count=1" -H "X-Subscription-Token: $BRAVE_SEARCH_API_KEY"` | `200` (one search request) |
| 13 | Solana RPC | `… curl -s "$SOLANA_MAINNET_RPC_URL" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'` | a `result` number |
| 14 | Ethereum RPC | `… curl -s "$ETHEREUM_MAINNET_RPC_URL" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` | a `result` hex |
| 15 | Page fetch | `curl -sSI https://docs.raydium.io/` from the server, no proxy | `200`/`3xx` |
| 16 | Rendered fetch | `sudo -u atlas deploy/wave1/with-env.sh --worker npm run probe:renderer -- <confirmed route url> <slug>` | probe reports success (one navigation, writes nothing) |
| 17 | Beta config | `with-env.sh npm run admin:private-beta -- status` | enabled, 3 slugs all `ACTIVE_CORE, live-spend allowlisted`, limit 3 per user, global limit 60 (after §13 step 2) |
| 18 | PRODUCT closed | `status` output | `research_enabled (public path): false` |

Never print a variable's value while checking; pipe RPC responses through
nothing that echoes the URL.

## 10. One-user sequence

1. Deploy (§4), restore and verify the database (§6), clear the REQUIRED
   leftover (§7), pass checks 1–4 and 7–10 (§9).
2. Create and configure the bot (§8 steps 1–4).
3. The second Telegram account opens the Mini App once (§8 step 5).
4. Verify one `TELEGRAM` identity with role `USER` and no subscription (§8 step 6).
5. Dry run: `with-env.sh npm run admin:private-beta -- grant --telegram-id=<id> --until=YYYY-MM-DD`.
6. Founder approval → the same command with `--apply`.
7. Offline admission check (owner, read-only): `admin:private-beta -- status`
   shows the grant VALID with 0 research used; raydium / pump_fun / lido
   eligible, aave not.
8. **STOP.** Provider checks 11–16 (§9), then the first live beta Research —
   each separately approved.

## 11. Update / restart / rollback

```sh
cd /opt/atlas/app
sudo -u atlas git fetch && sudo -u atlas git checkout <new-commit>   # or a new bundle
sudo -u atlas npm ci --include=dev
sudo -u atlas npx next build
sudo -u atlas deploy/wave1/with-env.sh npm run db:migrate            # take a backup first if the commit adds a migration
sudo systemctl restart atlas-worker atlas-web
```

- Restart one process: `sudo systemctl restart atlas-web` / `atlas-worker`.
- A worker restart is safe: a Research job is a database row. On start the
  worker sweeps stale `RUNNING` jobs and reconciles exhausted phase
  deliveries, and repeats both every 10 minutes.
- Rollback = check out the previous commit, `npm ci --include=dev`, build,
  restart. A migration is never rolled back by hand; restore the pre-update
  backup instead (§12).
- Emergency stop of all beta Research starts:
  `with-env.sh npm run admin:private-beta -- config --enabled=false --apply`
  (approved jobs already admitted are not destroyed).

## 12. Backup and recovery (Wave 1)

- **Nightly**: `atlas-backup.timer` runs `atlas-backup.sh` at 03:30 UTC as the
  `postgres` user → `/var/backups/atlas/atlas_beta-<UTC stamp>.dump` + `.sha256`,
  14 days kept. Run once by hand: `sudo systemctl start atlas-backup`.
- **Off-server copy**: configure `rclone` for the `postgres` user with an
  object-storage remote and set `ATLAS_BACKUP_RCLONE_REMOTE` in
  `atlas-backup.service` — or pull the newest dump to another machine with
  `scp` on a schedule. A backup that exists only on the server is not a backup.
- **Restore** (to a fresh database, then switch):
  ```sh
  sudo systemctl stop atlas-web atlas-worker
  sudo -u postgres createdb --owner=atlas atlas_beta_restore
  sudo -u postgres pg_restore --no-owner --role=atlas --exit-on-error --dbname=atlas_beta_restore /var/backups/atlas/<file>.dump
  # verify with §6.5 against atlas_beta_restore, then point DATABASE_URL at it
  sudo systemctl start atlas-worker atlas-web
  ```
- **Auto-restart**: both services `Restart=always`; enabled at boot.
- **Logs**: `journalctl -u atlas-web`, `journalctl -u atlas-worker`,
  `journalctl -u atlas-backup`, `journalctl -u caddy`; HTTP access log
  `/var/log/caddy/atlas-access.log`; Postgres `/var/log/postgresql/`.
  Ubuntu keeps the journal on disk (`/var/log/journal`).

## 13. Creator beta (D-170) — invite, limits, emergency stop

Nothing here is automatic; every write is the owner tool, dry run unless
`--apply`. Live creator-link behaviour inside Telegram (the `startapp`
parameter reaching signed initData) is **not verified offline** and needs
the HTTPS deployment smoke test.

1. **Migration 0065** (`research_beta_feedback`, additive) is applied by the
   normal `npm run db:migrate` of §6.
2. **Limits:** `with-env.sh npm run admin:private-beta -- config --limit=3 --global-limit=60 --creator-user-limit=20 --apply`.
   Personal: 3 Research per user by the D-169 count. Global: 60 admitted
   `PRIVATE_BETA` jobs in total, every admitted job counting permanently
   (failed and cancelled included). Raising the global limit later is the
   same command with a new number.
3. **Invite:** `admin:private-beta -- invite --until=YYYY-MM-DD --max-redemptions=20 --apply`
   prints the start parameter `beta_<token>` ONCE (only its SHA-256 is
   stored). The creator link is
   `https://t.me/<bot_username>/<mini_app_short_name>?startapp=beta_<token>`.
   A user who opens it signs in normally and receives the ordinary beta
   grant until that date. Wave 1 admits at most 20 distinct users through
   creator invites IN TOTAL, across every token ever issued
   (`--creator-user-limit`; 20 × 3 = the 60 global); a revoked or expired
   creator user still counts, a manual owner grant never does. The 21st new
   user is told "Private beta access is currently full."; `status` shows
   the creator-wide count and each invite's own count. A forwarded link
   works too; the global Research limit stays the authoritative spend
   boundary. Rotating the invite does NOT reset the 20. **Rotate:** run `invite` again (the old one stops
   within the 60-second config cache). **Disable:** `invite --disable --apply`.
   A revoked user cannot re-grant themselves through the link.
4. **Emergency stop:** `admin:private-beta -- stop --apply` sets
   `private_beta_enabled=false` (it refuses if `research_enabled` is on).
   Within the 60-second config cache: no normal user can start a Research
   and no normal user can cause an Interpreter call (`RESEARCH_DISABLED`);
   the owner keeps the Interpreter. Nothing is deleted — the Research
   Library and every Proof stay readable, and forwarding to the bot still
   only stores an intake. Already-admitted Research is not killed: a phased
   job is refused at its next phase boundary and ends FAILED (the phase in
   progress completes); a non-phased job already executing finishes. To
   resume: `config --enabled=true --apply`. Alternative soft stop that keeps
   the beta switch on: `config --global-limit=0 --apply` (same refusals,
   worded "at capacity").
