# Tasks

## 1. Tooling and scaffolding

- [x] 1.1 Replace Vitest with Jest (`jest`, `jest-preset-angular`, `@types/jest`, `jest.config.ts`, `setup-jest.ts`), point `npm test` at Jest, update `tsconfig.spec.json`, and verify `npm test` runs the existing `app.spec.ts` green
- [x] 1.2 Add Playwright (`@playwright/test`, `@axe-core/playwright`) with `playwright.config.ts` (Chromium, WebKit, mobile viewport, `webServer: npm start`) and an `e2e/` folder; verify `npx playwright test` runs a smoke test that loads the app
- [x] 1.3 Add runtime dependencies (`immer`, `@angular/cdk`, `idb`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `fflate`, `html-to-image`) and dev `fake-indexeddb`; verify `npm run build` succeeds
- [x] 1.4 Create the folder structure from design D12 (`core`, `layout`, `persistence`, `io`, `editor`, `ui`), remove the welcome page from `app.html`, add global theme tokens (light/dark via `prefers-color-scheme`, AA palette) in `styles.scss`; verify the app renders an empty full-screen shell with no console errors

## 2. Phase 1 - Document model and history (pure TypeScript)

- [x] 2.1 Define document types (node, shape, style, tags, cross-link, checklist items, attachments meta, settings, board) and `schemaVersion: 1` in `core/`; verify with a type-check build and a unit test constructing a sample board
- [x] 2.2 Implement structural commands with Immer patches: create root, add child, add sibling, promote, reorder, reparent (cycle check), delete subtree (removes attached cross-links), detach as root; verify unit tests for each, including cycle rejection and Enter-on-root behavior
- [x] 2.3 Implement content/style commands: set text, shape, color, emoji, tags, note, todo flag, checklist items, collapse; verify unit tests
- [x] 2.4 Implement cross-link commands with self-link and duplicate prevention; verify unit tests
- [x] 2.5 Implement history service (patch stacks, 200 limit, transaction merging, redo cleared on new edit, view state excluded); verify unit tests for undo delete, grouped drag, and redo invalidation
- [x] 2.6 Implement inheritance resolver (color, shape, tags union/override, emoji) and reset-to-inherited; verify unit tests including reparent changing inherited values
- [x] 2.7 Implement the signal store (`DocumentState`, `ViewState`, derived visible set and resolved styles) wrapping commands and history; verify unit tests that store signals update after commands and undo

## 3. Phase 2 - Canvas, tools, selection and editing UI

- [x] 3.1 Build the viewport component: camera signal, world transform, dot grid, wheel pan, Ctrl/Cmd+wheel and pinch zoom around focal point (10%-400%), middle-mouse pan, gesture-only `will-change`; verify unit tests for camera math and a Playwright test for zoom-at-cursor
- [x] 3.2 Build the tool state machine router and tools (Pointer, Hand, NewNode with shape, Connect) with tool stack for Space/middle-mouse temporary Hand and two-finger touch pan/pinch; verify unit tests for state transitions
- [x] 3.3 Build the command registry and `HotkeyService` (Cmd/Ctrl normalization, global vs editing scopes, suppression in editable targets); verify unit tests that P/H switch tools and that typing "P" in an editable does not
- [x] 3.4 Build the main toolbar (tools, shape picker, Snap, Auto align, Layout direction, Undo/Redo, Save, Load, Export, board switcher placeholder) with `aria-pressed`, tooltips with shortcuts, responsive compact mode; verify component tests and a Playwright check at 375px width with no horizontal scroll
- [x] 3.5 Build the node component (display-mode rendering of rich text JSON, shapes none/rect/rounded, color, emoji, tag chips, badges for notes/attachments/collapse/progress, max width 320px, `ResizeObserver` size reporting); verify component tests per shape
- [x] 3.6 Spike then implement TipTap edit mode inside a scaled node (caret and IME correct at 50% and 250% zoom), Tab/Enter/Shift+Tab/Shift+Enter/Escape handling, type-to-replace, F2/double-click/double-tap, commit one history step per editing session; verify a Playwright test for Tab child, Enter sibling, Shift+Enter line break, and caret position at 250%
- [x] 3.7 Implement click/Shift selection, full-enclosure marquee (mouse and touch), Cmd/Ctrl+A, Escape clear, and selection outlines; verify unit tests for enclosure math and a Playwright test that a partially covered node is not selected
- [x] 3.8 Implement free dragging of selections with rAF batching, 8px grid snap, Alt override, smart guides (4px threshold), Alt+arrow nudging; verify unit tests for snap/guide math and a Playwright drag test
- [x] 3.9 Implement edge layer: tapered bezier hierarchy edges, dashed cross-links with arrowheads, 12px hit paths, collapsed-endpoint fallback, edge selection/delete (detach on hierarchy edge); verify unit tests for path geometry and a Playwright test creating and deleting a cross-link with the Connect tool
- [x] 3.10 Implement structural keyboard navigation (arrows relative to layout direction), Cmd/Ctrl+Up/Down reorder, Delete/Backspace, collapse toggle and Cmd/Ctrl+Period, "+" hover handles; verify Playwright keyboard-only test building and navigating a 3-level tree
- [x] 3.11 Implement clipboard (copy/cut/paste subtrees with new ids, internal cross-links, indented plain-text paste) and Cmd/Ctrl+D duplicate; verify unit tests for subtree cloning and text parsing
- [x] 3.12 Implement accessibility layer: `role="tree"`/`treeitem` with level/setsize/posinset/expanded, roving tabindex, `LiveAnnouncer` messages, no keyboard trap after Escape; verify a Playwright AXE scan with zero violations
- [x] 3.13 Implement touch: tap select, double-tap edit, long-press context menu, drag move; verify Playwright mobile-viewport tests

## 4. Phase 3 - Layout engine and auto align

- [x] 4.1 Implement the in-house subtree-box layout for Horizontal and Vertical with root-fixed relative positions; verify unit tests that no nodes overlap with mixed sizes and sibling order is kept
- [x] 4.2 Implement Balanced layout (split root children by subtree size, mirror left side); verify unit tests for 4 children split 2/2
- [x] 4.3 Implement tree-to-tree collision pass with minimal root shifts; verify unit tests for a growing tree pushing its neighbor
- [x] 4.4 Implement Auto align OFF placement (free-slot search in layout direction, minimal drop nudge); verify unit tests for occupied-slot placement
- [x] 4.5 Wire layout into the store: relayout on structure/size/collapse/direction changes when Auto align is on, single undo step when toggling on, 150ms transitions disabled for reduced motion and during drag; verify Playwright test that Tab in Auto align places a non-overlapping child
- [x] 4.6 Implement reparent/reorder by drag with drop indicator, dwell-to-expand on collapsed targets, Escape cancel, drop on empty canvas makes root; verify Playwright test dragging "B2" onto "A"

## 5. Phase 4 - Persistence and boards

- [x] 5.1 Implement the `BoardRepository` token and `IndexedDbBoardRepository` (boards, attachments, meta, revisions) with in-memory fallback; verify unit tests with `fake-indexeddb` including revision increments
- [x] 5.2 Implement migrations framework and newer-version read-only guard; verify unit tests for v1 pass-through and newer-version refusal to overwrite
- [x] 5.3 Implement autosave (800ms debounce, flush on `visibilitychange`/`pagehide`), save status indicator, error state with export prompt; verify Playwright test that an edit survives reload
- [x] 5.4 Implement autoload of last board and first-launch "Untitled board"; verify Playwright test on clean storage
- [x] 5.5 Implement board switcher (create, rename, duplicate, delete with confirm dialog, last-modified) and per-board settings and camera; verify Playwright test switching between two boards with different layout settings
- [x] 5.6 Implement `BroadcastChannel` multi-tab reload and conflict handling; verify Playwright test with two pages on the same board

## 6. Phase 5 - Rich content

- [x] 6.1 Implement rich text marks (bold, italic, links with http/https/mailto allowlist, safe rel/target) and shortcuts; verify unit test rejecting `javascript:` links and Playwright test that bold survives reload
- [x] 6.2 Implement contextual selection toolbar (shape, color palette, emoji/icon picker, tags, todo toggle, checklist conversion) applying to multi-selection, with inherited vs overridden display and reset; verify component tests
- [x] 6.3 Implement tag management (create/rename/color/delete per board) and tag filter with dimming, also exposed in the command palette; verify Playwright test filtering by a tag including inherited matches
- [x] 6.4 Implement the notes side panel (TipTap, overlay on narrow screens, focus management) and note indicator; verify Playwright test and AXE scan with the panel open
- [x] 6.5 Implement attachments (file picker and drop onto node, 10 MB cap with message, list/open/download/remove, image thumbnails, orphan cleanup); verify unit tests for size cap and Playwright test attaching an image
- [x] 6.6 Implement checklist node (inline items, Enter adds, Backspace on empty removes, progress) and todo-children mode with progress; verify Playwright shopping list test showing "1/2"

## 7. Phase 6 - Import/export, palette and minimap

- [x] 7.1 Implement native save (`.bmm.json`, optional `.bmm.zip` with attachments) and load (validation, sanitization, 50 MB/20,000-node limits, opens as new board); verify unit round-trip test and malicious-file tests
- [x] 7.2 Implement Mermaid export (one mindmap per root, shape mapping, escaping, lossy warning, copy/download `.mmd`); verify unit tests against expected Mermaid text
- [x] 7.3 Implement PNG (1x/2x) and SVG export of board or selection with theme/background options; verify Playwright test that a download of the expected type occurs
- [x] 7.4 Implement checklist export (Markdown, plain text, `navigator.share` when supported, print route with print CSS); verify unit tests for Markdown/plain text output
- [x] 7.5 Implement the Cmd/Ctrl+K command palette (lazy-loaded, CDK overlay, `ListKeyManager`, fuzzy search over the command registry, focus restore); verify Playwright test running "Vertical" via the palette
- [x] 7.6 Implement zoom controls, fit to screen (Shift+1, empty-board reset), and the toggleable minimap with click/drag navigation; verify unit tests for fit math and Playwright minimap click test

## 8. Integration verification

- [x] 8.1 Run the full Playwright suite on Chromium, WebKit and the mobile viewport plus AXE scans on main screens (empty board, populated board, notes panel, palette, dialogs) in light and dark themes; verify all pass
- [x] 8.2 Performance check: board with 500 nodes pans, zooms and drags at ~60fps in Chrome DevTools performance profile and text is sharp after zoom; record results in the change PR description
- [x] 8.3 Run `npm run build`, `npm test`, and `npx playwright test` from `web/better-mindmap` and verify all succeed with no warnings about budgets beyond the configured limits

## Workflow follow-up

- Archive the change after review with `/opsx-archive`.
