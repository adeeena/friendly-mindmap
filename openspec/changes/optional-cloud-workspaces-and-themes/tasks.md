# Tasks

## 1. Backend foundation and shared contracts

- [x] 1.1 Add the strict TypeScript API package and extract framework-independent board/schema validation for browser/server reuse without importing Angular; verify both packages type-check and existing migration/validation tests still pass.
- [x] 1.2 Add versioned PostgreSQL migrations for accounts, sessions, boards, history, current/historical attachment references, upload state and mutation receipts with constraints/indexes; verify migrations run twice safely against an isolated fresh database.
- [x] 1.3 Add structured redacted errors/logging, database transactions and readiness endpoints; verify missing configuration, unavailable database and migration failures produce explicit diagnostics without secret leakage.
- [x] 1.4 Document backend development, migration commands, API error shapes and environment inputs in the directly related project documentation; verify the documented setup reaches a healthy isolated API.

## 2. Authentication and account provisioning

- [x] 2.1 Implement Argon2id credential verification, normalized usernames, generic failures and persistent login throttling; verify valid/invalid credentials, normalization and repeated-failure tests.
- [x] 2.2 Implement session login/query/logout with token rotation, hashed server tokens, expiration, HttpOnly/SameSite cookies, production Secure cookies and CSRF/Origin checks; verify session expiry, forgery rejection, revoked sessions and secret-redaction tests.
- [x] 2.3 Implement shared server ownership/current-role guards for all private endpoints and validated revisioned account configuration; verify cross-account identifiers and client-supplied role changes cannot grant access.
- [x] 2.4 Add explicit development bootstrap for admin `adena` using externally supplied password input, plus an operator password-change command; verify bootstrap is repeatable, restarts never reset passwords and production startup never seeds known credentials.
- [x] 2.5 Document authentication lifecycle, safe local bootstrap and password rotation without embedding the requested password; verify supplied credentials complete login/logout and rotation revokes old sessions.

## 3. Cloud board operations and revision authority

- [x] 3.1 Implement owner-scoped list/load/create/save/rename/delete endpoints with exact revision checks and create-only semantics; verify stale, missing, foreign-owned, invalid and newer-schema boards cannot be overwritten.
- [x] 3.2 Implement transactional mutation receipts with request fingerprints and deletion tombstones; verify lost-response replay has one effect, reused mutation IDs with different payloads fail and deleted identities cannot be recreated by stale clients.
- [x] 3.3 Add content/view change discrimination and atomic content-history insertion; verify content commits increment history while unchanged, camera-only and replayed saves do not.
- [x] 3.4 Document the board API, revision/conflict responses, idempotency and deletion behavior; verify API contract tests exercise the documented response shapes.

## 4. Private attachments and policy

- [x] 4.1 Add private object storage and metadata-backed authorized downloads with safe disposition, content-type handling and checksums; verify cross-account download denial and HTML/SVG cannot execute in the app origin.
- [x] 4.2 Implement initiate/part/status/complete/abort upload operations with bounded streaming, expiry and resumable state; verify interrupted multipart transfer resumes without reuploading completed parts or exposing incomplete files.
- [x] 4.3 Enforce authoritative 5,242,880-byte/one-per-node guest/basic policy and absent admin application quotas, including actual-byte checks and transactional node-slot reservations; verify exact boundary, boundary-plus-one, parallel basic uploads and multi-file admin cases.
- [x] 4.4 Implement staged atomic import/duplication and reference-checked board commits rather than trusting attachment JSON; verify policy rejection, missing objects and injected attachment IDs leave no visible partial board.
- [x] 4.5 Add reference-aware, retryable upload/object cleanup considering current/history refs and active transfers; verify referenced bytes survive cleanup and abandoned unreferenced uploads are reclaimed.
- [x] 4.6 Document transfer lifecycle, supported provider limits and failure/retry behavior; verify a file above the basic limit streams through the API with memory bounded by configured part buffers.

## 5. Workspace persistence and offline synchronization

- [x] 5.1 Extend the storage boundary with node-aware attachment context, workspace identity and separate local/server save results; verify memory/IndexedDB contract tests and existing guest behavior remain compatible.
- [x] 5.2 Add account-isolated IndexedDB board/blob-chunk caches, durable outbox, base revisions and tombstones while preserving the original guest database; verify migration, offline reload, quota-failure and legacy guest-data tests.
- [x] 5.3 Add prompt recoverable local mutation persistence and snapshot sequence tracking around the existing autosave debounce; verify immediate tab-close recovery and that acknowledgement of an in-flight older snapshot never clears newer edits.
- [x] 5.4 Implement workspace transitions, login UI, display-name/logout actions and private-cache locking; verify login preserves guest boards, logout returns to them, and delayed requests from account A cannot mutate account B.
- [x] 5.5 Add production application-shell service-worker caching without shared private API/blob caches; verify offline cold reload after a successful visit loads cached account boards and preserves queued work through application updates.
- [x] 5.6 Implement per-account sync ownership, ordered create/upload/commit/delete replay, backoff and automatic reconnect/startup sync; verify duplicate-tab replay, lost responses, new offline boards and offline rename/duplicate/delete cases.
- [x] 5.7 Implement remote refresh, non-destructive conflict copies and tombstone conflict recovery; verify two-device edits, remote deletion with local edits and offline deletion against newer remote content preserve both recoverable versions.
- [x] 5.8 Implement expired-session pause, matching-account reauthentication, offline logout locking and deferred session-specific revocation; verify queued work never replays under a different account and delayed logout cannot revoke a newer session.
- [x] 5.9 Wire file picker/drop, notes panel, offline attachment queue/progress/cancel, immutable duplicate references and account-aware checklist printing; verify uncached bytes report unavailable, quota failures are explicit and private print routes lock after logout.
- [x] 5.10 Persist/synchronize validated account appearance/language changes separately from guest settings; verify cross-device preference recovery and concurrent changes to different preference fields do not erase each other.
- [x] 5.11 Document guest/cloud separation, offline capabilities, cache privacy, unsynced recovery and explicit cache discard; verify Playwright covers the documented guest-login-offline-reconnect-logout sequence.

## 6. History browsing, retention and restore

- [x] 6.1 Implement history list/detail/restore APIs with owner authorization and current-revision checks; verify restore creates a new content revision and concurrent restore conflicts do not overwrite newer work.
- [x] 6.2 Apply latest-10 retention for basic owners and all-history retention for admins, preserving current content and referenced files; verify commits 10/11/12, admin revisions above 10 and removal of the final historical attachment reference.
- [x] 6.3 Add accessible board history browsing/inspection/restore UI with clear uncached/offline availability and policy failures; verify restoration includes historical attachment bytes and expired revisions are not offered.
- [x] 6.4 Document content-revision counting, role-based retention and restore behavior; verify camera-only/no-op/replayed saves never consume history slots and historical snapshots remain immutable.

## 7. Save feedback, import/export and bottom-left overlays

- [x] 7.1 Separate workspace Save from file Export across shell commands, toolbar, palette and storage-error export fallback; verify Ctrl/Cmd+S while editing includes current text, suppresses browser Save Page and never downloads a file.
- [x] 7.2 Replace permanent Saved text with brief explicit-save toasts, quiet autosave, accessible saving/unsynced state and persistent retry/login/export errors; verify cloud success waits for the requested board/attachment acknowledgement and failures never show success.
- [x] 7.3 Add the exact guest cloud-login notice to Save/Load surfaces and keep Ctrl/Cmd+O/native import and explicit export usable without login; verify guest and logged-in command/dialog flows.
- [x] 7.4 Route native import through staged policy-aware workspace operations and make missing-byte bundled exports fail explicitly; verify JSON/ZIP round trips, rejected over-limit imports, legacy local export access and offline import synchronization.
- [x] 7.5 Keep minimap/tag controls bottom-left and anchor their tooltips/popovers to actual button origins with collision fallback and focus restoration; verify hover/focus, Escape, resize, pan/zoom and 375px viewport geometry assertions.
- [x] 7.6 Update all affected localized labels/help and shortcut documentation; verify language variants expose no missing keys and AXE passes the save/login/overlay surfaces.

## 8. Appearance dropdown and complete themes

- [x] 8.1 Replace Appearance radios with one labeled six-option dropdown; extend theme validation, local/account settings and pre-paint initialization; verify existing preferences migrate and System alone follows OS changes.
- [x] 8.2 Implement Pale Rose tokens across canvas/shell/panels/menus/toasts with readable dark text; verify persisted selection and contrast checks in open editor/dialog states.
- [x] 8.3 Implement Windows 98 gray square beveled chrome and pressed/focus states without altering board geometry or accessible hit targets; verify desktop/mobile screenshots and keyboard interactions.
- [x] 8.4 Implement compact CS3 Gray panels/tool groups and restrained gradients using original styling rather than proprietary assets; verify desktop/mobile screenshots and no clipped or inaccessible controls.
- [x] 8.5 Update image-export light-theme overrides, print isolation and theme-dependent tests; verify all six choices preserve board JSON/colors and exports restore the selected app theme afterward.
- [x] 8.6 Document the six themes and preference synchronization; verify Playwright/AXE covers every theme with notes, settings, menus and anchored overlays at desktop and narrow widths.

## 9. Container deployment and integrated acceptance

- [x] 9.1 Extend container builds/compose with the API, PostgreSQL, private RustFS, migrations, required secrets, health checks and named volumes; verify compose validation and fresh startup expose only the application port by default.
- [x] 9.2 Configure nginx same-origin API routing, separate JSON/streamed-transfer settings and offline shell assets; verify an admin multipart upload above 5 MiB survives proxying without full-file buffering or a hidden basic-user cap.
- [x] 9.3 Update deployment documentation for required inputs, explicit development bootstrap, normal shutdown, password rotation, volume retention and coherent database/object backup/restore; verify a restored isolated stack can load a board, retained revision and file.
- [x] 9.4 Run targeted frontend Jest suites, backend unit/integration suites, frontend/backend production builds and container-backed Playwright; verify all failures related to changed contracts are resolved and production offline service-worker behavior is exercised.
- [x] 9.5 Verify the requested admin full loop: provision using a supplied password, login, create/edit, Ctrl/Cmd+S, reload/second-device load, multiple/large attachments, history restore and logout; repeat limits/history checks with a basic fixture and confirm server persistence across restart.
- [x] 9.6 Verify integrated offline/failure recovery: edit and attach offline, reload, reconnect automatic sync, expire a session, switch accounts, race two tabs/devices and interrupt storage; confirm no cross-account exposure, silent overwrite or false cloud-success toast.
