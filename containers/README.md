# Container deployment

One `docker compose` project runs the whole application. TLS is terminated by an external
reverse proxy (Caddy) that forwards to the published port:

```text
browser ──HTTPS──> Caddy ──HTTP :6610──> nginx (mindmap) ──/api/──> API ──> PostgreSQL
                                                                      └────> RustFS (S3)
```

* **nginx** serves the Angular build and proxies `/api/` to the API (the API does not serve
  static files). It is the only service with a host port (`APP_PORT`, default `6610`); the API,
  PostgreSQL and RustFS live on internal Docker networks with no host ports and no outbound access.
* Startup order is enforced by health checks: PostgreSQL and RustFS healthy → one-shot
  `migrate` (schema migrations) and `storage-init` (idempotent bucket creation) succeed →
  `api` healthy (`/api/health/ready`) → `mindmap` (nginx).

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
| `APP_PORT` | no, `6610` | Published host port of the application (plain HTTP) |
| `APP_ORIGIN` | no, `http://127.0.0.1:<APP_PORT>` | Exact browser origin the API accepts (scheme, host and port; no path) |
| `API_NODE_ENV` | no, `development` | `production` requires an HTTPS `APP_ORIGIN`; `development` additionally allows plain HTTP on loopback |
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
cookies and rejects non-loopback HTTP. Run a TLS-terminating reverse proxy in front of the
published port. With Caddy running on the same host (or LAN), this is the whole site block:

```caddy
mindmap.adena.dev {
    reverse_proxy <server LAN IP>:6610
}
```

Caddy forwards the client address and `X-Forwarded-Proto`; nginx passes both to the API (which
trusts them) and the API requires the exact `APP_ORIGIN`. Point DNS at the public IP and forward
TCP 80 and 443 to the proxy host (443 for traffic and certificates, 80 for the HTTP redirect).
**Never forward `APP_PORT` publicly**: it is plain HTTP and must stay on the LAN.

A local `docker compose up` without a proxy serves the app directly on `APP_PORT`.

### Deploying or updating on Debian

Run the checked-in script (or a copy of it) from Bash:

```bash
bash ~/projects/friendly-mindmap/deploy.sh
```

The target is `~/projects/friendly-mindmap`. If it is absent or empty, the script clones `main`.
If `containers/.env` is missing, it copies `.env.example` there and exits; configure the database
and storage secrets before running it again. It adds the production `APP_ORIGIN`, `API_NODE_ENV`
and `APP_PORT` when absent and fails if they conflict. Each deployment requires a clean `main`
checkout, fast-forwards it from `origin/main`, rebuilds the images and starts the stack. It does
not create backups; take one before deploying updates. Compose runs migrations and storage
initialization as part of startup.

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

A coherent backup needs the database and the attachment objects to describe the same moment, so
stop the writers first. Run from the repository root on the Debian host (Compose project
`containers`, hence the `containers_*` volume names):

```bash
dc="docker compose -f containers/docker-compose.yaml"
out=~/backups/mindmap-$(date +%F); mkdir -p "$out"

$dc stop mindmap api                       # no writes, uploads or cleanup
$dc exec -T postgres pg_dump -U mindmap -d mindmap -Fc > "$out/postgres.dump"
$dc stop rustfs
docker run --rm -v containers_rustfs-data:/data:ro -v "$out":/backup alpine \
  tar czf /backup/rustfs-data.tgz -C /data .
$dc start rustfs api mindmap
```

The backup contains all user data (but no secrets): store and protect it, and keep a copy of
`containers/.env` in a secret store. The RustFS archive requires the same pinned RustFS image,
which Compose uses.

Restore into a fresh stack (new host, or after `down -v` on a test system):

```bash
dc="docker compose -f containers/docker-compose.yaml"
out=~/backups/mindmap-2026-01-01           # the backup directory

$dc create postgres rustfs                 # creates empty volumes
$dc up -d --wait postgres
$dc exec -T postgres pg_restore -U mindmap -d mindmap --clean --if-exists --no-owner \
  --single-transaction --exit-on-error < "$out/postgres.dump"
docker run --rm -v containers_rustfs-data:/data -v "$out":/backup alpine \
  tar xzf /backup/rustfs-data.tgz -C /data
$dc up -d --build                          # repeatable migrations find the schema current
```

Afterwards sign in and check a board, its history and an attachment.

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
