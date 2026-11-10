# Spec Delta

## MODIFIED Requirements

### Requirement: Auto align on
While Auto align is on, the layout engine SHALL compute node positions from tree structure and apply any user-set position offsets; structural edits, content size changes, collapse/expand and direction changes SHALL re-run layout, and dragging onto another node SHALL reparent or reorder while dropping on empty canvas SHALL set an offset without changing parentage.

#### Scenario: Tab relayouts
- **WHEN** Auto align is on and the user adds a child with Tab
- **THEN** the tree is re-laid out and the new child appears in its computed slot without overlap

#### Scenario: Roots keep their positions
- **WHEN** Auto align is on and a tree is re-laid out
- **THEN** its root node keeps its position and only descendants move

#### Scenario: Dragged child keeps its offset
- **WHEN** the user drags a child to empty canvas while Auto align is on
- **THEN** the child remains connected to its parent and its manual offset is applied to its computed layout position