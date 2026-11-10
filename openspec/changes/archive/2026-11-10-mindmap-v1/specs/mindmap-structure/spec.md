# Spec Delta

## Purpose

Defines the mind-map structure as a forest of trees and the keyboard-first operations for creating, navigating, restructuring, collapsing, deleting and copying nodes.

## ADDED Requirements

### Requirement: Forest model
A board SHALL hold any number of root nodes; every non-root node SHALL have exactly one parent, sibling order SHALL be preserved, and the parent relation SHALL never form a cycle.

#### Scenario: Multiple roots
- **WHEN** the user places two nodes with the New node tool on empty canvas
- **THEN** the board contains two independent root trees

#### Scenario: Cycle prevented
- **WHEN** the user tries to reparent a node onto one of its own descendants
- **THEN** the operation is rejected and the structure is unchanged

### Requirement: Tab creates child
While a node is selected or being edited, pressing Tab SHALL create a new last child of that node, connected by a hierarchy edge, and start editing the new node.

#### Scenario: Tab while editing
- **WHEN** the user is editing node "Ideas" and presses Tab
- **THEN** a new child of "Ideas" is created, connected to it, and receives text editing focus

### Requirement: Enter creates sibling
While a non-root node is selected or being edited, pressing Enter SHALL create a new sibling directly after it under the same parent and start editing it; Shift+Enter SHALL insert a line break while editing.

#### Scenario: Enter on child
- **WHEN** the user is editing child "A1" of "A" and presses Enter
- **THEN** a new node is created under "A" directly after "A1" and receives editing focus

#### Scenario: Enter on a root
- **WHEN** the user is editing a root node and presses Enter
- **THEN** a new root node is created next to it and receives editing focus

#### Scenario: Line break
- **WHEN** the user is editing a node and presses Shift+Enter
- **THEN** a line break is inserted in the text and no node is created

### Requirement: Promote and reorder
Shift+Tab SHALL move the selected node to become the next sibling of its parent (a node with no grandparent becomes a root); Cmd/Ctrl+Up and Cmd/Ctrl+Down SHALL reorder it among siblings.

#### Scenario: Promote
- **WHEN** node "A1x" (child of "A1", child of "A") is selected and the user presses Shift+Tab
- **THEN** "A1x" becomes a child of "A" placed directly after "A1"

### Requirement: Structural keyboard navigation
When a node is selected and no text is being edited, arrow keys SHALL move selection along the tree relative to the layout direction: toward parent, toward first child, and to previous/next sibling.

#### Scenario: Navigate to child in horizontal layout
- **WHEN** layout is Horizontal, node "A" with children is selected, and the user presses Right
- **THEN** the first child of "A" becomes selected

### Requirement: Enter and exit editing
F2, double-click, double-tap, or typing a printable character on a selected node SHALL start editing (typing replaces the text); Escape or clicking outside SHALL end editing and keep the node selected.

#### Scenario: Type to replace
- **WHEN** node "Old" is selected and the user types "N"
- **THEN** the node enters editing with text "N"

#### Scenario: Escape returns focus
- **WHEN** the user is editing and presses Escape
- **THEN** editing ends, the node remains selected, and Tab key focus navigation is no longer captured by the editor

### Requirement: Hover add handles
In Pointer mode, hovering or selecting a node SHALL reveal "+" handles on its sides; activating a handle in the child direction creates a child, and in the sibling direction creates a sibling.

#### Scenario: Click right handle
- **WHEN** layout is Horizontal and the user clicks the right "+" handle of node "A"
- **THEN** a new child of "A" is created and enters editing

### Requirement: Reparent by drag
When Auto align is on, dragging a node SHALL show a drop indicator and, on drop, move the node with its subtree to the indicated parent and position; dropping on empty canvas makes it a root.

#### Scenario: Drop onto another node
- **WHEN** Auto align is on and the user drags "B2" onto node "A"
- **THEN** "B2" and its descendants become the last child subtree of "A"

### Requirement: Collapse and expand
The system SHALL let the user collapse or expand a node's descendants via a toggle on the node or the shortcut Cmd/Ctrl+Period; collapsed nodes show a descendant count badge and hidden nodes are excluded from layout and selection.

#### Scenario: Collapse hides subtree
- **WHEN** the user collapses node "A" with 5 descendants
- **THEN** the descendants and their edges are hidden and "A" shows a badge "5"

### Requirement: Delete
Delete or Backspace (when not editing) SHALL remove the selected nodes with all their descendants and any cross-links attached to removed nodes, then select the parent or nearest sibling.

#### Scenario: Delete subtree
- **WHEN** node "A" with 3 descendants is selected and the user presses Delete
- **THEN** "A" and its 3 descendants are removed and "A"'s parent becomes selected

### Requirement: Clipboard and duplicate
Cmd/Ctrl+C, X and V SHALL copy, cut and paste selected subtrees (with styles, content and internal cross-links); pasting with a node selected adds them as its children, otherwise as roots near the cursor. Cmd/Ctrl+D SHALL duplicate selected subtrees as next siblings.

#### Scenario: Paste as children
- **WHEN** the user copies subtree "A" and pastes with node "B" selected
- **THEN** a copy of "A" with new ids becomes the last child of "B"

#### Scenario: Paste plain text
- **WHEN** the system clipboard contains indented plain-text lines and the user pastes on a selected node
- **THEN** each line becomes a node and indentation determines the nesting under the selected node
