# Proposal

## Why

The editor's current behavior makes a routine child-node drag silently detach it, while its two connection types look different and cannot be styled per edge. Board management and export also leave avoidable ambiguity: renaming is buried in the Boards dialog, and PNG export has no content-level verification. A small, coherent UX change should make these core actions predictable and add discoverable, app-wide settings under configurable Friendly Mindmap branding.

## What Changes

- Keep a dragged child connected to its parent when dropped on empty canvas, allowing a manual position while Auto align is enabled; retain drop-on-node reparenting and provide an explicit way to promote a node to a root.
- Give hierarchy edges and cross-links a shared smooth, solid, untapered default, with per-edge style, color, and thickness controls from the line context menu.
- Make the current board easy to rename in place and distinguish board rename/switch/create actions from Save to file and Load from file.
- Strengthen PNG export verification to ensure the selected nodes and edges render; transparency applies to the background only when requested.
- Add a settings popup for theme, language and app version, with a "Made by" footer linking to `https://adena.dev`. Default branding is "Friendly Mindmap" and is held in changeable app metadata; the version comes from package metadata.
- Support English, French, and Hungarian throughout the UI. Keep theme and language preferences app-wide and persistent, separate from per-board settings.

## Capabilities

### New Capabilities

- `app-settings`: App-wide theme and language preferences, configurable application metadata, and the settings popup.

### Modified Capabilities

- `connections`: Shared edge defaults and per-edge style, color, and thickness controls.
- `mindmap-structure`: Preserve parentage when a child is moved to empty canvas; make root promotion explicit.
- `auto-layout`: Allow a manually positioned child offset while Auto align remains enabled.
- `canvas-viewport`: Let the user-selected theme override the system theme while preserving a system-following option.
- `editor-tools`: Add settings access and improve discoverability of current-board renaming.
- `board-persistence`: Make the current board's rename action direct and distinguish it from creating a board.
- `import-export`: Verify that PNG output contains rendered content and only makes the background transparent when disabled.

## Impact

The existing capabilities above were defined in the completed `mindmap-v1` change and have now been promoted into `openspec/specs/`; this change extends those capability paths. Expected implementation areas are `web/src/app/core/model.ts`, `web/src/app/editor/interaction.ts`, `web/src/app/editor/editor-store.ts`, `web/src/app/ui/edge-layer.ts`, `web/src/app/ui/editor-shell.ts`, `web/src/app/ui/toolbar.ts`, `web/src/app/ui/board-dialogs.ts`, `web/src/app/io/image-export.ts`, and application metadata/i18n code. No server API is introduced.