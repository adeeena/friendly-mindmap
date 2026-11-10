# Spec Delta

## MODIFIED Requirements

### Requirement: Main toolbar
The system SHALL show a toolbar with Pointer, Hand, New node (with shape choice: none, rectangle, rounded), New connection, toggles for Snap to grid and Auto align, a Layout direction selector (Horizontal, Vertical, Balanced), Undo/Redo, Save, Load, Export, a board switcher, a Settings action, and a direct rename action for the current board.

#### Scenario: Active tool is indicated
- **WHEN** the user selects the Hand tool
- **THEN** the Hand button shows a pressed state with `aria-pressed="true"` and the other tool buttons are not pressed

#### Scenario: Toggle state is visible
- **WHEN** the user turns Snap to grid on
- **THEN** the Snap button shows a pressed state and the setting persists with the board

#### Scenario: Rename current board from the toolbar
- **WHEN** the user activates the current board's rename action
- **THEN** the board name can be changed without creating or switching to another board