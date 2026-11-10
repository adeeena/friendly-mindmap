# Tasks

## 1. Board Data and Migration

- [x] 1.1 Add optional node layout offsets and hierarchy/cross-link appearance fields, advance the board schema, and migrate version-1 boards; verify legacy-load and migration unit tests pass.
- [x] 1.2 Preserve offsets and edge appearance through board validation and native save/load; verify version-2 round-trip tests and existing version-1 fixtures pass.

## 2. Auto-Align Drag Behavior

- [x] 2.1 Apply node offsets to computed auto-layout positions and record empty-canvas drag offsets without reparenting; verify store and interaction tests cover retained parentage, edge visibility, relayout, undo, and explicit root promotion.

## 3. Edge Appearance

- [x] 3.1 Render hierarchy edges and cross-links with the shared smooth, solid, untapered default and resolve per-edge pattern, color, and thickness; verify geometry and rendering tests cover both relation types and legacy defaults.
- [x] 3.2 Add edge selection context controls that update only the selected relation through editor history; verify unit tests cover each appearance control, undo/redo, and persistence after board reopen.

## 4. App Settings and Localization

- [x] 4.1 Add app-wide persisted theme/language preferences and configurable application metadata with version sourced from package metadata; verify service tests cover defaults, reload persistence, and OS theme changes in System mode.
- [x] 4.2 Add the accessible Settings popup and complete English, French, and Hungarian translations for application-owned text; verify dictionary-key parity tests and settings-dialog tests pass in all three languages.

## 5. Board Management

- [x] 5.1 Add a direct active-board rename action and keep board lifecycle controls distinct from file Save/Load; verify UI tests confirm rename changes the current board without creating or switching boards.

## 6. Image Export

- [x] 6.1 Ensure the background option affects only the exported backdrop and add pixel-level PNG tests for whole-board and selection exports; verify decoded images contain visible map content with background enabled and disabled, with transparency only outside content when disabled.

## 7. Integration Verification

- [x] 7.1 Exercise the combined settings, locale switching, edge styling, connected-child drag, board rename, and PNG export workflows in Playwright; verify all relevant e2e tests and the Angular production build pass.
- [x] 7.2 Run the accessibility scan on the Settings popup and edge context menu in each supported locale; verify no AXE violations and that keyboard focus remains operable.