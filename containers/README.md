# Container deployment

The application and public routing use separate Compose projects:

```text
browser ──> Caddy (internal-routing) ──> nginx (mindmap) ──/api/──> API ──> PostgreSQL
              └─ HTTP on port 80 redirects to HTTPS                          └──> RustFS (S3)
```

* The application Compose project runs nginx, the API, PostgreSQL and RustFS. Only nginx has a
  host port; production binds it to loopback on `127.0.0.1:6610`.
* The separate `internal-routing` Compose project runs Caddy and publishes ports 80 and 443
  (TCP/UDP). Caddy handles HTTP-to-HTTPS redirects on port 80.
* Both projects share the application Compose project's `routing` network; in the production
  project (`containers`) its Docker network is named `containers_routing`. Caddy reaches nginx by
  the service name `mindmap`. The API, PostgreSQL and RustFS have no published host ports.
* The API is reached same-origin at `/api/` through nginx.
* Startup order is enforced by health checks: PostgreSQL and RustFS healthy → one-shot
  `migrate` (schema migrations) and `storage-init` (idempotent bucket creation) succeed →
  `api` healthy (`/api/health/ready`) → `mindmap` (nginx). Caddy runs independently.
* Caddy manages the `mindmap.adena.dev` HTTPS certificate; its state is kept in the routing
  project's named volumes.

## Required inputs

Secrets are never tracked. Copy the template and replace every `<placeholder>` (the file
`containers/.env` is git-ignored):

```powershell
Copy-Item containers\.env.example containers\.env
# edit containers\.env; generate each value, for example:
-join ((1..24) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

| Variable | Required | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | PostgreSQL password (URL-safe characters only; it is embedded in the API's connection URL) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | yes | RustFS root credentials, also used by the API (3+ / 8+ characters) |
| `APP_PORT` | no, `6610` | Direct app port in development; production keeps the app on loopback port 6610 |
| `APP_ORIGIN` | no, `http://127.0.0.1:<APP_PORT>` | Exact browser origin the API accepts (scheme, host and port; no path) |
| `API_NODE_ENV` | no, `development` | `production` requires an HTTPS `APP_ORIGIN`; `development` additionally allows plain HTTP on loopback |
| `MINDMAP_BIND` / `MINDMAP_HOST_PORT` | no | nginx host bind address and port; production uses `127.0.0.1:6610` |
| `S3_BUCKET` | no, `friendly-mindmap` | Private attachment bucket |

If a required secret is missing, Compose stops before creating anything and names the
variable (nothing is printed about its value). Variables can also come from the shell
environment or `--env-file`.

## Start

From the repository root:

```powershell
docker compose -f containers/docker-compose.yaml up -d --build
docker compose -f containers/docker-compose.yaml ps
```

Open `http://127.0.0.1:6610/` (or your `APP_ORIGIN`). The origin must match exactly:
`localhost` and `127.0.0.1` are different origins, so if you prefer `http://localhost:6610/` set
`APP_ORIGIN=http://localhost:6610`. Without an account the application is usable as a guest with
local-only boards; cloud workspaces require a provisioned account (below).

Schema migrations run automatically as the one-shot `migrate` service before the API starts and
are repeatable. To run them alone: `docker compose -f containers/docker-compose.yaml run --rm migrate`.

### Production and TLS

Set `APP_ORIGIN=https://mindmap.adena.dev` and `API_NODE_ENV=production`; the API then uses Secure
cookies and rejects non-loopback HTTP. The application stack binds nginx to `127.0.0.1:6610`.
The separate [routing Compose project](../internal-routing/containers/docker-compose.yaml) shares
the app project's routing network (named `containers_routing` in production) and proxies
`mindmap.adena.dev` to `mindmap:80`. It redirects HTTP on port 80 to HTTPS. Caddy's admin API is
disabled, and the proxy removes upstream `Server` headers and sets a cosmetic custom value.

Point `mindmap.adena.dev` DNS at the public IP. Forward TCP 80 and 443 from the internet-facing
routers to this server; Caddy uses port 443 to obtain and renew its certificate and port 80 for
HTTP redirects. The app's port 6610 is loopback-only and is not forwarded publicly.

Start the application first so it creates the shared Docker network, then start the routing
project:

```bash
docker compose -f containers/docker-compose.yaml up -d --build
docker compose -f internal-routing/containers/docker-compose.yaml up -d
```

An existing service already publishing host ports 80 or 443 must be migrated or stopped before
Caddy can bind those ports. Review its current routes and certificate volumes before replacing it.
Do not forward arbitrary client `Origin` headers; the API requires the exact configured origin.

A local development `docker compose up` without the routing project continues to serve the app
directly on `APP_PORT`.

### Deploying or updating on Debian

Run the checked-in script (or a copy of it) from Bash:

```bash
bash ~/projects/friendly-mindmap/deploy.sh
```

The target is `~/projects/friendly-mindmap`. If it is absent or empty, the script clones `main`.
If `containers/.env` is missing, it copies `.env.example` there and exits; configure the database
and storage secrets before running it again. It adds the production API origin and loopback nginx
binding when absent. Each deployment requires a clean `main` checkout, fast-forwards it from
`origin/main`, rebuilds the application images, and starts the application stack. Start or update
the separate routing project with its Compose file after the application has created the shared
network. Existing conflicting production settings must be corrected in `.env` before the script
proceeds. It does not create backups; take a verified backup before deploying updates. Compose
runs migrations and storage initialization as part of startup.

## Development admin bootstrap (explicit, opt-in)

Normal startup never creates an account. The `tools` profile provides a separate development-only
command that creates one admin if that username does not exist; it never changes an existing
account or password. Supply the password through a mounted file that you create yourself (do not
commit it, do not put it on a command line):

```powershell
New-Item -ItemType Directory containers\secrets -Force | Out-Null
[Net.NetworkCredential]::new('', (Read-Host 'Admin password' -AsSecureString)).Password |
  Set-Content -NoNewline containers\secrets\admin_password      # 8-1024 characters
$env:ACCOUNT_USERNAME = 'your-name'                             # default: adena
docker compose -f containers/docker-compose.yaml run --rm `
  -v "${PWD}\containers\secrets\admin_password:/run/secrets/account_password:ro" bootstrap-admin
Remove-Item Env:ACCOUNT_USERNAME; Remove-Item containers\secrets\admin_password
```

The bootstrap service sets `NODE_ENV=development` itself; the API container keeps whatever
`API_NODE_ENV` says. Log in through the application afterwards.

## Password rotation

Rotation replaces an existing account's password and revokes all of its sessions (there is no
HTTP endpoint for it). Use the same mounted-file approach with `rotate-password`:

```powershell
$env:ACCOUNT_USERNAME = 'your-name'
docker compose -f containers/docker-compose.yaml run --rm `
  -v "${PWD}\containers\secrets\admin_password:/run/secrets/account_password:ro" rotate-password
```

To rotate infrastructure secrets: the S3 and PostgreSQL credentials are fixed into their
volumes when first created. Changing `S3_ACCESS_KEY`/`S3_SECRET_KEY` only needs a restart
(`up -d` recreates RustFS and the API with the new values). Changing `POSTGRES_PASSWORD` also
requires `ALTER USER mindmap PASSWORD '...'` inside the running database
(`docker compose exec postgres psql -U mindmap -d mindmap`) before updating `.env` and restarting.

## Shutdown and volume retention

| Command | Effect |
|---|---|
| `docker compose -f containers/docker-compose.yaml stop` | Stops containers; everything is retained |
| `docker compose -f containers/docker-compose.yaml down` | Removes containers and networks; **volumes are kept** (accounts, sessions, boards, history, files survive the next `up`) |
| `docker compose -f containers/docker-compose.yaml down -v` | **Permanently deletes** `postgres-data` and `rustfs-data` |

Never use `down -v` or `docker volume rm` unless you hold a verified backup. Normal restarts and
`up --build` after an update retain all cloud state.

## Backup and restore

A coherent backup needs the database and the attachment objects to describe the same moment.
`containers\backup.ps1` stops the application and API (no writes, uploads or cleanup), dumps
PostgreSQL in custom format, stops RustFS and archives its data volume, writes `SHA256SUMS`,
then restarts the stack:

```powershell
.\containers\backup.ps1 -OutDir D:\backups\mindmap-2026-01-01
# other projects/env files: -Project <name> -EnvFile <path>
```

The backup directory contains all user data (but no secrets): store and protect it. Keep a copy of
`containers\.env` in a secret store; restore does not need the *same* secrets (the target stack uses
its own), but the RustFS archive requires the same pinned RustFS image, which Compose uses.

Restore into an empty stack (a new machine, or an isolated project beside a running one):

```powershell
# separate env file, port and project so nothing existing is touched
.\containers\restore.ps1 -BackupDir D:\backups\mindmap-2026-01-01 -Project mindmap-restore -EnvFile D:\secrets\restore.env
```

It verifies checksums, builds the API image, restores the dump (`pg_restore --single-transaction`)
and the RustFS volume while storage and API are stopped, then starts everything (repeatable
migrations find the schema current). It refuses to overwrite a non-empty database unless `-Force`
is passed. Afterwards sign in and check a board, its history and an attachment; remove an
isolated verification project with `docker compose -p mindmap-restore ... down -v`.

Manual equivalent (any shell): stop `mindmap` and `api`; `pg_dump -U mindmap -d mindmap -Fc` inside the
`postgres` container; stop `rustfs`; `tar` the `rustfs-data` volume from a throwaway container;
restart. Restore reverses it into freshly created volumes with `pg_restore --clean --if-exists`.

## Transfers and limits

nginx (`containers/nginx.conf`) separates two traffic classes:

* **JSON API** (`/api/`): `client_max_body_size 3m` (the API accepts at most 2 MiB JSON), 60 s
  timeouts, never cached (`Cache-Control: no-store` from the API is passed through).
* **Attachment upload parts** (`PUT /api/boards/:id/uploads/:id/parts/:n`) and **downloads**:
  `proxy_request_buffering off` / `proxy_buffering off` (streamed, no temp files), no nginx size
  cap, one-hour timeouts. nginx applies no basic-user limit: the 5 MiB / one-file-per-block basic
  policy and exact part sizes are enforced by the API per account role. Admins have no
  application quota; S3 allows at most 10,000 parts of at most 5 GiB each, and available disk,
  RustFS and browser limits are reported as explicit errors.

Static files: `index.html`, `ngsw.json` and the service-worker scripts are always revalidated
(`no-cache`); content-hashed bundles are `immutable` for a year; unknown paths fall back to the
Angular shell. nginx returns a JSON 503 `DEPENDENCY_UNAVAILABLE` when the API is down, while the
shell and guest local editing keep working.

## Troubleshooting

* `required variable ... is missing a value`: fill `containers/.env`.
* API unhealthy: `docker compose -f containers/docker-compose.yaml logs api migrate storage-init`.
  Logs contain diagnostic codes, never credentials.
* `INVALID_ORIGIN` on login: the address in the browser differs from `APP_ORIGIN`.
* An older standalone container from the previous single-service compose file (project
  `containers`) is replaced when the new file is started in the same project; it holds no data.
