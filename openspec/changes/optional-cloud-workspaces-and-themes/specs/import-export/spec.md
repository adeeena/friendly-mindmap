# Spec Delta

## MODIFIED Requirements

### Requirement: Native save
The explicit Export file action SHALL download the current board as a versioned JSON file (`.bmm.json`) containing all nodes, structure, cross-links, content, styles, tags, settings and camera; the user SHALL choose whether to embed attachments (single bundled `.bmm.zip`) or omit them. Ctrl/Cmd+S SHALL persist the board rather than download a file. Export SHALL remain available without login.

#### Scenario: Save without attachments
- **WHEN** the user exports board "Work" without embedding attachments
- **THEN** a file "Work.bmm.json" is downloaded with attachment metadata but no file data

#### Scenario: Save with attachments
- **WHEN** the user exports with attachments embedded
- **THEN** a "Work.bmm.zip" containing the JSON and all available attachment files is downloaded

#### Scenario: Missing attachment bytes
- **WHEN** a bundled export references bytes unavailable offline
- **THEN** export reports the missing files instead of claiming a complete lossless bundle was saved

### Requirement: Native load
The Load action SHALL accept `.bmm.json` and `.bmm.zip` files and open them as a new board in the active workspace, validating structure and destination attachment policy before publishing the board. Invalid or over-limit imports SHALL leave existing boards unchanged and SHALL NOT publish partial boards. File import SHALL remain available without login.

#### Scenario: Round trip
- **WHEN** the user exports a board and loads the file within the destination's policy limits
- **THEN** a new board opens that is identical in content, structure, styles and layout to the original

#### Scenario: Invalid file
- **WHEN** the user loads a file that is not a valid board or exceeds supported limits
- **THEN** an error message is shown and no board is created

#### Scenario: Untrusted content sanitized
- **WHEN** a loaded file contains script tags, event handler attributes or "javascript:" links in rich text
- **THEN** they are removed before rendering

#### Scenario: Basic attachment policy
- **WHEN** a basic user imports a bundle containing two files on one node or a file above 5 MiB
- **THEN** the import fails with a policy explanation without publishing the board or silently omitting files

#### Scenario: Offline authenticated import
- **WHEN** an authenticated user imports a valid bundle while offline
- **THEN** the new board and files are durably queued in that account's workspace and automatically synchronize after reconnection
