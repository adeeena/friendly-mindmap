import { TestBed } from '@angular/core/testing';
import { childrenOf } from '../core/commands';
import { ROOT_KEY } from '../core/model';
import { EditorStore } from './editor-store';
import { InteractionController, PointerInfo } from './interaction';

const ev = (p: Partial<PointerInfo> & { x: number; y: number }): PointerInfo => ({
  pointerId: p.pointerId ?? 1,
  pointerType: p.pointerType ?? 'mouse',
  button: p.button ?? 0,
  screen: { x: p.x, y: p.y },
  shift: p.shift ?? false,
  alt: p.alt ?? false,
  nodeId: p.nodeId ?? null,
  edge: p.edge ?? null,
});

describe('InteractionController', () => {
  let store: EditorStore;
  let ctl: InteractionController;
  let t = 0;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(EditorStore);
    ctl = new InteractionController(store, () => t);
  });

  it('hand tool pans and does not select', () => {
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.clearSelection();
    store.setTool('hand');
    ctl.pointerDown(ev({ x: 10, y: 10, nodeId: a }));
    ctl.pointerMove(ev({ x: 60, y: 30, nodeId: a }));
    ctl.pointerUp(ev({ x: 60, y: 30 }));
    expect(store.camera()).toMatchObject({ x: 50, y: 20 });
    expect(store.selectedIds()).toEqual([]);
  });

  it('space held acts as temporary hand', () => {
    ctl.spaceHeld = true;
    expect(ctl.effectiveTool).toBe('hand');
    ctl.spaceHeld = false;
    expect(ctl.effectiveTool).toBe('pointer');
  });

  it('node tool places a node, starts editing and returns to pointer', () => {
    store.setTool('node');
    store.newNodeShape.set('rounded');
    ctl.pointerDown(ev({ x: 100, y: 100 }));
    const [id] = store.doc().children[ROOT_KEY];
    expect(store.doc().nodes[id].shape).toBe('rounded');
    expect(store.editingId()).toBe(id);
    expect(store.tool()).toBe('pointer');
  });

  it('shift-click toggles selection', () => {
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.createRootAt({ x: 400, y: 0 }, { edit: false });
    store.select([a]);
    for (const id of [b, a]) {
      ctl.pointerDown(ev({ x: 1, y: 1, nodeId: id, shift: true }));
      ctl.pointerUp(ev({ x: 1, y: 1, nodeId: id, shift: true }));
    }
    expect(store.selectedIds()).toEqual([b]);
  });

  it('marquee selects only fully enclosed nodes', () => {
    store.sizes.set({});
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.createRootAt({ x: 200, y: 0 }, { edit: false });
    store.reportSize(a, { w: 100, h: 40 });
    store.reportSize(b, { w: 100, h: 40 });
    ctl.pointerDown(ev({ x: -10, y: -10 }));
    ctl.pointerMove(ev({ x: 250, y: 60 }));
    ctl.pointerUp(ev({ x: 250, y: 60 }));
    expect(store.selectedIds()).toEqual([a]);
  });

  it('free drag moves all selected nodes as one undo step with grid snap', () => {
    store.updateSettings({ autoAlign: false });
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.createRootAt({ x: 0, y: 400 }, { edit: false });
    store.select([a, b]);
    ctl.pointerDown(ev({ x: 5, y: 5, nodeId: a }));
    ctl.pointerMove(ev({ x: 50, y: 5, nodeId: a }));
    ctl.pointerMove(ev({ x: 105, y: 5, nodeId: a }));
    ctl.pointerUp(ev({ x: 105, y: 5, nodeId: a }));
    expect(store.doc().nodes[a].x).toBe(104);
    expect(store.doc().nodes[a].x).toBe(store.doc().nodes[b].x);
    store.undo();
    expect(store.doc().nodes[a].x).toBe(0);
    expect(store.doc().nodes[b].x).toBe(0);
  });

  it('alt disables snapping during drag', () => {
    store.updateSettings({ autoAlign: false });
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.select([a]);
    ctl.pointerDown(ev({ x: 0, y: 0, nodeId: a }));
    ctl.pointerMove(ev({ x: 103, y: 0, nodeId: a, alt: true }));
    ctl.pointerUp(ev({ x: 103, y: 0, nodeId: a, alt: true }));
    expect(store.doc().nodes[a].x).toBe(103);
  });

  it('auto align drag onto another node reparents the subtree', () => {
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.createRootAt({ x: 0, y: 400 }, { edit: false });
    const b2 = store.addChild(b, false)!;
    const ra = store.rects().get(a)!;
    const rb2 = store.rects().get(b2)!;
    const z = store.camera();
    const toScreen = (p: { x: number; y: number }) => ({ x: p.x * z.zoom + z.x, y: p.y * z.zoom + z.y });
    const start = toScreen({ x: rb2.x + 5, y: rb2.y + rb2.h / 2 });
    const end = toScreen({ x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 });
    ctl.pointerDown(ev({ ...start, nodeId: b2 }));
    ctl.pointerMove(ev({ ...end, nodeId: a }));
    expect(store.dropTarget()).toEqual({ parentId: a });
    ctl.pointerUp(ev({ ...end, nodeId: a }));
    expect(childrenOf(store.doc(), a)).toEqual([b2]);
  });

  it('escape cancels a structural drag', () => {
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.addChild(a, false)!;
    ctl.pointerDown(ev({ x: 0, y: 0, nodeId: b }));
    ctl.pointerMove(ev({ x: 300, y: 300 }));
    expect(ctl.cancel()).toBe(true);
    expect(store.dropTarget()).toBeNull();
    expect(store.doc().nodes[b].parentId).toBe(a);
  });

  it('connect tool creates a cross-link only when released on another node', () => {
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.createRootAt({ x: 400, y: 0 }, { edit: false });
    store.setTool('connect');
    ctl.pointerDown(ev({ x: 0, y: 0, nodeId: a }));
    ctl.pointerUp(ev({ x: 900, y: 900 }));
    expect(Object.keys(store.doc().links)).toHaveLength(0);
    ctl.pointerDown(ev({ x: 0, y: 0, nodeId: a }));
    ctl.pointerUp(ev({ x: 400, y: 0, nodeId: b }));
    expect(Object.values(store.doc().links)).toEqual([expect.objectContaining({ from: a, to: b })]);
    expect(store.doc().nodes[b].parentId).toBeNull();
  });

  it('two touch pointers pinch-zoom', () => {
    ctl.pointerDown(ev({ pointerId: 1, pointerType: 'touch', x: 100, y: 100 }));
    ctl.pointerDown(ev({ pointerId: 2, pointerType: 'touch', x: 200, y: 100 }));
    expect(ctl.state.kind).toBe('pinching');
    ctl.pointerMove(ev({ pointerId: 2, pointerType: 'touch', x: 300, y: 100 }));
    expect(store.camera().zoom).toBeCloseTo(2);
  });
});
