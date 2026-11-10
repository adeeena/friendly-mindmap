# Spec Delta

## Purpose

Lets users safely reverse and reapply changes to a board, so experimentation and autosave never cause permanent loss.

## ADDED Requirements

### Requirement: Undo and redo
The system SHALL let the user undo and redo every document mutation (structure, positions, content, styles, tags, links, attachments, board settings) via toolbar buttons and shortcuts, keeping at least the last 200 steps per board for the session.

#### Scenario: Undo delete
- **WHEN** the user deletes a subtree and presses Cmd/Ctrl+Z
- **THEN** the subtree is restored with its content, styles, positions and cross-links

#### Scenario: New edit clears redo
- **WHEN** the user undoes a step and then makes a new edit
- **THEN** redo is no longer available

### Requirement: Grouped steps
A continuous gesture or compound action (a drag, a typing session in one node, a relayout triggered by a toggle, a paste) SHALL be recorded as a single undo step.

#### Scenario: Drag is one step
- **WHEN** the user drags three selected nodes and then presses undo once
- **THEN** all three return to their pre-drag positions

### Requirement: View state not in history
Camera position, zoom, selection, active tool and tag filters SHALL NOT create undo steps.

#### Scenario: Undo ignores panning
- **WHEN** the user edits a node, then pans, then presses undo
- **THEN** the node edit is undone and the view stays where it was panned

### Requirement: Undo availability indicator
Undo and Redo controls SHALL be disabled when there is nothing to undo or redo.

#### Scenario: Fresh board
- **WHEN** a new empty board is opened
- **THEN** both Undo and Redo are disabled
