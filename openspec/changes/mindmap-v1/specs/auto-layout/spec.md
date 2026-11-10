# Spec Delta

## Purpose

Defines automatic arrangement of mind-map trees in the chosen direction and how the Auto align toggle switches between structured layout and free placement with collision avoidance.

## ADDED Requirements

### Requirement: Layout directions
The system SHALL arrange each tree by the board's layout direction: Horizontal (children to the right of parents), Vertical (children below parents), or Balanced (root's children split evenly left and right, descendants continuing outward).

#### Scenario: Vertical layout
- **WHEN** Auto align is on and the user selects Vertical
- **THEN** every tree is rearranged with children below their parent and siblings side by side

#### Scenario: Balanced layout
- **WHEN** a root has 4 children and the layout is Balanced
- **THEN** 2 children are placed to the right and 2 to the left of the root

### Requirement: Variable-size tidy layout
Laid-out trees SHALL respect each node's actual size so that no two visible nodes overlap, siblings keep their order, and spacing between levels and siblings is consistent.

#### Scenario: Large node does not overlap
- **WHEN** one child has a much taller content than its siblings
- **THEN** siblings are spaced so none overlaps it

### Requirement: Auto align on
While Auto align is on, the layout engine SHALL own node positions within trees: structural edits, content size changes, collapse/expand and direction changes re-run layout, and dragging a node reparents or reorders it instead of placing it freely.

#### Scenario: Tab relayouts
- **WHEN** Auto align is on and the user adds a child with Tab
- **THEN** the tree is re-laid out and the new child appears in its computed slot without overlap

#### Scenario: Roots keep their positions
- **WHEN** Auto align is on and a tree is re-laid out
- **THEN** its root node keeps its position and only descendants move

### Requirement: Trees do not overlap each other
While Auto align is on, when a re-laid-out tree's bounds would overlap another tree, the system SHALL shift the other tree's root just enough to remove the overlap.

#### Scenario: Growing tree pushes neighbor
- **WHEN** tree A grows into tree B's area
- **THEN** tree B moves away by the minimal distance so they no longer overlap

### Requirement: Auto align off
While Auto align is off, the system SHALL keep user-chosen positions, place newly created nodes in a free slot next to their parent or sibling in the layout direction, and nudge a dropped node minimally if it would overlap another node.

#### Scenario: New child avoids collision
- **WHEN** Auto align is off and the space right of node "A" is occupied
- **THEN** a new child created with Tab is placed at the nearest free position in that direction

#### Scenario: Turning auto align on
- **WHEN** the user turns Auto align on with manually positioned nodes
- **THEN** all trees are re-laid out by the current direction, as a single undoable step

### Requirement: Animated transitions
Layout-driven position changes SHALL animate smoothly over about 150ms, and SHALL apply instantly when the user prefers reduced motion.

#### Scenario: Reduced motion
- **WHEN** the OS has reduced motion enabled and a relayout happens
- **THEN** nodes move to their new positions without animation
