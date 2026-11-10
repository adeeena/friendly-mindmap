import { TestBed } from '@angular/core/testing';
import { Component, input } from '@angular/core';
import { EditorStore } from '../editor/editor-store';
import { BOARD_REPOSITORY, MemoryBoardRepository } from '../persistence/board-repository';
import { CommandRegistry } from '../editor/commands';
import { NodeView } from './node-view';
import { Toolbar } from './toolbar';
import { ContextToolbar } from './context-toolbar';

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

@Component({
  selector: 'bm-test-host',
  imports: [NodeView],
  template: `<div class="bm-viewport"><bm-node [nodeId]="id()" /></div>`,
})
class NodeHost {
  readonly id = input.required<string>();
}

describe('UI components', () => {
  let store: EditorStore;

  beforeAll(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [{ provide: BOARD_REPOSITORY, useValue: new MemoryBoardRepository() }] });
    store = TestBed.inject(EditorStore);
  });

  describe('NodeView', () => {
    it.each(['none', 'rectangle', 'rounded'] as const)('renders the %s shape', async (shape) => {
      const id = store.createRootAt({ x: 40, y: 80 }, { shape, edit: false });
      const fixture = TestBed.createComponent(NodeHost);
      fixture.componentRef.setInput('id', id);
      await fixture.whenStable();
      const el = (fixture.nativeElement as HTMLElement).querySelector('[data-node-id]') as HTMLElement;
      expect(el.classList).toContain(`shape-${shape}`);
      expect(el.getAttribute('role')).toBe('treeitem');
      expect(el.style.transform).toBe('translate(40px, 80px)');
    });

    it('shows color, emoji, tag chips and checklist progress', async () => {
      const id = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      store.mutate((d) => {
        d.tags['t'] = { id: 't', name: 'work', color: 'blue' };
        d.nodes[id].tags = ['t'];
        d.nodes[id].color = 'green';
        d.nodes[id].emoji = '🛒';
        d.nodes[id].kind = 'checklist';
        d.nodes[id].items = [
          { id: 'a', text: 'milk', checked: true },
          { id: 'b', text: 'eggs', checked: false },
        ];
      });
      const fixture = TestBed.createComponent(NodeHost);
      fixture.componentRef.setInput('id', id);
      await fixture.whenStable();
      const el = (fixture.nativeElement as HTMLElement).querySelector('[data-node-id]') as HTMLElement;
      expect(el.classList).toContain('colored');
      expect(el.style.getPropertyValue('--node-color')).toBe('var(--c-green)');
      expect(el.textContent).toContain('🛒');
      expect(el.querySelector('.bm-chip')?.textContent).toContain('work');
      expect(el.textContent).toContain('1/2');
      expect(el.getAttribute('aria-label')).toContain('1 of 2 done');
    });
  });

  describe('Toolbar', () => {
    it('reflects the active tool and toggles with aria-pressed', async () => {
      const registry = TestBed.inject(CommandRegistry);
      registry.register([
        { id: 'tool.hand', label: 'Hand', group: 'Tools', keys: ['h'], run: () => store.setTool('hand') },
        { id: 'toggle.snap', label: 'Snap', group: 'View', keys: ['g'], run: () => store.updateSettings({ snap: !store.settings().snap }) },
      ]);
      const fixture = TestBed.createComponent(Toolbar);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const btn = (name: string) => root.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;
      expect(btn('Pointer').getAttribute('aria-pressed')).toBe('true');
      btn('Hand').click();
      await fixture.whenStable();
      expect(btn('Hand').getAttribute('aria-pressed')).toBe('true');
      expect(btn('Pointer').getAttribute('aria-pressed')).toBe('false');
      expect(btn('Hand').getAttribute('title')).toBe('Hand (H)');
      expect(btn('Undo').disabled).toBe(true);
      const snapBefore = store.settings().snap;
      btn('Snap to grid').click();
      await fixture.whenStable();
      expect(btn('Snap to grid').getAttribute('aria-pressed')).toBe(String(!snapBefore));
      expect(btn('Undo').disabled).toBe(false);
    });
  });

  describe('ContextToolbar', () => {
    it('applies shape and todo to every selected node and hides while editing', async () => {
      const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      const b = store.createRootAt({ x: 0, y: 200 }, { edit: false });
      store.select([a, b]);
      const fixture = TestBed.createComponent(ContextToolbar);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      (root.querySelector('button[aria-label="Rectangle"]') as HTMLButtonElement).click();
      (root.querySelector('button[aria-label="Todo list for children"]') as HTMLButtonElement).click();
      expect(store.doc().nodes[a].shape).toBe('rectangle');
      expect(store.doc().nodes[b].shape).toBe('rectangle');
      expect(store.doc().nodes[b].todo).toBe(true);
      store.beginEdit(a);
      await fixture.whenStable();
      expect(root.hidden).toBe(true);
    });
  });
});
