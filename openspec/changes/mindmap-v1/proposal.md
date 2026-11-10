# Proposal

## Why

`web/better-mindmap` is an empty Angular 21 scaffold. We want a crisp, versatile, keyboard-first mind-mapping app that combines the infinite-canvas freedom of whiteboards (Miro, tldraw, Excalidraw) with the structured, fast editing of dedicated mind-map tools (XMind, MindNode, Whimsical), works on desktop and touch devices, and is ready to be backed by a web API later.

## What Changes

- Replace the Angular welcome page with a full-screen mind-map editor.
- Infinite canvas with pan/zoom (mouse, trackpad, touch pinch), zoom controls, fit-to-screen, and a minimap.
- Main toolbar: Pointer, Hand, New node, New connection, and toggles for Snap to grid, Auto align, Layout direction (Horizontal / Vertical / Balanced), plus Save, Load, Export, and board switcher.
- Global hotkeys (P/V pointer, H hand, Space held = temporary hand, etc.) that are suppressed while editing text, and a Cmd/Ctrl+K command palette.
- CorelDraw-style selection: marquee selects only fully enclosed items; Shift toggles; drag to move with grid snap and smart guides (Alt overrides).
- Mind-map model is a **forest**: many root trees, each node has at most one parent, plus free cross-links. Keyboard editing: Tab = child, Enter = sibling, Shift+Tab = promote, arrows = tree navigation, F2/typing = edit, Esc = exit, Delete = remove subtree. Collapse/expand branches, copy/paste/duplicate subtrees, "+" hover handles.
- Node shapes: none (no background, no padding), rectangle, rounded rectangle. Fill/border color from a palette, emoji/icon, named filterable tags; color, shape, tags and emoji cascade to descendants unless overridden.
- Node content: multi-line rich text (bold/italic/links), notes in a side panel, file attachments (stored locally, size-capped), checklists (dedicated checklist node and a "todo" toggle that makes a node's children checkable).
- Curved, flowing bezier edges for hierarchy; dashed cross-links with arrowheads; edges are selectable and deletable.
- Auto align ON: layout engine owns positions (tidy tree, collision-free), dragging reparents/reorders. Auto align OFF: free placement, new/moved nodes are nudged to avoid overlap.
- Undo/redo for all document mutations.
- Multiple named boards with a switcher, autosaved/autoloaded to IndexedDB behind a storage repository abstraction so an HTTP API can replace it later.
- Save/Load as versioned native JSON; export to Mermaid mindmap (lossy), PNG and SVG; export checklists as Markdown task list, plain text, native share, or print view.
- Light/dark theme following the OS; responsive layout; full touch editing; WCAG AA / AXE compliance.
- Unit tests with Jest (replacing the scaffolded Vitest setup) and end-to-end tests with Playwright.

## Capabilities

### New Capabilities
- `canvas-viewport`: infinite surface, camera pan/zoom across mouse/trackpad/touch, zoom controls, fit-to-screen, minimap, responsive shell and theming.
- `editor-tools`: toolbar, tool modes, toggles, global hotkeys, and command palette.
- `canvas-selection`: click/marquee/multi-selection, moving items, grid snap and smart guides.
- `mindmap-structure`: forest model, keyboard creation/navigation, reparenting, collapse/expand, delete, clipboard operations.
- `node-content`: node shapes, styling, cascading properties, rich text, emoji, tags and filtering, notes, attachments, checklists.
- `connections`: hierarchy edge rendering, cross-link creation via the connect tool, edge selection and deletion.
- `auto-layout`: layout directions, auto-align mode semantics, and collision avoidance.
- `edit-history`: undo/redo of document mutations.
- `board-persistence`: boards, IndexedDB autosave/autoload, storage repository abstraction.
- `import-export`: native JSON save/load, Mermaid/PNG/SVG export, checklist export.

### Modified Capabilities
<!-- none: no existing specs -->

## Impact

- Code: everything under `web/better-mindmap/src/app` is new; the scaffolded `app.html` welcome page is removed.
- Dependencies (new): `@tiptap/*` (rich text), `d3-flextree` or `d3-hierarchy` (tree layout), `@angular/cdk` (overlay, a11y, focus utilities), `idb` (IndexedDB wrapper), `html-to-image` or equivalent (PNG export), Jest + `jest-preset-angular`, `@playwright/test`.
- Tooling: test runner switches from Vitest to Jest; Playwright config and e2e folder added.
- Out of scope: server API, authentication, real-time collaboration, cross-device sync. Only the repository interface is prepared for them.
