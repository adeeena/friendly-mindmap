# editor-tools Specification

## Purpose

Defines the main toolbar, the active tool modes, editor toggles, global keyboard shortcuts, and the command palette that drive interaction with the canvas.

## Requirements

### Requirement: Main toolbar
The system SHALL show a toolbar with Pointer, Hand, New node (with shape choice: none, rectangle, rounded), New connection, toggles for Snap to grid and Auto align, a Layout direction selector (Horizontal, Vertical, Balanced), Undo/Redo, Save, Load, Export, and a board switcher.

#### Scenario: Active tool is indicated
- **WHEN** the user selects the Hand tool
- **THEN** the Hand button shows a pressed state with `aria-pressed="true"` and the other tool buttons are not pressed

#### Scenario: Toggle state is visible
- **WHEN** the user turns Snap to grid on
- **THEN** the Snap button shows a pressed state and the setting persists with the board

### Requirement: Tool modes
The system SHALL have exactly one active tool at a time: Pointer (select/move/edit), Hand (pan only), New node (click canvas to place a node of the chosen shape), and Connect (drag from one node to another to create a cross-link).

#### Scenario: New node tool places a node
- **WHEN** the New node tool with "rounded" shape is active and the user clicks empty canvas
- **THEN** a rounded root node is created at that position, enters text editing, and the tool returns to Pointer

#### Scenario: Hand tool does not select
- **WHEN** the Hand tool is active and the user drags over a node
- **THEN** the view pans and the selection does not change

### Requirement: Global hotkeys
The system SHALL support single-key tool shortcuts: P or V = Pointer, H = Hand, Space held = temporary Hand, N = New node, C = Connect, G = toggle Snap, A = toggle Auto align, L = cycle Layout direction, M = toggle minimap; plus Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y redo, Cmd/Ctrl+S save, Cmd/Ctrl+O load.

#### Scenario: P switches to pointer
- **WHEN** the Hand tool is active, no text is being edited, and the user presses P
- **THEN** the Pointer tool becomes active

#### Scenario: Shortcuts show in tooltips
- **WHEN** the user hovers or focuses a toolbar button
- **THEN** its tooltip shows the action name and its shortcut

### Requirement: Hotkeys suppressed while typing
The system SHALL NOT trigger single-key shortcuts while focus is in a text editor, input, or the command palette; modifier shortcuts that conflict with text editing (such as Cmd/Ctrl+Z) SHALL apply to the text editor instead.

#### Scenario: Typing P in a node
- **WHEN** the user is editing node text and types "P"
- **THEN** the letter is inserted and the active tool does not change

### Requirement: Command palette
The system SHALL open a searchable command palette with Cmd/Ctrl+K listing all toolbar actions, export options, board actions and tag filters, executable with keyboard only.

#### Scenario: Run a command by search
- **WHEN** the user presses Cmd/Ctrl+K, types "vert" and presses Enter
- **THEN** the layout direction becomes Vertical and the palette closes

#### Scenario: Escape closes palette
- **WHEN** the palette is open and the user presses Escape
- **THEN** the palette closes and focus returns to the previously focused element