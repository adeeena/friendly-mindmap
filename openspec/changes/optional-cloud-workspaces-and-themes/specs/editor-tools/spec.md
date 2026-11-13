# Spec Delta

## MODIFIED Requirements

### Requirement: Main toolbar
The system SHALL show a toolbar with Pointer, Hand, New node (none, rectangle, rounded), New connection, Snap to grid, Auto align, Layout direction (Horizontal, Vertical, Balanced), Undo/Redo, Save, Load, Export, a board switcher and optional login/account actions. Save SHALL persist in the active workspace; file download SHALL remain under Export.

#### Scenario: Active tool is indicated
- **WHEN** the user selects the Hand tool
- **THEN** the Hand button shows a pressed state with `aria-pressed="true"` and the other tool buttons are not pressed

#### Scenario: Toggle state is visible
- **WHEN** the user turns Snap to grid on
- **THEN** the Snap button shows a pressed state and the setting persists with the board

#### Scenario: Account actions
- **WHEN** an authenticated user opens account actions
- **THEN** their display name and logout action are available without offering registration

### Requirement: Global hotkeys
The system SHALL support P or V = Pointer, H = Hand, Space held = temporary Hand, N = New node, C = Connect, G = toggle Snap, A = toggle Auto align, L = cycle Layout direction, M = toggle minimap; Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y redo, Cmd/Ctrl+S immediate workspace save/sync, and Cmd/Ctrl+O file load.

#### Scenario: P switches to pointer
- **WHEN** the Hand tool is active, no text is being edited, and the user presses P
- **THEN** the Pointer tool becomes active

#### Scenario: Shortcuts show in tooltips
- **WHEN** the user hovers or focuses a toolbar button
- **THEN** its tooltip shows the action name and its shortcut

#### Scenario: Save while editing text
- **WHEN** a user presses Ctrl/Cmd+S while editing node text or notes
- **THEN** the current text is included in immediate workspace persistence without opening browser Save Page or file export

## ADDED Requirements

### Requirement: Bottom-left view controls and anchored overlays
Minimap and tag/filter controls SHALL remain grouped at the bottom-left. Their tooltips and popovers SHALL anchor beside their triggering button, stay inside the viewport, and reposition on resize without detaching during canvas pan/zoom. Keyboard focus SHALL expose the same tooltips as hover.

#### Scenario: Hover and keyboard focus
- **WHEN** a user hovers or focuses either bottom-left view button
- **THEN** its tooltip appears adjacent to that button, not at an unrelated canvas position

#### Scenario: Narrow viewport
- **WHEN** a tag/filter popover is opened at 375px viewport width and the viewport resizes
- **THEN** the popover remains adjacent to its trigger, fully reachable within the viewport and does not create horizontal page scrolling

#### Scenario: Escape dismisses popover
- **WHEN** the user presses Escape inside a view-control popover
- **THEN** it closes and focus returns to its triggering control
