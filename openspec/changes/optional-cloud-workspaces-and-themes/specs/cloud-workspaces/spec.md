# Spec Delta

## Purpose

Provides private account-owned cloud boards with durable offline editing and automatic synchronization without silently losing concurrent edits or mixing guest and account workspaces.

## ADDED Requirements

### Requirement: Separate guest and cloud workspaces
Authenticated users SHALL see only their account's cloud boards, including cached and locally pending cloud boards. Login SHALL NOT automatically upload, delete or merge guest boards. Logout SHALL restore the persistent guest workspace.

#### Scenario: Existing guest work
- **WHEN** a guest with local boards logs into an account
- **THEN** the cloud workspace opens and the guest boards remain unchanged outside that workspace

#### Scenario: First account login
- **WHEN** an account with no boards opens its cloud workspace
- **THEN** an empty named board is created with cloud synchronization status clearly indicated

### Requirement: Revision-safe cloud operations
The system SHALL support account-owned board creation, listing, loading, renaming, duplication and confirmed deletion. Updates SHALL use exact expected revisions, and retries SHALL NOT create duplicate boards, attachments or history entries. The server SHALL validate board content and reject unknown newer schemas without overwriting them.

#### Scenario: Stale revision
- **WHEN** a board save is based on an older revision than the server's current revision
- **THEN** the server rejects the overwrite and the client retains both versions through conflict recovery

#### Scenario: Lost response
- **WHEN** a committed operation is retried after its acknowledgement was lost
- **THEN** its original result is returned without applying the mutation twice

### Requirement: Full offline cloud editing
After an authenticated workspace has been cached, users SHALL be able to open cached boards, edit, create, rename, duplicate and delete boards while offline. Changes and attachment bytes SHALL persist locally across reloads. Uncached boards or attachment bytes SHALL be identified as unavailable offline rather than silently omitted.

#### Scenario: Reload offline
- **WHEN** a user edits a cached cloud board offline and reloads the application
- **THEN** the application shell opens, the cached board and queued edits are restored, and the workspace is identified as offline and unsynchronized

#### Scenario: Attachment unavailable offline
- **WHEN** a cached board references an attachment whose bytes were not downloaded before connectivity was lost
- **THEN** metadata remains visible with an offline-unavailable explanation and no false successful download

### Requirement: Automatic synchronization
The system SHALL automatically resume queued cloud work after startup or reconnection with a valid matching session. Synchronization SHALL preserve dependency order, retry transient failures without duplicate effects, and stop on authentication or policy rejection until resolved. Local-only queued work SHALL NOT be labeled saved to cloud.

#### Scenario: Reconnect with queued attachment
- **WHEN** a user reconnects with a new board and an offline-added attachment queued
- **THEN** synchronization uploads the required bytes and commits a consistent board without manual save

#### Scenario: Session expires offline
- **WHEN** connectivity returns after the session expires
- **THEN** queued work remains preserved, login is requested, and synchronization resumes only for the same authenticated account

### Requirement: Non-destructive conflict recovery
Concurrent content changes SHALL NOT silently overwrite one another. The system SHALL preserve unsynchronized local content as a clearly named recoverable conflict copy and retain the remote board, with an explicit notification. A remotely deleted board SHALL NOT be silently recreated under its old identity.

#### Scenario: Two devices edit
- **WHEN** two devices change the same revision and subsequently synchronize
- **THEN** one accepted version remains the remote original and the conflicting content and its attachments remain available in a distinct copy

#### Scenario: Offline edits meet remote deletion
- **WHEN** offline edits synchronize after the original board was deleted remotely
- **THEN** the deletion remains effective and local edits are preserved as a separately identified recovery copy

### Requirement: Private cache and multi-tab synchronization
Cloud caches, pending work, last-opened board and cross-tab messages SHALL be scoped by account. Multiple tabs SHALL coordinate synchronization so they do not replay one queue concurrently or discard unsaved work. Revoked or logged-out accounts SHALL NOT be available through the normal editor until authenticated again.

#### Scenario: Two tabs reconnect
- **WHEN** two tabs for the same account reconnect with the same queued operation
- **THEN** server state and history reflect one logical application of that operation

### Requirement: Account configuration
Authenticated appearance and language preferences SHALL be persisted as validated account configuration and cached for offline use. Guest preferences SHALL remain device-local. Configuration changes SHALL synchronize without creating board content history.

#### Scenario: Theme on another device
- **WHEN** a user changes their theme, synchronizes, and logs in on another device
- **THEN** that account's selected theme is applied without modifying guest preferences or board content
