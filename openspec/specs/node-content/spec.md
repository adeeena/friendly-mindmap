# node-content Specification

## Purpose

Defines what a node looks like and contains: shapes, colors, emoji, tags with filtering, property inheritance through branches, rich text, notes, attachments and checklists.

## Requirements

### Requirement: Node shapes
Each node SHALL have one of three shapes: "none" (text only, no background, no border, no padding), "rectangle", or "rounded" (rectangle with rounded corners).

#### Scenario: Change shape
- **WHEN** the user selects a rectangle node and chooses "none" in the contextual toolbar
- **THEN** the node renders as plain text without background, border or padding

### Requirement: Node colors
The system SHALL let the user set a node's color from a fixed palette whose every entry meets WCAG AA text contrast in both light and dark themes; color applies to fill or border and to the node's incoming hierarchy edge.

#### Scenario: Pick a color
- **WHEN** the user picks "green" for node "A"
- **THEN** "A" and the edge from its parent render in the palette's green for the current theme

### Requirement: Emoji and icon
The system SHALL let the user attach one emoji or icon to a node, shown before its text.

#### Scenario: Add emoji
- **WHEN** the user chooses the emoji "🛒" for node "Groceries"
- **THEN** the node shows "🛒" before its text

### Requirement: Tags
The system SHALL let users create named, colored tags per board, assign multiple tags to a node, and show them as chips on the node.

#### Scenario: Assign tag
- **WHEN** the user assigns tag "work" to node "A"
- **THEN** "A" shows a "work" chip in the tag's color

### Requirement: Tag filtering
The system SHALL let the user filter by one or more tags so matching nodes stay emphasized and non-matching nodes are dimmed but keep their positions; clearing the filter restores normal rendering.

#### Scenario: Filter by tag
- **WHEN** the user filters by tag "work"
- **THEN** nodes having "work" (including inherited) are emphasized and all others are dimmed

### Requirement: Property inheritance
Color, shape, tags and emoji SHALL cascade from a node to its descendants unless a descendant sets its own value; the UI SHALL distinguish inherited from overridden values and allow resetting an override.

#### Scenario: Inherited color
- **WHEN** node "A" has color blue and child "A1" has no color set
- **THEN** "A1" renders blue

#### Scenario: Override and reset
- **WHEN** child "A1" sets color red and then the user chooses "Reset to inherited"
- **THEN** "A1" renders red after the override and blue again after the reset

#### Scenario: Reparent changes inheritance
- **WHEN** a node without its own color is moved under a parent with color green
- **THEN** it renders green

### Requirement: Rich text
Node text SHALL support multiple lines, bold, italic, and hyperlinks, with Cmd/Ctrl+B, Cmd/Ctrl+I and Cmd/Ctrl+K (while editing) shortcuts; links open in a new tab with safe link attributes, and only http, https and mailto links are allowed.

#### Scenario: Bold text
- **WHEN** the user selects a word while editing and presses Cmd/Ctrl+B
- **THEN** the word is rendered bold and stays bold after save and reload

#### Scenario: Unsafe link rejected
- **WHEN** the user tries to add a link with a "javascript:" URL
- **THEN** the link is not created

### Requirement: Node auto-sizing
Nodes SHALL size to fit their content up to a maximum width of 320px, wrapping text beyond it.

#### Scenario: Long text wraps
- **WHEN** the user types a sentence wider than 320px
- **THEN** the node width stops at 320px and the text wraps onto more lines

### Requirement: Notes panel
The system SHALL let users attach a rich-text note to a node, edited in a side panel for the selected node; nodes with notes show a note indicator.

#### Scenario: Open notes
- **WHEN** the user selects node "A" and opens the notes panel
- **THEN** the panel shows and edits "A"'s note, and "A" shows a note indicator once the note is non-empty

### Requirement: Attachments
The system SHALL let users attach files of any type to a node, up to 10 MB per file, stored locally with the board; nodes show an attachment count, and the notes panel lists attachments for opening, downloading, and removing.

#### Scenario: Attach a file
- **WHEN** the user drops a 2 MB PDF onto node "A"
- **THEN** the file is attached to "A" and listed in the panel

#### Scenario: Too large
- **WHEN** the user attaches a 12 MB file
- **THEN** the attachment is refused with a message stating the 10 MB limit

#### Scenario: Image preview
- **WHEN** the attached file is an image
- **THEN** the panel shows a thumbnail preview

### Requirement: Checklist node
The system SHALL provide a checklist node type containing an ordered list of checkable items edited inline, where Enter adds an item, Backspace on an empty item removes it, and the node shows progress (checked/total).

#### Scenario: Shopping list
- **WHEN** the user creates a checklist node and types "milk", Enter, "eggs" and checks "milk"
- **THEN** the node shows two items, "milk" checked, and progress "1/2"

### Requirement: Todo children
The system SHALL let the user mark any node as a todo list so each direct child shows a checkbox and the node shows progress of checked children.

#### Scenario: Toggle todo mode
- **WHEN** the user enables "todo" on node "Trip" with 3 children and checks one child
- **THEN** each child shows a checkbox and "Trip" shows "1/3"