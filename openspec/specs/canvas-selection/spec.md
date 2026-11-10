# canvas-selection Specification

## Purpose

Defines how users select nodes and edges on the canvas and move selected nodes freely, including grid snapping and smart alignment guides.

## Requirements

### Requirement: Click selection
In Pointer mode the system SHALL select a node or edge on click, clear the selection on click of empty canvas, and toggle an item in or out of the selection on Shift+click.

#### Scenario: Shift toggles
- **WHEN** node A is selected and the user Shift+clicks node B, then Shift+clicks node A
- **THEN** only node B is selected

### Requirement: Marquee selection by full enclosure
In Pointer mode, dragging on empty canvas SHALL draw a selection rectangle that selects only nodes whose entire bounding box lies inside it; Shift+drag adds the enclosed nodes to the existing selection.

#### Scenario: Partially covered node is not selected
- **WHEN** the user drags a marquee that fully contains node A and covers only half of node B
- **THEN** node A is selected and node B is not

#### Scenario: Touch marquee
- **WHEN** a touch user in Pointer mode drags with one finger starting on empty canvas
- **THEN** a marquee is drawn with the same full-enclosure rule

### Requirement: Select all and clear
The system SHALL select all visible nodes with Cmd/Ctrl+A and clear selection with Escape when not editing text.

#### Scenario: Escape clears
- **WHEN** three nodes are selected and the user presses Escape
- **THEN** nothing is selected

### Requirement: Selection feedback
The system SHALL indicate selected nodes and edges with a visible outline meeting WCAG AA non-text contrast, and show a contextual toolbar near a single or multi-node selection for shape, color, emoji, tags and checklist actions.

#### Scenario: Contextual toolbar
- **WHEN** the user selects two nodes
- **THEN** a contextual toolbar appears above the selection and changes made in it apply to both nodes

### Requirement: Moving nodes
The system SHALL move all selected nodes together when the user drags any selected node in Pointer mode with Auto align off, and with arrow keys plus Alt (1 grid step) or Alt+Shift (10 grid steps).

#### Scenario: Group drag
- **WHEN** nodes A and B are selected and the user drags A by 100px right
- **THEN** both A and B move 100px right in world units adjusted for zoom

### Requirement: Snap to grid
When Snap to grid is on, the system SHALL snap moved and newly placed node positions to an 8px world grid; holding Alt during a drag temporarily disables snapping.

#### Scenario: Snapped placement
- **WHEN** Snap is on and the user drops a node at world x=103
- **THEN** the node's x becomes 104

#### Scenario: Alt overrides snap
- **WHEN** Snap is on and the user drags with Alt held and drops at x=103
- **THEN** the node's x stays 103

### Requirement: Smart guides
When Snap to grid is on, the system SHALL show alignment guide lines and snap to them when a dragged node's edges or center come within 4 screen pixels of another visible node's edges or center.

#### Scenario: Center alignment guide
- **WHEN** the user drags node A so its vertical center is 3px from node B's vertical center
- **THEN** a guide line is shown and node A snaps to B's center