# Spec Delta

## Purpose

Keeps durable cloud board content revisions and the attachment references needed to inspect and restore them, independently of session undo and redo.

## ADDED Requirements

### Requirement: Durable committed content revisions
Each accepted content-changing cloud commit SHALL create one immutable history revision with its revision number, timestamp and actor. Camera-only changes, unchanged saves, failed saves and replayed retries SHALL NOT add content history. History SHALL remain distinct from session undo/redo.

#### Scenario: Explicit save and retry
- **WHEN** a content change is committed and its save request is retried
- **THEN** exactly one content revision exists for that change

#### Scenario: Pan and save
- **WHEN** only the camera changes and the user saves
- **THEN** the camera is persisted without adding a content history revision

### Requirement: Role-based retention
Basic-owned boards SHALL retain the latest 10 committed content revisions, including the current content revision. Admin-owned boards SHALL retain all committed content revisions until explicit board deletion. Retention SHALL use the owner's server-authoritative role and SHALL NOT remove current board content.

#### Scenario: Eleventh basic revision
- **WHEN** a basic-owned board receives its eleventh distinct content revision
- **THEN** only the latest 10 history revisions remain accessible

#### Scenario: Admin history grows
- **WHEN** an admin-owned board receives more than 10 content revisions
- **THEN** all its committed content revisions remain accessible

### Requirement: Inspect and restore
Owners SHALL be able to list and inspect retained cloud history and restore a selected revision as a new content commit guarded by the current revision. Restoration SHALL preserve the historical snapshot, obey current attachment policy, and reject incompatible restores without altering the current board.

#### Scenario: Restore prior content
- **WHEN** an owner restores an older retained revision
- **THEN** its content and available attachments become the current board in a new revision and normal retention applies

#### Scenario: Concurrent change during restore
- **WHEN** another device updates the board before a restore commits
- **THEN** restoration is rejected as a conflict without overwriting the newer content

### Requirement: History-aware attachment lifetime
Attachment bytes referenced by current content or retained history SHALL remain retrievable by the owner. Cleanup SHALL remove bytes only after all such references and active transfer references are gone. Explicit board deletion SHALL remove access to its history and schedule unreferenced bytes for cleanup.

#### Scenario: Attachment removed from current board
- **WHEN** a file is removed from current content but a retained historical revision references it
- **THEN** the file remains available when viewing or restoring that revision

#### Scenario: Old revision expires
- **WHEN** pruning removes the final retained reference to an attachment not used by current content
- **THEN** that attachment becomes eligible for cleanup without affecting any remaining revision
