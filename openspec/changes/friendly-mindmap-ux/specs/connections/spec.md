# Spec Delta

## MODIFIED Requirements

### Requirement: Curved hierarchy edges
The system SHALL draw every parent-child relation as a smooth, solid, untapered curved line from the parent's side facing the child to the child's side facing the parent, using the same default appearance as cross-links.

#### Scenario: Horizontal layout edge
- **WHEN** child "A1" is to the right of parent "A"
- **THEN** the edge leaves the right side of "A" and enters the left side of "A1" in a smooth S-curve

#### Scenario: Edges follow moves
- **WHEN** the user drags node "A1"
- **THEN** its edges update continuously during the drag

### Requirement: Cross-links
With the Connect tool the user SHALL drag from one node to another to create a cross-link that does not affect the tree structure or layout; cross-links SHALL use the same smooth, solid, untapered curved default appearance as hierarchy edges.

#### Scenario: Create cross-link
- **WHEN** the Connect tool is active and the user drags from node "A" and releases over node "D"
- **THEN** a solid curved line from "A" to "D" is created and the parent of "D" is unchanged

#### Scenario: Release on empty canvas
- **WHEN** the user releases the drag over empty canvas
- **THEN** no cross-link is created

#### Scenario: Self-link and duplicate
- **WHEN** the user drags from "A" back onto "A", or onto "D" when an A-to-D link already exists
- **THEN** no new cross-link is created

## ADDED Requirements

### Requirement: Per-edge appearance controls
The system SHALL let users select any hierarchy edge or cross-link and change its line pattern, color, and thickness from a context menu; each edge's chosen appearance SHALL persist with its board.

#### Scenario: Change a hierarchy edge
- **WHEN** the user opens a hierarchy edge's context menu and changes its color and thickness
- **THEN** only that edge uses the selected color and thickness

#### Scenario: Change a cross-link pattern
- **WHEN** the user opens a cross-link's context menu and changes its pattern to dashed
- **THEN** that cross-link renders dashed after the change and keeps that style after the board is reopened