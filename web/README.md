# BetterMindmap

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.28.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Using the editor

### Guest and cloud workspaces

Login is optional and there is no registration. Without logging in you work in
the **guest workspace**: boards stay in this browser (IndexedDB) and are never
uploaded. Save and Load surfaces for guests show: *For saving data to cloud,
please log in*. Logging in opens a separate **cloud workspace** that lists only
your own boards; guest boards are neither uploaded, merged nor deleted, and
logging out brings the guest workspace back unchanged.

New guest/basic attachments are limited to 5 MiB per file and one per block;
admin accounts have no application size or count limit (large files are sent in
resumable parts). Existing over-limit local files stay readable and exportable.

### Save, Export and Import

| Action | Shortcut | What it does |
|---|---|---|
| **Save** | Ctrl/Cmd+S | Commits the text you are typing and the board to this device immediately. Logged in, it then waits for the cloud to acknowledge that revision. It never downloads a file and suppresses the browser's *Save Page*. |
| **Load** | Ctrl/Cmd+O | Imports a `.bmm.json` / `.bmm.zip` file as a new board in the active workspace (staged: files are written before the board is published). |
| **Export** | — | Toolbar *Export*, the Boards dialog or the palette: download JSON, a ZIP with embedded files, Mermaid, an image or a checklist. |

Saving shows a brief toast and the toolbar stays quiet afterwards. Cloud success
is only announced after the board and its files were acknowledged by the server;
offline, expired-session, conflict and policy outcomes say *saved on this device
only* and leave a persistent banner with the next step. If saving to the device
fails, use **Export** to keep a copy. Exporting a ZIP stops with an explicit
message when file bytes are not available (for example offline), instead of
silently omitting files. Imports respect the same attachment policy as the
active role; a cloud import silently drops nothing—files without bytes are
listed in a warning. Native import/export is limited to 50 MiB of decompressed
content.

### Offline use, sync and recovery

After a cloud workspace has been opened once, the application shell and the
cached boards load offline. Edit, create, rename, duplicate and delete boards
offline; changes and file bytes stay on the device and synchronize
automatically after reconnecting, reloading or logging in again with the same
account. Conflicts never overwrite either side: your local version becomes a
clearly named conflict copy with its files, and a persistent notice explains
it. Files that were never downloaded to this device are marked *In the cloud,
not downloaded* and download when opened or exported while online.

Cache privacy: the account cache is a separate, unencrypted IndexedDB database
on the device. Logging out (or an expired session) locks it in every open tab,
and only a login to the same account unlocks it. **Settings → Cloud data on
this device** appears when such a cache exists and lets you explicitly discard
one account's device copy after a warning (changes that were never synchronized
are lost; your cloud data is unaffected).

### Board history

Logged in, **Board history** (Boards dialog or command palette) lists the
retained content revisions of the open board, lets you inspect a revision with
its files and restore it as a **new** revision (nothing is overwritten). Basic
accounts keep the latest 10 content revisions including the current one; admins
keep all. Only content changes count: camera-only moves, unchanged saves and
replayed requests never consume history. History needs a connection; offline it
says so. Restoring first waits until your local edits are acknowledged.

### Appearance

**Settings → Appearance** has one *Theme* dropdown: System (follows the OS live),
Light, Dark, Pale Rose, Windows 98 and CS3 Gray; **Language** is a separate tab.
Named themes ignore OS changes. The choice is applied before first paint,
guests keep it on the device, and logged-in accounts synchronize theme and
language as account configuration (changes made offline are queued; different
fields changed on different devices merge). Guest preferences are never
touched by account choices. Themes change only the interface chrome: board data,
node colors and exports are unaffected (image export uses the selected theme's
canvas, or the light theme if requested; printing a checklist is always dark
text on white).

### Keyboard shortcuts

P/V pointer · H hand · N new node · C connect · G snap · A auto-align · L layout
direction · M minimap · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo ·
**Ctrl/Cmd+S save** · **Ctrl/Cmd+O load** · Ctrl/Cmd+K command palette. Button
tooltips list their shortcut and appear on keyboard focus as well as hover.
Minimap and tag/filter controls sit at the bottom-left; the tag popover opens
next to its button, flips on collision and returns focus there on Escape.

## Persistence, synchronization and Docker

The board model and validation are compiled from the sibling
[shared contracts](../shared/README.md). Run builds from this checkout, keeping
that directory alongside `web/`. Backend setup and database migration commands
are described in the [API documentation](../api/README.md).

Guest attachment additions/imports are limited to 5 MiB (5,242,880 bytes) per
file and one file per block. Existing local over-limit files remain readable,
removable and exportable; their bytes are not truncated or rewritten.
Persistence adapters identify the workspace, require node-aware attachment
writes, and distinguish persistent local storage from memory fallback and
cloud acknowledgement. Guest storage never claims a cloud acknowledgement.

Account caches use separate `better-mindmap-account-<account UUID>` IndexedDB
databases, leaving the original version-1 guest database intact. File writes use
1 MiB chunks; incomplete writes are not available or acknowledged, and quota
errors propagate. Board snapshots and outbox changes commit atomically.
Unsent snapshots coalesce, but an in-flight mutation keeps its identity and
expected server revision across reloads. Newer local edits survive older
acknowledgements. Deletions retain local tombstones; unknown newer database or
board schemas are preserved rather than reset.

Editor mutations synchronously write a workspace-scoped recovery journal before
starting IndexedDB persistence. Each tab/board keeps only its latest pending
snapshot; acknowledged snapshots are removed, and older acknowledgements never
remove newer edits. Recovery checks revisions rather than timestamps and keeps
concurrent/deleted originals untouched, using a distinct recovery copy when
needed. Web Locks prevent recovering another live tab's journal where supported.
Guest and account journals use separate namespaces. Like IndexedDB, these
journals contain unencrypted board content on the device; they are not a defense
against someone with access to the browser profile. Account locking is enforced
by the workspace layer, not by guessing a workspace from editor content.

The 800 ms debounce remains for view-state/save scheduling, with
visibility/pagehide flushes as additional safeguards. Full/unavailable browser
storage or failed recovery produces a persistent warning: keep the tab open
until saving finishes or export. Memory-only saves do not clear recovery data.
File bytes must finish their IndexedDB write before attachment metadata is
published; the recovery journal does not store file bytes. A browser/process or
device crash that prevents both storage mechanisms from committing still cannot
guarantee durability.

Optional login now switches to an account-only local cache without copying or
removing guest boards. Logout durably queues revocation of the captured server
session, locks access
to the previous cache (including delayed reads), and restores the guest board.
An explicitly logged-out account is not reopened from a stale browser cookie;
an explicit login is required. Passwords and CSRF tokens are not persisted in
browser storage. Authentication expiry locks private access without discarding
queued work; matching-account login restores it. Network failures allow
unverified offline editing. Registration is not available.

The production Angular service worker caches only built application-shell
assets, including lazy routes. `/api/` responses and private file transfers are
never added to shared service-worker caches. After a successful visit/login,
an offline cold reload can reopen the last unlocked account cache, explicitly
marked offline/unverified. This grants no server authority. Offline local
logout locks that cache in all live tabs and restores guest boards immediately.
Its non-secret account/session identity survives reload for deferred revocation.
Startup, reconnect, focus, a bounded 30-second retry and matching-account login retry server logout using
fresh in-memory CSRF verification. Another account never authorizes that queue.
A delayed logout targets only the captured session and never clears a newer
login cookie. Until acknowledged, a persistent notice identifies server logout
as pending; a legacy cache without a captured identity explicitly requests
login/session rotation instead of guessing which session to revoke.

Application updates are offered without automatically replacing a running
editor. **Save and reload** waits for local persistence before reloading; queued
outbox data remains in the account database across application versions.
Failed saves keep the current page open. The service worker requires HTTPS
(or a trusted localhost origin) and is disabled in development builds.

Account synchronization runs automatically after startup, local commits,
reconnection and foreground focus. An account-specific Web Lock plus a durable
15-second IndexedDB lease coordinates tabs (the lease also works without Web
Locks). A matching live server session is required before replay. Mutations use
that session's CSRF token, so a changed browser cookie cannot publish account A's
queue using account B's session.

Replay stages new boards when files are needed, resumes missing multipart
parts from bounded cached ranges, verifies finalization, commits the frozen
snapshot, then processes later updates/deletion. Lost responses retain the same
mutation/upload identities; older acknowledgements never clear newer work.
Wholly unsent deletions cancel local dependencies and cached bytes. Duplicates
stage fresh file identities before publishing a visible copy, without reading
whole large files into memory. Unavailable bytes fail explicitly.

Transient network/429/5xx failures retry with exponential backoff (about 1 second
through 60 seconds, plus bounded jitter). New local writes do not reset that
backoff. Authentication, conflicts, schema/policy rejections and storage/protocol
errors pause replay while preserving the outbox and showing an actionable
banner. Completed autosync has no permanent success label.
Definitively rejected policy/missing-file snapshots may be replaced by later
local corrections; uncertain network retries keep their original identities
and frozen payloads. Deleting a definitively rejected unpublished board cancels
its remaining queue and cached bytes rather than blocking later work.

Remote metadata refreshes at startup/reconnect/focus and every 15 seconds while
the app remains open. First login hydrates existing boards before deciding
whether an empty board is needed. Requests bind to the captured session ID as
well as CSRF, including reads, preventing a cookie/account switch from filling
the wrong account cache. A clean open board follows remote revisions; pending
mutations always retry their receipt before interpreting a changed revision.

On a rejected stale write, a local transaction keeps the remote original and
preserves the latest local snapshot under a fresh, clearly named conflict-copy
identity. Cached file chunks are copied under new identities in that same
transaction. Camera-only changes rebase without a content conflict copy. Remote
deletion stays effective under the old identity. A stale offline deletion is
cancelled, preserving the newer remote board and a copy of the prior local
version; review the board before explicitly deleting again.

Recovery notices survive reload until dismissed. Uncached source files are
retrieved into bounded chunks when still authorized/available; missing source
bytes or a changed role/policy pause the copy's synchronization without erasing
the local document, available bytes or metadata. Quota failure rolls back the
entire recovery transaction and retains the original queue. The remaining
attachment-management/recovery UI is still in progress; do not discard an
account cache to resolve a paused queue.

Run the real API/PostgreSQL/private-object-storage synchronization acceptance
from the repository root (requires Docker):

```powershell
Set-Location api
npm run build
Set-Location ..\web
npm run build
npx playwright test --config playwright.cloud.config.ts
```

The runner binds a test-only frontend proxy on `127.0.0.1:4312`, starts isolated
randomly named database/object-storage containers, and removes them in teardown.
It exercises actual login, lost commit/part responses, a file above 5 MiB,
offline create/rename/duplicate/delete, cold offline reload and two reconnecting
tabs. Independent-device checks cover remote hydration, concurrent content
edits, cached and uncached attachment recovery, remote deletion with local edits,
and stale offline deletion against newer remote content. Session checks cover
offline logout/reload/reconnect, live-tab locks, expiry with queued work,
matching-account reauthentication and delayed revocation acknowledgements after
a newer login.
Test controls and ephemeral credentials are fixture-only, not deployed.
Full deployment acceptance on port 6610 is tracked separately in OpenSpec.

Run the production-shell regression (including offline cold reload, private
cache exclusion, and pending work across an update) from `web/`:

```powershell
npm run build
npx playwright test --config playwright.production.config.ts
```

The runner starts/stops its isolated fixture server on port 4311. Its update
endpoint is test-only and is not included in the deployed application.

From the repository root, create `containers/.env` from `containers/.env.example` (required
secrets; see [containers/README.md](../containers/README.md)) and start the complete stack
(application, API, PostgreSQL and private object storage) with:

```bash
docker compose -f containers/docker-compose.yaml up -d --build
```

Open `http://127.0.0.1:6610/` (the default `APP_ORIGIN`; set `APP_ORIGIN=http://localhost:6610` to
use `localhost`). Only the application port is published. Stop with
`docker compose -f containers/docker-compose.yaml down`, which keeps the data volumes.
Provisioning, backup/restore and production TLS are documented in `containers/README.md`.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
