# Design

## Context

See [proposal.md](proposal.md) for motivation and the accepted product decisions. Existing board data stores hierarchy through `MindNode.parentId` and ordered `children`, while cross-links live separately in `BoardDoc.links`. Auto-align positions descendants from layout; node coordinates are currently used for roots and free placement. SVG hierarchy and cross-link paths are rendered separately, and the image exporter already supports an optional background color. Board preferences are persisted with each board; there is no app-wide preference service or localization layer.

## Goals / Non-Goals

**Goals:** Keep app-wide preferences independent from board documents; retain hierarchy and per-edge appearance through save/load; make direct board rename and its distinction from file operations clear; provide one translation source for all application-owned interface text; verify image pixels rather than only download initiation.

**Non-Goals:** Add a server or account-based preference sync, translate user-authored board content, redesign the board data model beyond the new optional presentation fields, or change the PNG export format/library.

## Decisions

### Keep manual layout offsets with the node

Add an optional world-space `layoutOffset` to each node. Auto-align continues to compute a base position from the tree; the offset is applied to that position and updated when a user drops the node on empty canvas. The drop does not call reparenting, and node-on-node drops retain the existing structural reparent/reorder path. Explicit promotion remains a separate structural action. This keeps the parent relation authoritative and avoids encoding presentation movement as a fake root or changing sibling order. Turning Auto align off uses the resulting positions as normal free placement; turning it on again follows the existing relayout behavior.

### Store edge appearance on its relation

Add optional appearance metadata to the child node for its incoming hierarchy edge and to each cross-link record for that cross-link. The child node is a stable key for its one incoming hierarchy relation; cross-links already have stable IDs. Resolve missing metadata to one neutral, solid, untapered, smooth-curve default with no arrowhead. Both relation types use the same pattern, color, and thickness renderer; explicit edge values override the shared defaults. The edge hit target remains separate from the visible stroke so selection and context-menu interaction stay usable at thin widths. A single shared preference per board was rejected because the requirement is to style individual edges.

### Keep app preferences outside board persistence

Introduce one app-level settings service backed by a namespaced local-storage record for theme (`system`, `light`, `dark`) and language (`en`, `fr`, `hu`). Initialize it before rendering the editor shell; system theme listens for OS changes only while `system` is selected. Board settings remain in `BoardDoc`. Use a typed translation dictionary with a shared key set and parameter interpolation; route all application-owned labels, tooltips, dialogs, toasts, errors, and accessible names through it, but leave user-authored board text untouched. This avoids adding a localization dependency or coupling app preferences to board switching.

Application identity comes from one metadata module: a configurable display-name value defaults to “Friendly Mindmap,” the version is imported from `web/package.json`, and the homepage is `https://adena.dev`. The settings popup reads this metadata (version in the side pane, author credit and homepage link in the footer) rather than duplicating branding strings.

### Share edge geometry and appearance rules

Keep the hierarchy and cross-link relation sources distinct, but render them through the same smooth curve and style resolution. Remove the current type-specific taper, dash, and arrow defaults. The selected edge is identified by its relation type and stable key; its context menu edits only that record and commits through the editor command/history path. Board serialization carries those optional values, while old records render with the shared default.

### Separate board actions from file actions

Expose rename for the active board next to its displayed name and keep create/switch/duplicate/delete in the board switcher. Save and Load remain clearly labeled file operations. Active-board rename calls the existing session rename behavior and must not enter the create-board flow.

### Verify rendered image pixels

Keep `renderImage` as the export boundary. With Background enabled, its background color fills the exported canvas. With Background disabled, only the canvas backdrop is transparent; included node and edge DOM remains in the render filter. Add a browser test that decodes the downloaded PNG and checks both visible map pixels and alpha behavior, for whole-board and selection export as appropriate. The current report was not reproduced during investigation, so the test should guard observable content rather than assume a specific cause.

## Risks / Trade-offs

- [Risk] Manual offsets may make an automatically arranged tree look less tidy after later edits. → Apply offsets to computed slots instead of replacing layout positions, preserve the offset through relayout, and let users reset it through an explicit action.
- [Risk] Optional style fields can be lost or rejected by older board readers. → Advance the stored-board schema through the existing migration hook, default absent edge styles and offsets during load, and test native import/export round trips.
- [Risk] A missing translation key can expose mixed-language UI. → Enforce key parity in unit tests and exercise the settings, board, edge, and export workflows in all three locales.
- [Risk] Transparent PNG tests can be brittle if they compare exact colors or antialiasing. → Assert alpha/transparency and a minimum count of non-background content pixels instead of exact pixel values.
- [Risk] Direct rename and the board switcher may expose duplicate or ambiguous controls. → Keep one primary inline rename affordance for the active board and retain the switcher for board lifecycle actions; test that rename never creates a board.

## Migration Plan

1. Advance the board schema and add a version-1-to-version-2 migration. Existing boards receive no manual offsets or edge overrides, so they keep their current node positions and render with the new shared edge default.
2. Keep theme and language in a separate namespaced local-storage record. Missing or invalid values fall back to System theme and English; no board migration is needed for these preferences.
3. Ensure native board import/export preserves the new optional offset and edge appearance fields, and cover both migrated legacy boards and new-board round trips.
4. Rollback requires no data rewrite. An older app may treat schema-2 boards as newer and read-only; export a native backup before downgrading, consistent with the existing newer-schema behavior.
