# Spec Delta

## MODIFIED Requirements

### Requirement: Multiple boards
The system SHALL let the user create, rename, duplicate, delete (with confirmation) and switch between named boards from a board switcher, showing each board's name and last-modified time; the current board SHALL also be renameable directly without creating or switching to another board.

#### Scenario: Create and switch
- **WHEN** the user creates board "Trip" and then switches back to board "Work"
- **THEN** "Work" opens with its own content, camera and settings

#### Scenario: Delete requires confirmation
- **WHEN** the user chooses to delete board "Trip"
- **THEN** a confirmation dialog appears and the board is deleted only after confirming

#### Scenario: Rename current board
- **WHEN** the user renames the currently open board
- **THEN** its name changes in place and no new board is created