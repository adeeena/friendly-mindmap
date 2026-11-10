# Spec Delta

## MODIFIED Requirements

### Requirement: Reparent by drag
When Auto align is on, dragging a node SHALL show a drop indicator; dropping on another node SHALL move the node with its subtree to the indicated parent and position, while dropping on empty canvas SHALL move the node and subtree without changing the existing parent relation. Promotion to a root SHALL require an explicit action.

#### Scenario: Drop onto another node
- **WHEN** Auto align is on and the user drags "B2" onto node "A"
- **THEN** "B2" and its descendants become the last child subtree of "A"

#### Scenario: Drop on empty canvas
- **WHEN** Auto align is on and the user drags child "B2" to empty canvas
- **THEN** "B2" remains a child of its original parent, its hierarchy edge remains visible, and its position is manually offset from the automatic layout slot