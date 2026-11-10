# Spec Delta

## Purpose

Provides the infinite, zoomable drawing surface that hosts the mind map, and the responsive, themed application shell around it on desktop and touch devices.

## ADDED Requirements

### Requirement: Infinite canvas surface
The system SHALL present the board as a full-viewport surface with no fixed bounds, where content can be placed and viewed at any world coordinate.

#### Scenario: Content beyond the initial view
- **WHEN** the user pans far in any direction and creates a node there
- **THEN** the node is created at that world position and remains there after panning back and forth

#### Scenario: Background grid follows the camera
- **WHEN** the user pans or zooms
- **THEN** the background dot grid moves and scales consistently with the content

### Requirement: Panning
The system SHALL let the user pan the view with the Hand tool drag, middle-mouse drag, holding Space while dragging, trackpad two-finger scroll, and one-finger drag on empty canvas in Hand mode on touch devices.

#### Scenario: Space-drag pan in pointer mode
- **WHEN** the Pointer tool is active and the user holds Space and drags
- **THEN** the view pans and the Pointer tool is active again after Space is released

#### Scenario: Trackpad scroll pans
- **WHEN** the user scrolls with two fingers on a trackpad without a modifier
- **THEN** the view pans by the scroll delta and does not zoom

### Requirement: Zooming
The system SHALL zoom around the cursor or pinch center with Ctrl/Cmd+wheel, trackpad pinch, and two-finger touch pinch, clamped between 10% and 400%.

#### Scenario: Zoom keeps the focal point fixed
- **WHEN** the user zooms with the cursor over a node
- **THEN** that node stays under the cursor while the zoom level changes

#### Scenario: Zoom limits
- **WHEN** the user keeps zooming in past 400%
- **THEN** the zoom level stays at 400%

### Requirement: Zoom controls and fit to screen
The system SHALL provide zoom-in, zoom-out, reset-to-100% and fit-to-screen controls, with keyboard shortcuts Cmd/Ctrl+= , Cmd/Ctrl+-, Cmd/Ctrl+0 and Shift+1.

#### Scenario: Fit to screen
- **WHEN** the user presses Shift+1 on a board with content
- **THEN** the view zooms and pans so all visible nodes fit inside the viewport with margin

#### Scenario: Fit on empty board
- **WHEN** the user triggers fit to screen on an empty board
- **THEN** the view resets to 100% at the world origin

### Requirement: Minimap
The system SHALL show a toggleable minimap that renders an overview of all content and the current viewport rectangle, and lets the user click or drag on it to move the view.

#### Scenario: Navigate with minimap
- **WHEN** the user clicks a spot in the minimap
- **THEN** the main view centers on the corresponding world position

### Requirement: Crisp rendering
The system SHALL render node text sharply at rest at any zoom level and keep pan/zoom interactions smooth.

#### Scenario: Text sharp after zoom
- **WHEN** a zoom gesture ends at 250%
- **THEN** node text is rendered without blur at that zoom level

### Requirement: Responsive shell
The system SHALL adapt the toolbar and panels to the viewport: on narrow screens the toolbar compacts and side panels open as overlays, without horizontal page scrolling.

#### Scenario: Phone width
- **WHEN** the app is opened at 375px viewport width
- **THEN** all toolbar actions remain reachable and the page does not scroll horizontally

### Requirement: Touch editing
The system SHALL support full editing on touch devices, including tap to select, double-tap to edit, long-press to open a context menu, and drag to move.

#### Scenario: Long-press context menu
- **WHEN** the user long-presses a node on a touch device
- **THEN** a context menu with node actions opens near the node

### Requirement: Theme follows OS
The system SHALL render a light or dark theme matching the operating system preference and update when the preference changes, keeping WCAG AA contrast in both.

#### Scenario: OS switches to dark
- **WHEN** the OS color scheme changes from light to dark while the app is open
- **THEN** the app switches to the dark theme without reload

### Requirement: Accessible canvas
The system SHALL expose the mind map to assistive technology as a tree structure, announce structural edits via a live region, keep visible focus indicators, and pass automated AXE checks.

#### Scenario: Screen reader announcement
- **WHEN** the user creates a child node with Tab
- **THEN** a polite live-region announcement states that a child was added under the parent's text

#### Scenario: AXE check
- **WHEN** an automated AXE scan runs on a board with nodes, edges and open panels
- **THEN** no violations are reported
