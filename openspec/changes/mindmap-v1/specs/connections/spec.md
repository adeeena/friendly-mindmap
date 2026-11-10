# Spec Delta

## Purpose

Defines how relationships between nodes are drawn and managed: curved hierarchy edges from the tree structure and user-created cross-links between any two nodes.

## ADDED Requirements

### Requirement: Curved hierarchy edges
The system SHALL draw every parent-child relation as a smooth curved line from the parent's side facing the child to the child's side facing the parent, tapering from thicker near the parent to thinner near the child.

#### Scenario: Horizontal layout edge
- **WHEN** child "A1" is to the right of parent "A"
- **THEN** the edge leaves the right side of "A" and enters the left side of "A1" in a smooth S-curve

#### Scenario: Edges follow moves
- **WHEN** the user drags node "A1"
- **THEN** its edges update continuously during the drag

### Requirement: Cross-links
With the Connect tool the user SHALL drag from one node to another to create a cross-link that does not affect the tree structure or layout; cross-links render dashed, curved, with an arrowhead at the target.

#### Scenario: Create cross-link
- **WHEN** the Connect tool is active and the user drags from node "A" and releases over node "D"
- **THEN** a dashed curved arrow from "A" to "D" is created and the parent of "D" is unchanged

#### Scenario: Release on empty canvas
- **WHEN** the user releases the drag over empty canvas
- **THEN** no cross-link is created

#### Scenario: Self-link and duplicate
- **WHEN** the user drags from "A" back onto "A", or onto "D" when an A-to-D link already exists
- **THEN** no new cross-link is created

### Requirement: Edge selection and deletion
Hierarchy edges and cross-links SHALL be selectable by click or tap with a hit area of at least 12 screen pixels; deleting a cross-link removes it, and deleting a hierarchy edge detaches the child subtree as a new root at its current position.

#### Scenario: Delete cross-link
- **WHEN** the user selects a cross-link and presses Delete
- **THEN** the cross-link is removed and nodes are unchanged

#### Scenario: Delete hierarchy edge
- **WHEN** the user selects the edge between "A" and "A1" and presses Delete
- **THEN** "A1" with its subtree becomes a root at its current position

### Requirement: Collapsed endpoints
Cross-links whose endpoint is hidden by a collapsed ancestor SHALL attach to the nearest visible ancestor.

#### Scenario: Link into collapsed branch
- **WHEN** node "D" with an incoming cross-link is hidden because its parent is collapsed
- **THEN** the cross-link is drawn to the collapsed parent
