# Spec Delta

## MODIFIED Requirements

### Requirement: Autosave
The system SHALL automatically persist the current board and its attachments locally shortly after changes stop (within 1 second), flush pending work when hidden or closed, and queue authenticated cloud changes for synchronization. Routine successful autosaves SHALL stay quiet; saving, unsynced and error states SHALL be accessible without permanently displaying "Saved".

#### Scenario: Survives reload
- **WHEN** the user edits a node and reloads the page after 2 seconds
- **THEN** the edit is present

#### Scenario: Save on tab close
- **WHEN** the user edits a node and closes the tab immediately
- **THEN** the edit is present the next time the app opens

#### Scenario: Storage failure
- **WHEN** saving fails because storage is full or unavailable
- **THEN** an error status is shown and the user is offered to export the board as a file

#### Scenario: Routine cloud autosave
- **WHEN** an authenticated board change is persisted locally and acknowledged by the server
- **THEN** no routine success toast or permanent Saved label is displayed

### Requirement: Autoload
On startup the system SHALL reopen the most recently used board with its camera and settings in the active guest or authenticated workspace; if that workspace has no boards it SHALL create an empty board named "Untitled board". Guest boards SHALL remain locally persisted until explicitly discarded and SHALL NOT be implicitly uploaded during login.

#### Scenario: First launch
- **WHEN** the app opens with no stored boards
- **THEN** an empty board "Untitled board" is created and opened

#### Scenario: Workspace-specific last board
- **WHEN** an authenticated user logs out
- **THEN** the guest workspace reopens its own last-used board rather than an account board

### Requirement: Multi-tab consistency
When the same board is changed in another open tab of the same workspace, the system SHALL reload the board in an inactive tab without pending edits rather than overwrite newer data. Pending edits SHALL be preserved through conflict recovery. Account and guest messages SHALL remain isolated.

#### Scenario: Two tabs
- **WHEN** board "Work" is edited in tab 1 while tab 2 shows "Work" without pending edits
- **THEN** tab 2 updates to the saved content from tab 1

#### Scenario: Separate accounts
- **WHEN** a tab receives a board-change notification for another account
- **THEN** it neither loads that board nor alters its active workspace

### Requirement: Storage boundary for future API
All board and attachment reads and writes SHALL use a common asynchronous storage contract with revision checks, supporting guest local storage and authenticated offline-capable cloud storage without changing editor behavior. Persistence results SHALL distinguish local durability from server acknowledgement.

#### Scenario: Revision increments
- **WHEN** a board is saved twice with distinct changes
- **THEN** its stored revision number increases on each accepted save

#### Scenario: Offline persistence result
- **WHEN** a cloud board is durably stored locally but has not reached the server
- **THEN** the result indicates pending cloud synchronization, not cloud success

## ADDED Requirements

### Requirement: Explicit save and transient success
Ctrl/Cmd+S and the Save action SHALL immediately persist pending edits and, when authenticated, request cloud synchronization. A brief accessible toast SHALL confirm "Saved locally" for guests or "Saved to cloud" only after server acknowledgement of the requested state and attachments. Failures SHALL preserve work and show persistent actionable feedback.

#### Scenario: Guest explicit save
- **WHEN** a guest presses Ctrl/Cmd+S
- **THEN** local persistence is flushed, a transient "Saved locally" toast appears on success, and the cloud-login notice is shown

#### Scenario: Authenticated explicit save
- **WHEN** a logged-in user presses Ctrl/Cmd+S with pending changes
- **THEN** the changes and referenced attachment bytes synchronize immediately and "Saved to cloud" appears only after acknowledgement

#### Scenario: Offline explicit save
- **WHEN** a logged-in user presses Ctrl/Cmd+S while offline
- **THEN** work is persisted locally and queued, an unsynced explanation is shown, and no "Saved to cloud" toast appears

#### Scenario: Save unchanged board
- **WHEN** a user explicitly saves an already synchronized board
- **THEN** a success toast confirms its persisted state without creating a duplicate content revision

### Requirement: Cloud login notice
Guest save/load surfaces SHALL display "For saving data to cloud, please log in" with an accessible login action, without blocking local persistence or file import/export.

#### Scenario: Guest opens load
- **WHEN** a guest opens a save or load surface
- **THEN** the exact cloud-login notice is visible and local actions remain usable
