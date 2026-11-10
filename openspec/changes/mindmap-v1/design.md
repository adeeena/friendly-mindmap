# Design

## Context

`web/better-mindmap` is a fresh Angular 21 standalone scaffold: signals, `ChangeDetectionStrategy.OnPush`, no extra dependencies, and Vitest as the scaffolded unit test runner. Project rules require standalone components, signal state, `input()`/`output()`, host bindings in the decorator, native control flow, `inject()`, and WCAG AA / AXE compliance. Motivation and scope: see proposal.md. Behavior: see the specs under `specs/`.

## Goals / Non-Goals

**Goals:**
- Steady 60fps pan, zoom and drag with several hundred visible nodes on a mid-range laptop and a recent phone.
- A pure, framework-free document model and command layer so layout, history, serialization and storage are unit-testable without Angular.
- One storage contract so an HTTP backend can be added without touching editor code.

**Non-Goals:**
- Real-time collaboration, CRDTs, or conflict merging (multi-tab handling is reload-on-change only).
- Rendering thousands of on-screen nodes; viewport culling is prepared but not tuned.
- Server rendering; the editor is client-only.

## Decisions

### D1. Rendering: HTML nodes + one SVG edge layer under a CSS camera transform
```
<bm-viewport>                      pointer/wheel/touch events, grid background
  <div.world style="transform: translate(x,y) scale(z)">
    <svg.edges>   hierarchy + cross-link paths, hit paths
    <bm-node>*    absolutely positioned HTML (TipTap content)
    <div.overlay> marquee, smart guides, drop indicator, "+" handles
```
Why: native text editing, IME, focus and ARIA come for free, which matters for TipTap and AXE. Alternatives: Canvas2D/WebGL (fast, but text editing and accessibility would need to be rebuilt by hand); pure SVG with `foreignObject` (Safari focus/caret bugs).
Crisp text: `will-change: transform` is set on `.world` only during an active gesture and removed 120ms after it ends so the browser re-rasterizes sharply.

### D2. State: one signal store holding an immutable document plus a separate view state
- `DocumentState` (persisted and in history): `nodes: Record<id, Node>`, `childOrder: Record<id|'root', id[]>`, `links: Record<id, CrossLink>`, `tags`, `settings`.
- `ViewState` (not in history): camera, selection, active tool, editing node id, hover, tag filter, transient drag preview.
- Derived with `computed()`: resolved (inherited) styles per node, visible node set (collapse), layout positions, edge geometry, bounds.
Parent is stored on the node (`parentId`), with `childOrder` for ordering. Ids are `crypto.randomUUID()`. Alternative: NgRx Store — rejected because signals plus a small command layer give the same predictability with less code.

### D3. Mutations go through commands that produce patches (history)
Each command is a pure function `(doc, args) => { doc', patches, inversePatches }` built with Immer `produceWithPatches`. The history service keeps patch stacks (limit 200), merges steps by `transactionId` (drag, typing session, paste, relayout), and ignores ViewState. Alternative: full snapshots (simple but memory-heavy with rich text); hand-written inverse commands (error-prone).
Text editing: TipTap keeps its own history while a node is being edited; when editing ends, one `setNodeContent` command is committed so the global history contains one step per editing session. Cmd/Ctrl+Z inside the editor goes to TipTap.

### D4. Interaction: tool state machines fed by a pointer/keyboard router
```
        +---------+  down on node   +----------+ move>3px  +----------+
Pointer | idle    |---------------->| pointing |---------->| dragging |--up--> commit move/reparent
        +---------+                 +----------+           +----------+
          | down on empty                | up
          v                              v
        +----------+                 select / toggle
        | brushing |--up--> select fully enclosed
        +----------+
```
Tools (Pointer, Hand, NewNode, Connect) implement `onPointerDown/Move/Up/Cancel`, `onKey`. Temporary Hand (Space or middle mouse) pushes Hand onto a tool stack and pops it on release. Pointer Events with `setPointerCapture`; moves are coalesced to one update per animation frame. Two active touch pointers switch to a pinch/pan gesture regardless of tool.

### D5. Hotkeys: one keymap service with editing-aware scopes
A `HotkeyService` listens on `document` keydown, resolves a key binding (normalizing Cmd on macOS and Ctrl elsewhere), and checks scope: `global` bindings run only when the event target is not editable (`isContentEditable`, input, textarea) and the palette is closed; `editing` bindings (Tab, Enter, Shift+Tab, Escape) are handled by the node editor component. The command palette and toolbar tooltips read the same command registry, so labels and shortcuts stay in one place.

### D6. Layout engine: in-house subtree-box stacking per root, plus a tree-level collision pass
- Each visible tree is laid out by stacking child subtree boxes along the breadth axis, centered on the parent (the classic XMind/MindNode mind-map layout; variable node sizes, never overlapping). Horizontal and Vertical swap axes; Balanced splits root children by accumulated subtree breadth into right and left groups and mirrors the left one.
- Positions are relative to the root, so the root stays fixed (spec: roots keep positions).
- Tree-to-tree pass: compare tree bounding boxes in root order and shift overlapping trees along the minimal axis, iterating until stable or 20 passes.
- Auto align OFF: positions are stored on nodes; new-node placement searches candidate slots outward along the breadth axis with linear overlap tests; drop nudging resolves the minimal translation vector.
- Node sizes come from a `ResizeObserver` on rendered nodes and are fed back into layout; layout runs in a `computed()` and positions animate via CSS `transition: transform 150ms` (disabled under `prefers-reduced-motion` and during drags).
Alternatives: `d3-flextree` (tidier packing, but untyped and pinned to d3-hierarchy v1 — dropped during implementation); `d3-hierarchy` tree (fixed node size only); ELK.js (powerful but heavy and async).

### D7. Edges: cubic beziers with tapered hierarchy strokes
Hierarchy edges: anchors at the parent side facing the child and the child's opposite side; control points pushed out by `0.5 * distance` along the layout axis. Taper is rendered as a filled path (two offset curves). Cross-links: dashed stroke, side anchors chosen by relative position, arrowhead marker. Each edge also has an invisible 12px-wide hit path. Edge geometry is computed only for edges touching changed nodes.

### D8. Inheritance resolution
`resolvedStyle(node) = own ?? resolvedStyle(parent) ?? boardDefault`, computed top-down once per tree in a memoized `computed()`. Tags union along the ancestry unless a node sets `tagsMode: 'override'`. The UI shows inherited values greyed with a "Reset to inherited" action that clears the own value.

### D9. Rich text: TipTap (ProseMirror) mounted on demand
Display mode renders stored TipTap JSON to sanitized HTML (cheap, many nodes). Edit mode mounts one TipTap editor into the node being edited (StarterKit subset: paragraph, hard break, bold, italic; Link extension with protocol allowlist http/https/mailto, `rel="noopener noreferrer"`, `target="_blank"`). Notes use a second TipTap instance in the side panel. Checklist node items are plain-text inputs in a list, not TipTap, to keep them light.
Sanitization: content is stored as ProseMirror JSON; rendering goes through the schema serializer (never `innerHTML` from file data), and the loader validates JSON against the schema, which drops unknown marks and attributes.

### D10. Persistence: `BoardRepository` contract with an IndexedDB implementation
```
interface BoardRepository {
  list(): Promise<BoardSummary[]>
  load(id): Promise<StoredBoard>
  save(board, expectedRevision): Promise<{ revision }>
  delete(id): Promise<void>
  putAttachment(boardId, blob, meta): Promise<AttachmentRef>
  getAttachment(ref): Promise<Blob>
  deleteAttachment(ref): Promise<void>
}
```
Provided through an `InjectionToken`; v1 binds `IndexedDbBoardRepository` (via `idb`) with stores `boards`, `attachments` (Blobs), `meta` (last opened board). Autosave: a debounced (800ms) `effect()` on `DocumentState` plus a flush on `visibilitychange`/`pagehide`. Multi-tab: `BroadcastChannel('bmm')` publishes `{boardId, revision}` after saves; a tab without pending edits reloads, a tab with pending edits shows a conflict message and keeps its copy as a duplicate board. Orphan attachments are garbage-collected on board save. Alternative: localStorage (5MB limit, sync, no Blobs) — rejected by the user in exploration.

### D11. File formats
Native: `{ format: "better-mindmap", schemaVersion: 1, board: {...}, attachments: [{id, name, mime, size, path?}] }`. Bundled `.bmm.zip` (via `fflate`) has `board.json` + `attachments/<id>`. Migrations are an ordered list of `vN -> vN+1` pure functions shared by storage and file loading. Load limits: 50 MB zip, 20,000 nodes.
Mermaid: one `mindmap` block per root; shapes map `none -> text`, `rectangle -> [text]`, `rounded -> (text)`; text is flattened and escaped.
Images: SVG export serializes a cloned render of the selected bounds with inlined computed styles; PNG via `html-to-image` at pixel ratio 1 or 2.
Checklists: Markdown/plain text generators; `navigator.share` when available; print view is a dedicated route with print CSS.

### D12. Component and folder structure
```
src/app/
  core/        model types, commands, history, migrations, ids (no Angular)
  layout/      flextree adapter, collision, placement (no Angular)
  persistence/ repository token, IndexedDB impl, autosave, broadcast
  io/          native, mermaid, image, checklist exporters/importers
  editor/      store, tools, hotkeys, command registry
  ui/          viewport, node, edges, toolbar, context toolbar, palette,
               minimap, notes panel, board switcher, dialogs
```
Feature UI is lazy-loaded where it is not needed at first paint (palette, notes panel, export dialogs, print route). Angular CDK provides overlays, `FocusTrap`, `LiveAnnouncer`, and `ListKeyManager` for the palette and menus.

### D13. Accessibility of the canvas
The node layer has `role="tree"`; nodes are `role="treeitem"` with `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded`, and roving `tabindex` so only the selected node is in the tab order. Structural edits are announced through `LiveAnnouncer`. Tab and Enter are captured only while a node is selected or being edited inside the tree; Escape releases focus to normal tab order (no keyboard trap). Edges are `aria-hidden`; cross-links are listed in the node's accessible description.

### D14. Testing: Jest for unit, Playwright for e2e
Per the user's choice, Vitest is replaced by Jest with `jest-preset-angular` (configured outside the Angular builder, `npm test` runs Jest). `core/`, `layout/`, `io/` and `persistence/` (with `fake-indexeddb`) get thorough unit tests. Playwright covers the key flows on Chromium, WebKit and a mobile viewport, and runs `@axe-core/playwright` on main screens. Alternative: keep Vitest (Angular default, Jest-compatible API) — not chosen because the user asked for Jest.

## Risks / Trade-offs

- [TipTap inside a scaled, transformed container misplaces caret or selection overlays] → Mount the editor in the node (it scales with it) and spike this first in phase 2; if broken, render the active editor in an unscaled overlay positioned over the node.
- [Layout thrash from `ResizeObserver` -> layout -> resize loops] → Layout reads sizes only; sizes are rounded to whole pixels and updates batched per frame.
- [Reparent-by-drag feels unpredictable] → Clear drop indicator (target highlight + insertion line), 400ms dwell before collapsed targets expand, Escape cancels the drag.
- [Large boards slow down] → Memoized per-tree layout, edge recompute limited to dirty nodes, viewport culling hook in place for later.
- [IndexedDB unavailable (private mode, quota)] → Fall back to an in-memory repository with a persistent warning and a prompt to export.
- [Jest + Angular 21 support lags behind Vitest] → Pin `jest-preset-angular` to a version supporting Angular 21; if blocked, report and fall back to Vitest with the same test files.
- [Big single change] → Tasks are grouped into phases, each ending in a runnable, tested app.
- [Malicious imported files (XSS, zip bombs)] → Schema validation, ProseMirror-only rendering, link protocol allowlist, size and node-count limits, no `innerHTML` from user data.

## Migration Plan

Greenfield; the scaffold welcome page is removed. Rollback is reverting the change. Stored data starts at `schemaVersion: 1`; future versions add migration functions.

## Open Questions

- Exact color palette values and the icon set for the emoji/icon picker (can be tuned without changing behavior).
- Default spacing constants for layout (level gap, sibling gap) to be tuned visually.
