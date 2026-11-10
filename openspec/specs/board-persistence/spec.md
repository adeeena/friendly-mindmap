# board-persistence Specification

## Purpose

Defines how users manage multiple boards and how boards and their attachments are automatically saved and restored on the device, behind a storage boundary that a remote API can later fulfill.

## Requirements

### Requirement: Multiple boards
The system SHALL let the user create, rename, duplicate, delete (with confirmation) and switch between named boards from a board switcher, showing each board's name and last-modified time.

#### Scenario: Create and switch
- **WHEN** the user creates board "Trip" and then switches back to board "Work"
- **THEN** "Work" opens with its own content, camera and settings

#### Scenario: Delete requires confirmation
- **WHEN** the user chooses to delete board "Trip"
- **THEN** a confirmation dialog appears and the board is deleted only after confirming

### Requirement: Autosave
The system SHALL automatically save the current board and its attachments to on-device storage shortly after changes stop (within 1 second) and immediately when the page is hidden or closed, and indicate save status (saving, saved, error).

#### Scenario: Survives reload
- **WHEN** the user edits a node and reloads the page after 2 seconds
- **THEN** the edit is present

#### Scenario: Save on tab close
- **WHEN** the user edits a node and closes the tab immediately
- **THEN** the edit is present the next time the app opens

#### Scenario: Storage failure
- **WHEN** saving fails because storage is full or unavailable
- **THEN** an error status is shown and the user is offered to export the board as a file

### Requirement: Autoload
On startup the system SHALL reopen the most recently used board with its camera and settings; if no board exists it SHALL create an empty board named "Untitled board".

#### Scenario: First launch
- **WHEN** the app opens with no stored boards
- **THEN** an empty board "Untitled board" is created and opened

### Requirement: Board settings persisted
Snap to grid, Auto align, layout direction, minimap visibility, tag definitions and camera SHALL be stored per board.

#### Scenario: Per-board settings
- **WHEN** board "Work" has Vertical layout and board "Trip" has Horizontal
- **THEN** switching boards switches the layout setting accordingly

### Requirement: Multi-tab consistency
When the same board is changed in another open tab, the system SHALL reload the board in the inactive tab rather than overwriting the newer data.

#### Scenario: Two tabs
- **WHEN** board "Work" is edited in tab 1 while tab 2 shows "Work" without pending edits
- **THEN** tab 2 updates to the saved content from tab 1

### Requirement: Storage boundary for future API
All board and attachment reads and writes SHALL go through a single storage contract (list, load, save, delete boards; put, get, delete attachments) with asynchronous operations and revision numbers, so that a remote API implementation can replace on-device storage without changing editor behavior.

#### Scenario: Revision increments
- **WHEN** a board is saved twice
- **THEN** its stored revision number increases on each save

### Requirement: Schema versioning
Stored boards SHALL carry a schema version, and the system SHALL migrate older versions on load; boards with a newer unknown version SHALL NOT be overwritten.

#### Scenario: Newer version
- **WHEN** a stored board has a schema version newer than the app supports
- **THEN** the board opens read-only with a message and is not overwritten