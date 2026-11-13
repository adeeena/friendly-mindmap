# Proposal

## Why

The browser-only editor cannot retain boards across devices or support authenticated storage, while its permanent save label and detached overlays obscure useful feedback. Add optional, offline-capable cloud workspaces without sacrificing guest local persistence, alongside clearer save feedback and selectable visual themes.

## What Changes

- Add username/password login and logout with no registration UI or public registration API. Provision the requested development admin through explicit secret-fed bootstrap, never committed credentials.
- Keep guest boards locally until explicitly discarded; authenticated users see only their own cloud workspace. Login never implicitly uploads or removes guest boards; logout restores the guest workspace.
- Add PostgreSQL-backed accounts, sessions, boards, revision history and attachment metadata, plus private S3-compatible storage for large file bytes.
- Support full offline editing of cached cloud boards, durable account-isolated synchronization queues, automatic reconnect synchronization, and non-destructive conflict handling.
- Make Ctrl/Cmd+S immediately persist locally and request cloud synchronization when authenticated. Show success in transient toasts only after the relevant persistence acknowledgement; retain actionable unsynced/error feedback.
- **BREAKING**: Ctrl/Cmd+S no longer opens native file export. File download remains an explicit Export action; native import remains available.
- **BREAKING**: New guest/basic attachments are limited to 5 MiB each and one per block; admins have no application-level size/count quota. Preserve access/export of existing local attachments exceeding new limits.
- Retain the latest 10 committed content revisions for basic-owned boards and all revisions for admin-owned boards, with historical attachment references and restoration.
- Complete the container stack with migration/bootstrap operations, durable storage, health checks and documented backup/restore.
- Keep minimap/tag controls bottom-left and anchor tooltips/popovers to their triggering controls within the viewport.
- Replace Appearance theme radios with one dropdown: System, Light, Dark, Pale Rose, Windows 98, CS3 Gray.

## Capabilities

### New Capabilities

- `user-auth`: Optional authentication, private account boundaries, sessions, roles and explicit development provisioning.
- `cloud-workspaces`: Account-scoped cloud CRUD, offline cache/outbox, synchronization, conflicts, deletion and preferences.
- `board-history`: Durable content revision history, role-based retention and safe restore.
- `deployment-stack`: Containerized API, PostgreSQL and object storage with lifecycle, secrets, health and recovery operations.

### Modified Capabilities

- `board-persistence`: Local/cloud workspace routing, durable autosave, explicit save feedback and account-aware storage contracts.
- `node-content`: Role-based attachments, large file transfer, legacy access and authoritative validation.
- `import-export`: Separate persistence saves from file exports and apply destination attachment policies atomically on import.
- `editor-tools`: Save shortcut semantics, optional account actions and anchored bottom-left view overlays.
- `canvas-viewport`: Six-choice theme dropdown, persistent full-shell visual treatments and accessibility.

## Impact

- Extend Angular persistence/session handling, commands/actions, settings and first-paint theme initialization, shell/dialogs, attachments, printing, export, localization and styles.
- Introduce a TypeScript backend, migrations and integration tests; expand container definitions and nginx API/upload routing.
- Add PostgreSQL and private object storage dependencies, authenticated APIs, durable offline state and ownership-aware revision checks.
- Extend Jest, Playwright and AXE coverage plus container-backed end-to-end verification.
- No sharing/collaboration, registration, password-reset email workflow, administrator user-management UI or unlimited physical storage guarantee is included.
