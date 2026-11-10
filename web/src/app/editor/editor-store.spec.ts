import { TestBed } from '@angular/core/testing';
import { childrenOf } from '../core/commands';
import { ROOT_KEY } from '../core/model';
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
});
