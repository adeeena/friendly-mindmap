# Spec Delta

## MODIFIED Requirements

### Requirement: Attachments
The system SHALL let users attach files of any type to a node. New guest/basic attachments SHALL be limited to 5 MiB (5,242,880 bytes) each and one per node; admins SHALL have no application size/count quota. Nodes SHALL show an attachment count and the notes panel SHALL support opening, downloading and removing files. Guest bytes SHALL stay local; cloud bytes SHALL be private and owner-authorized.

#### Scenario: Attach a file
- **WHEN** a basic user drops a 2 MiB PDF onto a node with no attachment
- **THEN** the file is attached and listed in the panel

#### Scenario: Too large
- **WHEN** a guest or basic user attaches a file of 5,242,881 bytes
- **THEN** it is refused with an explicit 5 MiB limit message

#### Scenario: Exact size limit
- **WHEN** a guest or basic user attaches a file of exactly 5,242,880 bytes to an empty node
- **THEN** the size policy permits the attachment

#### Scenario: Image preview
- **WHEN** the attached file is an image
- **THEN** the panel shows a thumbnail preview when its bytes are available

#### Scenario: Second attachment
- **WHEN** a guest or basic user adds another file to a node already containing an attachment
- **THEN** the addition is rejected with a one-attachment-per-block explanation

#### Scenario: Admin attachments
- **WHEN** an admin adds multiple files to one node including a file larger than 5 MiB
- **THEN** no basic-user size or count restriction is applied

## ADDED Requirements

### Requirement: Authoritative attachment policy
The server SHALL enforce actual size, ownership and per-node count using stored roles across uploads, board saves, imports, duplication and restoration, including concurrent requests. Rejected operations SHALL NOT publish a partial board or silently drop files. Offline validation SHALL be rechecked by the server on synchronization.

#### Scenario: Concurrent basic uploads
- **WHEN** two uploads try to attach files concurrently to the same basic-owned node
- **THEN** no accepted board revision contains more than one new attachment on that node

#### Scenario: Offline role changes
- **WHEN** a queued attachment no longer complies with the account's role at synchronization time
- **THEN** the server rejects it, pending work remains recoverable, and a policy error is shown

### Requirement: Large file transfers
Cloud transfers SHALL provide progress, cancellation and resumable multipart upload for large files, without buffering entire large files in API memory. Interrupted or rejected uploads SHALL NOT appear as completed attachments. Physical storage/provider limits and local cache capacity errors SHALL be explicit.

#### Scenario: Interrupted upload
- **WHEN** an admin's large upload loses connectivity partway through
- **THEN** completed parts can be reused after reconnection and the file is not marked available before finalization

#### Scenario: Local storage exhausted
- **WHEN** an offline file cannot be persisted because device storage is full
- **THEN** the application reports the failure and does not claim the file is safely queued

### Requirement: Legacy attachment access and safe delivery
Existing local attachments exceeding new limits SHALL remain readable, removable and exportable without truncation. New imports or cloud commits SHALL obey destination policy. Untrusted active content SHALL NOT execute in the application origin; private downloads SHALL enforce ownership and safe content handling.

#### Scenario: Existing over-limit local board
- **WHEN** a guest opens an existing local board with multiple 10 MiB attachments on a node
- **THEN** the files remain accessible and exportable, while new additions must satisfy the new policy

#### Scenario: Active content download
- **WHEN** an owner opens an uploaded HTML or SVG file
- **THEN** it is downloaded or safely isolated rather than executed with the application's origin privileges
