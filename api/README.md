# Friendly Mindmap API

Requires Node.js 22+ and PostgreSQL 17+. From this directory:

```powershell
npm ci
npm run build
```

Set `DATABASE_URL` in the current process environment to a PostgreSQL connection
URL for a database you own. For server startup, also configure the private
object-storage inputs below and provision its bucket. Migrations and account
operator commands require only PostgreSQL. Supply credentials through your environment or a
secret manager; do not commit them, put them in command arguments, or paste them
into logs. URL-encode special characters in connection credentials.

```powershell
npm run migrate
npm start
```

Migrations run explicitly, not implicitly at application startup. They hold a
PostgreSQL advisory transaction lock and record source checksums. Re-running is
safe; editing an already applied migration or using an older migration set is
rejected. Add a new migration to change an existing schema. A failed migration
rolls back the migration transaction.

## Configuration

| Environment variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL URL including database and credentials | Required |
| `HOST` | API listening interface | `127.0.0.1` |
| `TRUST_PROXY` | `true` only when every request comes through a trusted reverse proxy that sets `X-Forwarded-For` (the bundled nginx does); per-IP login throttling then counts the real client | `false` |
| `PORT` | Listening port; `0` chooses an available port for tests | `3000` |
| `APP_ORIGIN` | Exact browser origin, without trailing slash/path | `http://127.0.0.1:6610` in development; required in production |
| `NODE_ENV` | `production` enforces HTTPS; `development` enables explicit bootstrap | No bootstrap allowed unless explicitly `development` |
| `S3_ENDPOINT` | Private S3-compatible HTTP(S) endpoint, without embedded credentials | Required for server startup |
| `S3_REGION` | Object storage signing region | `us-east-1` |
| `S3_ACCESS_KEY` | Server-only object storage access credential | Required for server startup |
| `S3_SECRET_KEY` | Server-only object storage secret credential | Required for server startup |
| `S3_BUCKET` | Existing private attachment bucket | Required for server startup |

Database connections have bounded connect/statement timeouts and a pool of up to
10 connections. Production database transport/security is configured by the
PostgreSQL URL and deployment environment; use TLS with a trusted certificate
when the connection leaves the private deployment network.

The origin must match the browser exactly. `localhost` and `127.0.0.1` are
different origins. Non-loopback HTTP is rejected, and production always requires
HTTPS. Configure TLS at the public reverse proxy and keep internal services
private.

## Accounts and authentication

There is no public registration API. Normal API startup and migrations never
create a user or reset a password. For explicit development-only provisioning,
set `DATABASE_URL`, build/migrate first, then run:

```powershell
$env:NODE_ENV = 'development'
$env:ACCOUNT_USERNAME = 'adena'
$env:ACCOUNT_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Initial password' -AsSecureString)).Password
try { npm run bootstrap } finally { Remove-Item Env:\ACCOUNT_PASSWORD }
```

Bootstrap creates an admin only if that normalized username is absent. It never
upgrades an existing basic user or replaces an existing password. Supply a
password of 8-1024 characters; no password is built into the application.
Alternatively set `ACCOUNT_PASSWORD_FILE` to a mounted UTF-8 secret file instead
of `ACCOUNT_PASSWORD` (not both). One trailing newline from that file is removed.
Do not pass passwords on the command line.

To explicitly rotate an existing account's password, set `ACCOUNT_USERNAME` and
one of the password inputs as above, then run `npm run password`. Rotation
revokes all existing sessions. This operator command requires direct database
access and is not exposed as a public HTTP endpoint.

### Browser API

- `POST /api/auth/login` with `{ "username": "...", "password": "..." }`.
  The request must carry the configured `Origin`. The response contains the
  public account, `sessionId`, `csrfToken`, and absolute `expiresAt`; it sets an
  opaque HttpOnly SameSite=Strict cookie. Secure deployments use the
  `__Host-mindmap` cookie; loopback HTTP uses `mindmap-session`.
- `GET /api/auth/session` checks that cookie and returns current account/role and
  session information. It never exposes a password hash or session token.
- `POST /api/auth/logout` requires `Origin` and `X-CSRF-Token` from the session
  response. It revokes the current session and clears its cookie. An optional
  `{ "sessionId": "..." }` revokes only that session owned by the current account;
  this supports deferred offline logout without revoking a newer login.
  The application also sends `"clearCookie": false`: the revoked cookie becomes
  unusable server-side, but a delayed response cannot erase a newer login cookie.
  Deferred targets require a current matching-account session and its fresh
  CSRF token; clients persist only the non-secret target identity, not CSRF or
  authentication tokens.
- Every authenticated mutation requires the configured `Origin` and
  `X-CSRF-Token`; `Sec-Fetch-Site: cross-site` is rejected. Cookies are rotated
  at login; sessions expire after 24 hours idle or 30 days absolute.
- Account-cache clients send the captured `X-Session-Id` on reads and writes.
  When supplied, it must match the cookie's current session, otherwise the API
  returns `SESSION_CHANGED` (401) before accessing private data. This prevents
  a concurrent cookie/account switch from hydrating another account's cache.
  It is an identity binding, not a substitute for cookie authentication or CSRF.
- Passwords use Argon2id (64 MiB, three iterations, one lane). Login is limited
  to 10 attempts per normalized username and 100 per direct peer IP per
  15-minute window, persisted across process restarts. Login failures are
  generic; no account existence is disclosed.

All responses are `no-store`. Never store session cookies/tokens or passwords in
JavaScript-accessible storage. The CSRF token is not an authentication credential;
keep it in memory and refresh it through the session endpoint as needed.
Authentication failures use `AUTH_REQUIRED`/`INVALID_CREDENTIALS` (401);
origin/CSRF failures use `INVALID_ORIGIN`/`INVALID_CSRF` (403); throttling uses
`LOGIN_THROTTLED` (429).

### Account configuration and ownership

`GET /api/account/configuration` returns `{ "configuration": {}, "revision": "0" }`.
`PATCH /api/account/configuration` accepts only an exact revision and validated
appearance/language field changes:

```json
{
  "expectedRevision": "0",
  "changes": { "theme": "pale-rose", "language": "en" }
}
```

Theme values: `system`, `light`, `dark`, `pale-rose`, `win98`, `cs3-gray`.
Language values: `en`, `fr`, `hu`. Revisions are decimal strings to preserve
PostgreSQL bigint precision. Stale writes return `REVISION_CONFLICT` (409);
clients must reload/rebase only their pending preference fields. An unchanged
write does not advance the revision. Role/username/ownership changes are not
accepted through this endpoint.

Authorization always uses the database's current role and account identity,
not client role fields. Admin attachment/history entitlements do not grant
access to another account's board, history or files.

## Board persistence API

Every endpoint requires a current account session. Mutations also require
`Origin` and `X-CSRF-Token`.

### Private attachment transfers

The local S3-compatible service is RustFS, using a private bucket. Its credentials
stay on the server. Downloads use `GET /api/boards/:boardId/attachments/:id`;
only the owner can retrieve files referenced by current content or retained
history. Files are sent as downloads with `application/octet-stream`, `nosniff`,
`no-store`, and `X-Content-SHA256`, never as active app-origin HTML/SVG.

Uploads require an existing owned board (staging for new imports is described
below). Choose a fresh UUID as the upload identity and use:

- `POST /api/boards/:boardId/uploads/:uploadId` with
  `{ "nodeId": "...", "name": "...", "mime": "...", "size": 123 }`.
  Repeating identical initiation resumes that identity; changed input returns
  `UPLOAD_MISMATCH`. The result includes `attachmentId`, `partSize`, `expiresAt`
  and state. No file is published by initiation.
  The upload UUID is also the destination attachment UUID, allowing offline
  references to remain stable through transfer retries.
- `PUT .../uploads/:uploadId/parts/:number`: raw `application/octet-stream`,
  numbered from 1, with exact `Content-Length`. All parts except the final one
  must have the returned part size; an empty file uses one zero-byte part.
  Stream directly from a bounded slice/chunk, not a whole-file buffer.
- `GET .../uploads/:uploadId`: authoritative storage part numbers, sizes and
  ETags. After interruption or a lost response, reuse acknowledged parts and
  retry missing parts. A part retry replaces that numbered part.
- `POST .../uploads/:uploadId/complete`: checks actual provider parts, streams
  the assembled object through SHA-256, verifies actual size, and returns
  attachment metadata. Completion is retryable even if the storage completion
  acknowledgement was lost. Persist this metadata in a normal board save;
  finalization alone does not publish an attachment.
- `DELETE .../uploads/:uploadId`: idempotent cancellation releases its slot.
  Referenced files cannot be cancelled; remove them through board saves.

Every mutation requires Origin/CSRF. Ownership and the current database role are
rechecked. Basic files are at most 5,242,880 bytes, one per node, with a
transactional reservation lasting until publication, cancellation or expiry.
Unfinished uploads expire after 24 hours without a successful part. Admins have
no application size/count quota. S3 has at most 10,000 parts of at most 5 GiB
each; returned part sizes grow for large files. The deployed provider, available
disk and browser cache may impose further physical limits, reported as errors.
API part streams use backpressure and bounded stream buffers; final checksum
verification also streams. Never treat a transfer or locally queued file as a
successful cloud save before the attachment and board acknowledgements.

The real-HTTP streaming integration test transfers 256 MiB in 8 MiB parts to
RustFS, runs the API in a separate process, verifies the final SHA-256 and
samples memory every 10 ms. It requires RSS growth below 128 MiB and external
memory growth below 64 MiB, independently of client buffers. One verified run
measured about 53 MiB RSS / 45 MiB external growth; measurements vary with GC
and platform. Run it with `npm run build`, then
`node --test dist\api\test\streaming.test.js`.

- `GET /api/boards`: account-owned board summaries ordered by modification time.
  Add `?includeDeleted=true` to receive deletion tombstones for offline sync.
  Summary fields are `id`, `name`, `revision`, `updatedAt`, and nullable `deletedAt`.
- `GET /api/boards/:id`: current `id`, `name`, `revision`, `contentRevision`,
  `updatedAt`, `schemaVersion`, `doc` and `camera`. Foreign or missing boards
  both return 404, including when requested by an admin.
- `PUT /api/boards/:id`: create or save a complete snapshot. The document's
  UUID must equal the path UUID. Set `expectedRevision` to `null` for create-only,
  or the exact previously acknowledged revision string to update. Rename is a
  snapshot save with a changed document name. Request shape:

```json
{
  "mutationId": "f094d3e2-0177-4ab9-946f-e3ecbcf6cf8b",
  "expectedRevision": null,
  "schemaVersion": 2,
  "doc": {
    "id": "bf3f8f6e-be54-4be6-b983-ea76ebf36c55",
    "name": "Example",
    "nodes": {},
    "children": { "__root__": [] },
    "links": {},
    "tags": {},
    "settings": {
      "snap": true, "autoAlign": true,
      "direction": "horizontal", "minimap": false
    }
  },
  "camera": { "x": 0, "y": 0, "zoom": 1 }
}
```

The response contains `id`, decimal-string `revision`, decimal-string
`contentRevision`, and ISO `updatedAt`. Camera-only changes advance the server
revision without creating content history; unchanged snapshots advance neither.
Current attachment references must already point to finalized, owner/board-bound
file metadata and obey current role policy; forged/missing metadata is rejected.

- `DELETE /api/boards/:id` with `{ "mutationId": "<uuid>",
  "expectedRevision": "<revision>" }`: delete only the revision explicitly
  confirmed by the client. The response includes `id`, the new `revision` and
  `deletedAt`. Content/history access is removed; the minimal board tombstone
  remains to prevent stale offline recreation.

Generate a new mutation UUID for each logical change and reuse it unchanged
when retrying after a network failure. The server transaction stores a
canonical request fingerprint and original result. Concurrent or later retries
return that same result, without duplicating history. Reusing an identifier for
different content returns `MUTATION_MISMATCH` (409). Receipt/tombstone identities
are not automatically expired while long-offline replay is supported.

`REVISION_CONFLICT` (409) means preserve local work before reloading the remote
version. An existing/tombstoned UUID cannot be recreated with a null revision.
`BOARD_DELETED` (410) on update means recover pending edits under a fresh UUID,
not the old identity. `NEWER_SCHEMA` (422) means preserve the newer document
without overwriting it; `INVALID_BOARD` (400) means correct the invalid input.
Historical content commits and current attachment references are transactional
with board updates and mutation receipts.

### Content history, retention and restore

History is durable server-side content history, separate from session undo/redo.
Each accepted content-changing save or restore creates one immutable snapshot
numbered by `contentRevision`; camera-only, unchanged, failed and replayed saves
do not. All history endpoints are owner-only (foreign, deleted or missing boards
and revisions return 404, even for admins) and responses are `no-store`.
Snapshot rows are enforced immutable by a database trigger (migration `003`):
they can be inserted or pruned by retention, never updated.

- `GET /api/boards/:id/history?limit=20&before=<contentRevision>`: newest first,
  `limit` 1-50 (default 20; larger values are capped, invalid values are 400).
  Response `{ "items": [...], "nextBefore": "<contentRevision>" | null }`; pass
  `nextBefore` as `before` for the next page. Items contain `contentRevision`,
  `serverRevision`, `name`, `schemaVersion`, `actorId`, ISO `createdAt` and
  `current` (true for the board's current content), never the document.
- `GET /api/boards/:id/history/:contentRevision`: the item fields plus the full
  immutable `doc` and `attachments` (`nodeId`, `id`, `name`, `mime`, `size`,
  `checksum`, `available`). Files referenced by retained history remain
  downloadable through the normal attachment endpoint.
- `POST /api/boards/:id/history/:contentRevision/restore` with
  `{ "mutationId": "<uuid>", "expectedRevision": "<board revision>" }` (Origin/CSRF
  required). The board must still be at `expectedRevision`, otherwise
  `REVISION_CONFLICT` (409) and nothing changes; concurrent restores/saves are
  serialized by the board lock so only one wins. A successful restore creates a
  new content revision (new `contentRevision`/`revision`) whose document equals
  the historical snapshot (the current camera is kept), never rewrites the
  source snapshot, and returns the save result plus `restoredContentRevision`.
  Reuse `mutationId` when retrying after a lost response to receive the original
  result. Restoring content identical to the current content is a no-op that
  returns the current revisions. Snapshot attachments must still be ready,
  stored files that satisfy the owner's current role policy; otherwise
  `ATTACHMENT_UNAVAILABLE`/`ATTACHMENT_COUNT`/`ATTACHMENT_SIZE` (422) is returned
  and the board is unchanged. Unknown or pruned revisions return 404.

Retention counts content revisions, using the board owner's current database
role, and is applied in the same transaction as the commit. Basic owners keep the
latest 10 snapshots including the current one (the 11th distinct content commit
removes the oldest); admins keep all history until explicit board deletion.
Restores count as commits. A role change does not prune immediately: an
admin-to-basic change prunes on the next successful content commit or restore.
Pruning removes history attachment references only; bytes are then deleted by
the reference-aware cleanup (below) once no current/history reference or live
transfer remains and the 24-hour grace period has passed.

### Atomic imports and duplicates

For a new board with attachments, choose a fresh board UUID and first
`POST /api/boards/:id/staging` (Origin/CSRF required). Repeating this operation
is safe while staging. This identity is hidden from normal load/list/download
APIs and has no history. Upload all destination-bound files using that UUID,
then `PUT /api/boards/:id` with `expectedRevision: null`, the complete validated
document and finalized destination metadata. Publication, initial history,
references and the mutation receipt commit in one transaction. Validation,
policy, missing stored bytes or forged attachment IDs leave the board hidden.
Existing boards are never changed by a failed new-board import.

Duplication uses a fresh staging identity and uploads/copies the owner's
available source bytes into new destination-bound attachments before the same
atomic publication. Source attachment IDs cannot be injected into another
board's JSON. The browser must retain recoverable imported/duplicated data until
publication is acknowledged. Abandoned staging identities and unreferenced
files are eligible for cleanup after the transfer grace period.

The API runs a non-overlapping cleanup pass at startup and once per minute,
processing up to 25 attachment records and 25 abandoned staging boards per
pass. It retains current/history references and live transfers. Unreferenced
finalized files receive a 24-hour grace period; expired/cancelled transfers and
deleted boards are eligible immediately. Staging boards abandoned for 24 hours
without live transfers become tombstones, not visible empty boards. Deletion
state is persisted before object deletion, so dependency failures are logged
and retried without publishing missing files. Old orphaned S3 multipart uploads
are also reconciled against live database transfers. Use a dedicated private
bucket and credentials permitting multipart listing/abort and object deletion.

## Health and error contract

- `GET /api/health/live`: `200 {"status":"ok"}` while the process is responding.
- `GET /api/health/ready`: `200 {"status":"ready"}` only when the database is
  reachable, all migration versions/checksums match, and configured object
  storage is reachable with an existing bucket.
- Missing/outdated schema or unavailable backing storage: HTTP 503 with
  `DEPENDENCY_UNAVAILABLE`; run migrations or restore service connectivity.

Errors use this shape:

```json
{
  "error": {
    "code": "DEPENDENCY_UNAVAILABLE",
    "message": "A required dependency is unavailable or the database schema is not current.",
    "requestId": "req-1"
  }
}
```

Unexpected errors use `INTERNAL_ERROR` (500), invalid requests use
`INVALID_REQUEST` (4xx), and unknown routes use `NOT_FOUND` (404). Responses are
`no-store` and `nosniff`. Logs identify the event, request ID and safe diagnostic
code, not raw database errors, request bodies, cookies or credentials.

## Verification

```powershell
npm run typecheck
npm test
```

The test runner compiles before execution. Integration tests require Docker and
start uniquely named, isolated PostgreSQL containers on random loopback ports
with generated credentials. They clean up only containers they created. No
developer database or currently running app is modified.

Tests cover repeatable/concurrent migrations, constraint enforcement, rollback,
shared validation without Angular, real HTTP readiness, CLI migrations and
redacted failure paths.
