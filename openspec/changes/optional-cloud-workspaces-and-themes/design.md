# Design

## Context

See [proposal.md](proposal.md) for motivation and scope.

- The Angular 21 application lives in `web/`; there is no backend. `containers/` currently builds static assets and serves them through nginx on port 6610.
- `BoardRepository` already abstracts asynchronous board/blob storage. `BoardSession` chooses IndexedDB, debounces autosave at 800 ms, tracks one revision, broadcasts tab changes, and creates a conflict copy on revision mismatch.
- The current repository attachment API lacks a node identifier and policy context. `EditorActions.loadFile` creates a board before inserting files directly, bypassing normal attachment validation. These are concrete integration points, not safe places to simply swap in HTTP calls.
- `BoardSession.collectOrphanAttachments` only considers the current document. Remote history requires different reference-aware cleanup.
- `EditorShell` binds `file.save` to export; its storage-error export fallback uses the same command. `Toaster` already provides transient live-region messages. `ChecklistPrint` bypasses the repository boundary by constructing IndexedDB storage directly.
- Settings persist light/dark/system and language locally. `index.html` pre-applies only light/dark; `styles.scss` defines theme tokens. Settings use radio controls. Bottom-left view controls exist, while tag management currently opens a modal dialog.
- Existing Jest/fake-indexeddb tests cover repositories and settings; Playwright covers persistence, content, responsive UX and AXE.

## Goals / Non-Goals

**Goals**

- Separate editor state from workspace selection, local durability and server acknowledgement.
- Make replay, concurrency and attachment lifecycle safe before adding automatic offline synchronization.
- Keep the existing guest database and board format compatible; reuse editor commands, CDK overlays, localization and toaster mechanisms.
- Keep large-file memory use bounded throughout browser queueing, nginx, API and storage.

**Non-Goals**

- No CRDT/realtime collaboration, cross-user sharing, public signup, password-reset email or admin management UI.
- No assertion that browser caches are encrypted or resistant to another person using the same OS/browser profile. Account isolation prevents application-level cross-account access, not device compromise.
- No guaranteed upload progress while the browser is closed, no prefetch of every remote attachment, and no unlimited physical storage promise.

## Decisions

### 1. Same-origin TypeScript API with relational authority

Add a small `api/` Node/TypeScript service using Fastify, PostgreSQL's `pg` driver with parameterized SQL, explicit versioned SQL migrations, Argon2id password hashing and the AWS S3 SDK. Reuse typed document validation through a small framework-independent shared contract/validation module extracted from existing core validation; do not make the API depend on Angular.

nginx serves static assets and proxies `/api/` and authenticated transfer routes. Keep PostgreSQL and S3-compatible storage (RustFS for the local container stack) on an internal network. This avoids unnecessary CORS and browser-accessible infrastructure credentials.

The user approved replacing local MinIO after both its Docker Hub and official Quay images failed to pull. Use the official RustFS image, verified available as `rustfs/rustfs@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2`, with explicitly supplied credentials and private buckets. Follow the [official Docker deployment guidance](https://docs.rustfs.com/en/installation/container/docker). The backend remains provider-neutral through the S3 protocol.

Alternatives: a browser-to-database connection cannot enforce ownership safely; a separate API origin complicates cookie and CSRF handling; a full application framework/ORM is unnecessary for this bounded API.

### 2. Schema, identities and transactional revisions

Use PostgreSQL `uuid`, `jsonb`, `timestamptz` and `bigint` where appropriate, not `nvarchar(max)` or large inline blob columns.

| Table | Principal fields and invariants |
|---|---|
| `users` | `id`, normalized unique `username`, `password_hash`, `display_name`, checked `role`, validated `configuration jsonb`, configuration revision, timestamps, `disabled_at` |
| `sessions` | `id`, unique token hash, user FK, CSRF binding, idle/absolute expiry, `revoked_at`; never store plaintext session tokens |
| `boards` | `id`, owner FK, name, content JSONB, schema version, camera/view JSONB, monotonic server revision, content revision, timestamps, deletion tombstone |
| `board_history` | Board FK, unique board/content revision, immutable snapshot/name/schema version, actor FK, timestamp |
| `board_attachments` | `id`, board/owner association, uploader, random storage key, original filename, declared/detected media type, actual byte count, checksum, state and timestamps |
| `board_attachment_refs` | Current board/node/attachment associations validated against committed content |
| `board_history_attachments` | History/node/attachment FKs preserving historical file references |
| `attachment_uploads` | Upload identity, owner/board/node, multipart identity, state, expiry, reserved slot and completed parts |
| `mutation_receipts` | Account + mutation UUID unique, request hash, committed result; retries with different payloads are rejected |

Use appropriate owner/updated-time, board/revision, expiry and reference indexes. Foreign keys and uniqueness constraints enforce relationships. Validate redundant JSON IDs/names against authoritative columns rather than permitting divergent copies. Existing board IDs can contain a legacy fallback format: keep guest IDs untouched, and remap legacy imported IDs/references to fresh cloud UUIDs at the explicit import boundary.

Writes lock the owned board, require the exact expected server revision, validate schema/content/attachment policy, commit content/history/references/receipt atomically, and return authoritative revisions. A null expected revision means create-only, never unconditional overwrite. Content hashes distinguish no-op and camera-only writes from content changes. Server revisions can advance for view changes, while content history does not.

Receipt lookup precedes mutation effects. Record request fingerprints; a retry after a lost response returns the committed result. Keep deletion tombstones and minimal deduplication identities for the supported lifetime of offline replay: initially no automatic expiration. Deletion removes content access immediately; background cleanup removes obsolete bytes. This prevents a long-offline device from resurrecting an old board.

### 3. Authentication and initial account

Provide `/api/auth/login`, `/api/auth/session` and `/api/auth/logout`; no registration route. Rotate an opaque cryptographically random session token at login, store only its hash, set an HttpOnly SameSite cookie, and require Secure in production. Development HTTP relaxation is explicit and limited to localhost configuration. Verify Origin and a session-bound CSRF token for mutations, including multipart initiation/finalization; protect login/logout against cross-origin requests too.

Use generic login errors, bounded password lengths, Argon2id, persistent account/IP throttling and redacted structured logs. Check ownership and the current database role on every operation; admins do not bypass other users' ownership. Define idle and absolute expiration centrally with documented defaults.

A separate development-only bootstrap command reads username/password from environment or mounted secret input, defaults the requested username to `adena`, and inserts an admin if absent. It never contains the password in tracked files, logs it, resets existing passwords or runs implicitly in production. Provide an explicit operator password-change command that hashes the replacement and revokes sessions. Other test accounts are created by test fixtures/operator tooling, not signup.

On online logout, revoke before completing the workspace transition. Offline logout locks the account workspace locally immediately and queues revocation of that specific session for reconnection; clearly report that server revocation is pending. Never let a delayed logout revoke a newer session.

### 4. Workspace-aware local persistence and outbox

Keep the existing guest IndexedDB unchanged. Add account-namespaced databases for board cache, attachment chunks, outbox, remote base revisions, tombstones and account preferences. `WorkspaceSession` selects guest versus account repositories; `BoardSession` continues owning editor lifecycle, with explicit account transition and synchronization results.

```text
Editor mutation
      |
      v
Local transaction: snapshot + attachment refs + outbox
      |
      +--> local-durable state
      |
      v
Account sync coordinator --> API revision check --> PostgreSQL
      |                              |
      |                              +--> private object storage
      v
acknowledged / retry / auth-required / policy-error / conflict
```

Track local sequence numbers separately from server revision. Acknowledging an older in-flight snapshot never clears newer pending edits. Persist recoverable mutations promptly rather than relying solely on asynchronous page-close handlers; retain the 800 ms debounce for normal save/sync work, and flush on visibility/pagehide as an additional safeguard. Do not claim durability until the local transaction completes. Test immediate-close recovery explicitly.

Cloud mode caches every successfully loaded board. Offline opening is limited to cached boards and cached attachment bytes, with explicit unavailability for missing bytes. New offline boards, rename, duplicate and delete operations enter the outbox. Collapsing unsent snapshots is permitted, but explicit save promises track the requested local sequence. Every content revision actually committed to the server is recorded.

Use an Angular production service worker for application-shell assets, with navigation fallback for app/print routes. Do not runtime-cache `/api/`, login responses, private downloads or signed URLs in shared service-worker caches. Board/blob caches remain explicit account-scoped IndexedDB. Handle application updates without discarding an active draft.

The UI may reopen the last non-logged-out authenticated account's cached workspace offline, clearly marked offline/unverified. This does not grant server authority: sync must first verify `/auth/session` identifies that account. Explicit logout locks that account's cache; never automatically unlock it from a stale browser cookie. Guest state remains separate throughout.

For reconnect while the app is open, combine browser online/startup events with bounded retry/backoff and foreground refresh. A tab lease/lock coordinates one sync owner per account; operation receipts remain authoritative when tabs race. Requests capture account/session generation; responses from an old generation cannot mutate the next workspace.

Alternative: replacing IndexedDB with an HTTP-only repository fails the agreed full offline requirement. A shared unnamespaced cache would leak account state. A service worker alone does not solve revision or ownership conflicts.

### 5. Synchronization and conflicts

Process each board's operations serially, respecting create/upload/finalize/commit/delete dependencies. Retry transient network/5xx failures with backoff; pause on 401, policy rejection or conflict. Pull remote board metadata/revisions on startup, reconnection, focus and a modest foreground polling interval; no realtime socket is required initially.

On 409, retain the remote original and materialize the local content as a clearly named separate conflict board with all referenced local file bytes. Notify the user. If current role policy prevents uploading the recovery copy, retain it locally and offer correction/export; never discard it or report success. A stale local camera-only change can rebase without creating a content conflict copy.

If remote deletion meets pending edits, preserve edits under a fresh recovery ID and honor the deletion tombstone. If an offline delete meets a changed remote revision, require conflict resolution rather than silently deleting new work. Deleting a not-yet-uploaded board cancels its dependent unsent operations and cleans staged bytes safely.

Logout flushes local durability but does not erase pending work. Re-authentication as the same account resumes automatic sync; another account cannot see or replay it. Settings use their own revision and per-field pending changes, not whole-object last-writer replacement that could erase a remotely changed language when only theme was edited.

### 6. Private, streamed attachments and policy

Store bytes in private S3 objects; metadata and reference ownership live in PostgreSQL. APIs initiate, upload parts, list parts, complete, download and abort using owner-checked opaque upload IDs. Stream each part through the API to object storage to keep the browser same-origin and avoid public RustFS ports. Set nginx request buffering off for transfer routes and configure transfer limits/timeouts independently from small JSON endpoints.

Guest/basic policies are 5,242,880 bytes per attachment and one attachment per node. Admin limits are absent at the application policy layer, not encoded as a giant integer or accidental proxy cap. Document provider multipart maximums and filesystem/browser quotas.

Include node ID and role/policy context in the storage boundary. Reserve a basic node's upload slot transactionally, with expiry/abort releasing it. Finalization checks actual size/checksum and authorization, while the board commit locks/revalidates all current node associations; concurrent requests cannot bypass count limits through JSON metadata, duplication, import or restore.

Keep pending cloud attachment chunks in IndexedDB using bounded-size chunks and quota checks; avoid whole-file array buffers or ZIP buffering for large files. Online large transfers use bounded parts too. Uncached existing remote files need not be downloaded automatically. Local offline duplication can reference immutable cached blobs until server-side copy/rebinding has completed.

Stage imports and duplicate files before publishing their board. Any policy/validation/storage failure leaves no visible partial board; abandoned staged objects are reclaimed. Existing local over-limit files remain readable/exportable, but newly imported or uploaded cloud copies must meet destination policy. Existing archive safety guards (entry counts, decompression bounds and safe paths) remain enforced; large transfer support does not disable import protections.

Downloads use owner checks, safe content disposition, `nosniff` and no shared/private response caching. Active types are downloads, not inline app-origin execution. Thumbnails use safe raster formats; do not load an entire multi-gigabyte file merely to show a preview.

Alternative: PostgreSQL `bytea` or large objects complicate very large transfers, database growth and backups. Object storage gives multipart transfer and bounded memory, at the cost of explicit reference cleanup and coherent backups.

### 7. History semantics and cleanup

Count "last 10 modifications" as the latest 10 committed content snapshots, including current content. Initial creation is a content snapshot; camera, account configuration, no-op save and replayed requests do not create one. One offline coalesced commit is one revision, not every local keystroke.

Use the board owner's current database role. Basic commits prune to 10 atomically with the new history snapshot; admin commits do not prune. If an operator changes a role, the next successful content commit applies the new retention policy; do not invent a role-management UI.

Expose owner-authorized history list/detail/restore actions in the board UI. Restore validates current policy, requires current revision, then creates a new content revision; do not mutate a historical snapshot in place. Offline users can inspect cached history if available; online-only history/restore actions explain their availability rather than pretending an uncached snapshot exists.

Cleanup considers current refs, retained history, live multipart uploads and staged transactions. Server objects become eligible only when all references disappear; make deletion retryable. Keep guest undo cleanup behavior local, and retain referenced blobs for locally pending/undoable work. Do not run current-document-only cleanup against the cloud store.

### 8. Save feedback, command semantics and anchored controls

Separate `board.save` from `file.export` at commands/actions; update toolbar, palette, key labels and the existing storage-error export fallback together. Ctrl/Cmd+S seals editor text/notes state, persists the requested sequence, and awaits its server acknowledgement if online. If offline, persist and queue with clear unsynced feedback. A no-op explicit save confirms known persistence without making history.

Reuse `Toaster` for short "Saved locally"/"Saved to cloud" success notices. Routine autosave is silent. Remove the permanent success label, but retain an accessible saving/unsynced indicator and an actionable persistent error surface with retry/export/login as appropriate. Do not use timed toasts as the only error channel.

Add the exact guest cloud-login notice to Save/Load surfaces without blocking import/export. Keep Ctrl/Cmd+O as native file import. Logged-in native import creates a cloud-workspace board and queues if offline. Logout returns the previous guest board.

Keep view buttons in the bottom-left group. Use CDK connected overlays/tooltip origins bound to the actual buttons, with viewport margins, collision fallback and resize repositioning. Tag/filter content opened from that button is anchored, not centered as the current modal is. Preserve keyboard focus management, Escape, hover/focus descriptions and canvas interactions. Controls sit outside the camera-transformed world layer.

Route checklist printing through workspace-aware storage instead of constructing a guest repository. Print routes include workspace context but never trust a URL's account ID as authorization. Offline print uses available account cache; logout/account changes block private print access.

### 9. Six themes, one dropdown

Extend the theme union, validation, stored settings and localized choices to `system`, `light`, `dark`, `pale-rose`, `win98`, `cs3-gray`. System alone resolves through matchMedia; the three new themes have fixed light color schemes and do not react to OS dark-mode changes.

Use root theme tokens plus narrowly scoped chrome/layout modifiers for square bevels and compact gray panels. Preserve the existing semantic board color keys, geometry and commands. Do not import proprietary artwork or exact branded assets. Give retro themes visible focus and minimum accessible hit targets rather than recreating historical accessibility defects.

Update the first-paint script, CSS defaults, dropdown, account configuration validation, image-export temporary light overrides and all theme-dependent tests together. Persist guest preferences separately from per-account preferences; switching workspaces applies the correct set without overwriting the guest choice.

## Risks / Trade-offs

- [Offline sync is significantly larger than remote CRUD] -> Explicit outbox, replay, deletion, account-switch and two-device tests precede UI success claims.
- [Browser termination can interrupt asynchronous writes] -> Persist recovery mutations promptly, minimize the uncommitted window and test immediate close; surface quota/unavailable-storage failures instead of claiming unconditional durability.
- [Admin history and files grow without a quota] -> Document capacity, monitor failures and provide coherent backups; do not silently prune admin content.
- [Cached private data remains on the device] -> Namespace and lock it on logout, explain the device-trust limitation, and offer explicit account-cache discard with a warning for unsynced work.
- [Session expires during upload] -> Pause and retain resumable state; require the matching account to reauthenticate before continuing.
- [Database/object-store operations are not one transaction] -> Stage uploads, publish references transactionally, and use idempotent cleanup plus retryable finalization.
- [Large native ZIP export/import can exhaust browser memory] -> Keep bounded archive safety limits, use streaming where supported, and explain capacity failures without truncation.
- [Retro styling can break overlays/contrast] -> Cover every theme with desktop/mobile screenshots, anchored-position assertions and AXE scans.

## Migration Plan

1. Add backend/shared modules and database migrations without touching existing guest data. Start infrastructure with required secrets; migrate under a single migration lock before readiness.
2. Deploy workspace-aware IndexedDB migrations that preserve guest records, add account cache/outbox stores and keep unsupported schema versions read-only.
3. Configure private object storage and API/nginx routes. Bootstrap `adena` explicitly in the development environment using a supplied initial password; test with an independently created basic fixture.
4. Wire authentication, offline app-shell caching and workspace transitions. Keep native import/export recovery paths available throughout.
5. Enable automatic sync only once revision, replay, role-policy and account-isolation integration tests pass; then wire history and large transfers.
6. Add themes and feedback/overlay changes; update directly related deployment and usage documentation.
7. Verify the fresh-container full loop, restart persistence and an isolated backup restore before declaring completion.

Rollback: retain PostgreSQL/object volumes and guest IndexedDB. Stop API mutations before reverting backend/schema changes; prefer forward corrective migrations, not destructive down migrations. A frontend rollback cannot safely consume a newer account-cache schema: preserve queued work and use supported-version/read-only handling rather than deleting it. Never clear a cloud queue to make rollback appear successful.
