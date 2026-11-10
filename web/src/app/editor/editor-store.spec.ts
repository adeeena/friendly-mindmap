import { TestBed } from '@angular/core/testing';
import { childrenOf } from '../core/commands';
import { ROOT_KEY } from '../core/model';
import { validateBoardDoc } from '../core/validate';
import { EditorStore } from './editor-store';

describe('EditorStore', () => {
  let store: EditorStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(EditorStore);
  });

  it('updates signals after commands and undo/redo', () => {
    expect(store.canUndo()).toBe(false);
    const root = store.createRootAt({ x: 0, y: 0 });
    expect(store.editingId()).toBe(root);
    const child = store.addChild(root)!;
    expect(childrenOf(store.doc(), root)).toEqual([child]);
    expect(store.visibleIds()).toEqual([root, child]);
    expect(store.canUndo()).toBe(true);

    store.undo();
    expect(store.doc().nodes[child]).toBeUndefined();
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect(store.doc().nodes[child]).toBeDefined();
  });

  it('derives resolved styles and visibility (collapse)', () => {
    const root = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const child = store.addChild(root, false)!;
    store.select([root]);
    store.setColor('green');
    expect(store.styles()[child].color).toBe('green');
    store.toggleCollapse(root);
    expect(store.visibleIds()).toEqual([root]);
  });

  it('auto align lays out new children without overlap and roots stay fixed', () => {
    const root = store.createRootAt({ x: 96, y: 96 }, { edit: false });
    const a = store.addChild(root, false)!;
    const b = store.addChild(root, false)!;
    const rects = store.rects();
    expect(rects.get(root)).toMatchObject({ x: 96, y: 96 });
    const ra = rects.get(a)!;
    const rb = rects.get(b)!;
    expect(ra.y + ra.h <= rb.y || rb.y + rb.h <= ra.y).toBe(true);
  });

  it('turning auto align off bakes positions as one undo step', () => {
    const root = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const a = store.addChild(root, false)!;
    const laidOut = store.rects().get(a)!;
    store.updateSettings({ autoAlign: false });
    expect(store.doc().nodes[a]).toMatchObject({ x: laidOut.x, y: laidOut.y });
    store.undo();
    expect(store.settings().autoAlign).toBe(true);
  });

  it('delete selects the parent', () => {
    const root = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const a = store.addChild(root, false)!;
    store.select([a]);
    store.deleteSelection();
    expect(store.selectedIds()).toEqual([root]);
  });

  it('paste of indented text adds children to the selected node', () => {
    const root = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.select([root]);
    store.paste('one\n  two\nthree');
    expect(childrenOf(store.doc(), root)).toHaveLength(2);
  });

  it('duplicate inserts copies as next siblings', () => {
    const root = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.select([root]);
    store.duplicateSelection();
    expect(store.doc().children[ROOT_KEY]).toHaveLength(2);
  });

  describe('edge styling', () => {
    const setup = () => {
      const root = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      const a = store.addChild(root, false)!;
      const b = store.addChild(root, false)!;
      const other = store.createRootAt({ x: 0, y: 400 }, { edit: false });
      const link = store.addLink(a, other)!;
      return { root, a, b, link };
    };

    it('styles only the selected hierarchy edge', () => {
      const { a, b } = setup();
      store.setEdgeStyle({ type: 'hierarchy', childId: a }, { color: 'red', width: 4, pattern: 'dashed' });
      expect(store.doc().nodes[a].edgeStyle).toEqual({ color: 'red', width: 4, pattern: 'dashed' });
      expect(store.doc().nodes[b].edgeStyle).toBeUndefined();
    });

    it('styles only the selected cross-link and merges patches', () => {
      const { a, link } = setup();
      store.setEdgeStyle({ type: 'link', id: link }, { pattern: 'dashed' });
      store.setEdgeStyle({ type: 'link', id: link }, { width: 1 });
      expect(store.doc().links[link].edgeStyle).toEqual({ pattern: 'dashed', width: 1 });
      expect(store.doc().nodes[a].edgeStyle).toBeUndefined();
    });

    it('clears single fields and resets to the default', () => {
      const { a } = setup();
      const edge = { type: 'hierarchy', childId: a } as const;
      store.setEdgeStyle(edge, { color: 'blue', width: 3 });
      store.setEdgeStyle(edge, { color: undefined });
      expect(store.doc().nodes[a].edgeStyle).toEqual({ width: 3 });
      store.setEdgeStyle(edge, null);
      expect(store.doc().nodes[a].edgeStyle).toBeUndefined();
    });

    it('undoes and redoes style changes', () => {
      const { link } = setup();
      const edge = { type: 'link', id: link } as const;
      store.setEdgeStyle(edge, { color: 'green' });
      store.undo();
      expect(store.doc().links[link].edgeStyle).toBeUndefined();
      store.redo();
      expect(store.doc().links[link].edgeStyle).toEqual({ color: 'green' });
    });

    it('survives a board reopen', () => {
      const { a, link } = setup();
      store.setEdgeStyle({ type: 'hierarchy', childId: a }, { pattern: 'dotted', color: 'teal' });
      store.setEdgeStyle({ type: 'link', id: link }, { width: 6 });
      const stored = JSON.parse(JSON.stringify({ doc: store.doc(), camera: store.camera() }));
      store.loadBoard({ doc: validateBoardDoc(stored.doc), camera: stored.camera });
      expect(store.doc().nodes[a].edgeStyle).toEqual({ pattern: 'dotted', color: 'teal' });
      expect(store.doc().links[link].edgeStyle).toEqual({ width: 6 });
    });

    it('drops the style when the child is reparented', () => {
      const { a, b } = setup();
      store.setEdgeStyle({ type: 'hierarchy', childId: a }, { color: 'red' });
      store.reparent(a, { parentId: b });
      expect(store.doc().nodes[a].edgeStyle).toBeUndefined();
    });

    it('opens the line menu with the edge selected and closes it when selection changes', () => {
      const { a, root } = setup();
      store.openEdgeMenu({ type: 'hierarchy', childId: a }, { x: 10, y: 20 });
      expect(store.selectedEdge()).toEqual({ type: 'hierarchy', childId: a });
      expect(store.edgeMenu()).toMatchObject({ x: 10, y: 20 });
      store.select([root]);
      expect(store.edgeMenu()).toBeNull();
    });
  });
});
