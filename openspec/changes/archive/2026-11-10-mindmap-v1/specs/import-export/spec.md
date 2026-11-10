# Spec Delta

## Purpose

Defines how boards leave and enter the app as files: lossless native save/load, lossy Mermaid and image exports, and checklist exports for quick sharing.

## ADDED Requirements

### Requirement: Native save
The Save action SHALL download the current board as a versioned JSON file (`.bmm.json`) containing all nodes, structure, cross-links, content, styles, tags, settings and camera; the user SHALL choose whether to embed attachments (single bundled `.bmm.zip`) or omit them.

#### Scenario: Save without attachments
- **WHEN** the user saves board "Work" without embedding attachments
- **THEN** a file "Work.bmm.json" is downloaded with attachment metadata but no file data

#### Scenario: Save with attachments
- **WHEN** the user saves with attachments embedded
- **THEN** a "Work.bmm.zip" containing the JSON and all attachment files is downloaded

### Requirement: Native load
The Load action SHALL accept `.bmm.json` and `.bmm.zip` files and open them as a new board, validating structure and rejecting invalid files without changing existing boards.

#### Scenario: Round trip
- **WHEN** the user saves a board and loads the file
- **THEN** a new board opens that is identical in content, structure, styles and layout to the original

#### Scenario: Invalid file
- **WHEN** the user loads a file that is not a valid board or exceeds supported limits
- **THEN** an error message is shown and no board is created

#### Scenario: Untrusted content sanitized
- **WHEN** a loaded file contains script tags, event handler attributes or "javascript:" links in rich text
- **THEN** they are removed before rendering

### Requirement: Mermaid export
The system SHALL export the board as Mermaid `mindmap` text, one diagram per root tree, preserving hierarchy, plain text and node shape where expressible, after warning that positions, cross-links, styles, notes and attachments are not included.

#### Scenario: Export tree
- **WHEN** the user exports a board with root "Plan" and children "A" and "B" to Mermaid
- **THEN** the output is a valid Mermaid mindmap with "Plan" as root and "A" and "B" as its children

#### Scenario: Copy or download
- **WHEN** the Mermaid export dialog is shown
- **THEN** the user can copy the text to the clipboard or download it as a `.mmd` file

### Requirement: Image export
The system SHALL export the whole board or the current selection as PNG (at 1x or 2x) or SVG, with the current theme or a forced light theme, and with or without background.

#### Scenario: Export selection as PNG
- **WHEN** the user selects a subtree and exports PNG at 2x
- **THEN** a PNG containing only the selected nodes and edges between them at double resolution is downloaded

### Requirement: Checklist export
For a checklist node or a todo node the system SHALL export its items as a Markdown task list (`- [ ]` / `- [x]`), as plain text, via the native share sheet where supported, or as a print-friendly view.

#### Scenario: Markdown copy
- **WHEN** the user exports checklist "Groceries" with "milk" checked and "eggs" unchecked as Markdown
- **THEN** the clipboard contains "- [x] milk" and "- [ ] eggs" lines under a "Groceries" heading

#### Scenario: Share unsupported
- **WHEN** the browser does not support native sharing
- **THEN** the share option is hidden and the other options remain available
