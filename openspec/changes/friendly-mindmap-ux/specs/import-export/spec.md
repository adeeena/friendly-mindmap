# Spec Delta

## MODIFIED Requirements

### Requirement: Image export
The system SHALL export the whole board or the current selection as PNG (at 1x or 2x) or SVG, with the current theme or a forced light theme, and with or without background; every included node and edge SHALL remain visibly rendered regardless of the background option.

#### Scenario: Export selection as PNG
- **WHEN** the user selects a subtree and exports PNG at 2x
- **THEN** a PNG containing only the selected nodes and edges between them at double resolution is downloaded

#### Scenario: Transparent background retains content
- **WHEN** the user exports a board image with Background disabled
- **THEN** the area behind the map is transparent and the included nodes and edges remain visible