import { TestBed } from '@angular/core/testing';
import { Component, input } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { APP_INFO } from '../app-info';
import { ColorKey, PALETTE_KEYS } from '../core/model';
import { DICTIONARIES, Language, setLanguage } from '../i18n';
import { SETTINGS_STORAGE_KEY, SettingsService } from '../settings.service';
import { EditorStore } from '../editor/editor-store';
import { BOARD_REPOSITORY, MemoryBoardRepository } from '../persistence/board-repository';
import { CommandRegistry } from '../editor/commands';
import { BoardSession } from '../persistence/board-session';
import { WorkspaceSession } from '../persistence/workspace-session';
import { NodeView } from './node-view';
import { AccountActions } from './account-actions';
import { SettingsDialog } from './settings-dialog';
import { Toolbar } from './toolbar';
import { ContextToolbar } from './context-toolbar';
import { EdgeLayer } from './edge-layer';
import { EdgeMenu } from './edge-menu';
import { ColorPalette } from './color-palette';
import { TagManager } from './tag-manager';

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

    it('labels the bottom handle as sibling and the right handle as child', async () => {
      const id = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      store.select([id]);
      const fixture = TestBed.createComponent(NodeHost);
      fixture.componentRef.setInput('id', id);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const bottomHandle = root.querySelector('.bm-handle.side-bottom') as HTMLButtonElement;
      const rightHandle = root.querySelector('.bm-handle.side-right') as HTMLButtonElement;

      expect(bottomHandle.title).toBe('Add sibling');
      expect(rightHandle.title).toBe('Add child');

      const existing = new Set(Object.keys(store.doc().nodes));
      bottomHandle.click();
      await fixture.whenStable();
      const siblingId = Object.keys(store.doc().nodes).find((nodeId) => !existing.has(nodeId))!;
      expect(store.doc().nodes[siblingId].parentId).toBe(store.doc().nodes[id].parentId);

      store.select([id]);
      fixture.detectChanges();
      const childHandle = root.querySelector('.bm-handle.side-right') as HTMLButtonElement;
      const beforeChild = new Set(Object.keys(store.doc().nodes));
      childHandle.click();
      await fixture.whenStable();
      const childId = Object.keys(store.doc().nodes).find((nodeId) => !beforeChild.has(nodeId))!;
      expect(store.doc().nodes[childId].parentId).toBe(id);
    });
  });

  describe('EdgeLayer', () => {
    const setup = async () => {
      const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      const b = store.addChild(a, false)!;
      const c = store.createRootAt({ x: 0, y: 400 }, { edit: false });
      const linkId = store.addLink(b, c)!;
      const fixture = TestBed.createComponent(EdgeLayer);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const hier = () => root.querySelector('.bm-edge') as SVGPathElement;
      const link = () => root.querySelector('.bm-link:not(.preview)') as SVGPathElement;
      return { a, b, c, linkId, fixture, hier, link };
    };

    it('draws both relation types with the same solid, untapered default', async () => {
      const { hier, link } = await setup();
      for (const el of [hier(), link()]) {
        expect(el.style.getPropertyValue('stroke-width')).toBe('2px');
        expect(el.style.getPropertyValue('stroke-dasharray')).toBe('');
        expect(el.style.getPropertyValue('stroke')).toBe('');
        expect(el.getAttribute('marker-end')).toBeNull();
        expect(el.getAttribute('d')).not.toContain('Z');
      }
    });

    it('applies per-edge pattern, color and width only to the styled edge', async () => {
      const { b, linkId, fixture, hier, link } = await setup();
      store.mutate((d) => {
        d.nodes[b].edgeStyle = { pattern: 'dashed', color: 'red', width: 4 };
        d.links[linkId].edgeStyle = { pattern: 'dotted', width: 1 };
      });
      await fixture.whenStable();
      expect(hier().style.getPropertyValue('stroke')).toBe('var(--c-red)');
      expect(hier().style.getPropertyValue('stroke-width')).toBe('4px');
      expect(hier().style.getPropertyValue('stroke-dasharray')).toBe('16 12');
      expect(link().style.getPropertyValue('stroke-width')).toBe('1px');
      expect(link().style.getPropertyValue('stroke-dasharray')).toBe('0.1 2.5');
      expect(link().style.getPropertyValue('stroke')).toBe('');
    });

    it('renders legacy edges without style fields using the default', async () => {
      const { b, fixture, hier } = await setup();
      expect(store.doc().nodes[b].edgeStyle).toBeUndefined();
      await fixture.whenStable();
      expect(hier().style.getPropertyValue('stroke-width')).toBe('2px');
    });
  });

  describe('EdgeMenu', () => {
    it('edits pattern, color and thickness of only the selected edge', async () => {
      const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      const b = store.addChild(a, false)!;
      const c = store.addChild(a, false)!;
      store.openEdgeMenu({ type: 'hierarchy', childId: b }, { x: 5, y: 5 });
      const fixture = TestBed.createComponent(EdgeMenu);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const radio = (group: string, name: string) =>
        [...root.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${group}"] [role="menuitemradio"]`)].find(
          (el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === name,
        )!;
      expect(radio('Pattern', 'Solid').getAttribute('aria-checked')).toBe('true');
      radio('Pattern', 'Dashed').click();
      radio('Color', 'Rose').click();
      radio('Thickness', '4 px').click();
      await fixture.whenStable();
      expect(store.doc().nodes[b].edgeStyle).toEqual({ pattern: 'dashed', color: 'rose', width: 4 });
      expect(store.doc().nodes[c].edgeStyle).toBeUndefined();
      expect(radio('Pattern', 'Dashed').getAttribute('aria-checked')).toBe('true');
      (root.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
      expect(store.doc().nodes[b].edgeStyle).toBeUndefined();
    });

    it('edits a cross-link', async () => {
      const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      const b = store.createRootAt({ x: 0, y: 400 }, { edit: false });
      const link = store.addLink(a, b)!;
      store.openEdgeMenu({ type: 'link', id: link }, { x: 5, y: 5 });
      const fixture = TestBed.createComponent(EdgeMenu);
      await fixture.whenStable();
      const dotted = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
        (el) => el.textContent?.trim() === 'Dotted',
      )!;
      dotted.click();
      expect(store.doc().links[link].edgeStyle).toEqual({ pattern: 'dotted' });
    });
  });

  describe('Settings dialog and localization', () => {
    const closeSpy = jest.fn();

    beforeEach(() => {
      localStorage.clear();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: BOARD_REPOSITORY, useValue: new MemoryBoardRepository() },
          { provide: DialogRef, useValue: { close: closeSpy } },
        ],
      });
      store = TestBed.inject(EditorStore);
    });

    afterEach(() => {
      setLanguage('en');
      localStorage.clear();
    });

    const open = async (lang?: Language) => {
      const settings = TestBed.inject(SettingsService);
      if (lang) settings.setLanguage(lang);
      const fixture = TestBed.createComponent(SettingsDialog);
      await fixture.whenStable();
      return { fixture, root: fixture.nativeElement as HTMLElement };
    };

    it('has Appearance and Language tabs only, with the version in the side pane', async () => {
      const { root } = await open();
      const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      expect(tabs.map((b) => b.textContent?.trim())).toEqual(['Appearance', 'Language']);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');
      expect(root.querySelector('h2')?.textContent).toContain('Appearance');
      expect(root.querySelector('.bm-set-version')?.textContent).toContain(`Version ${APP_INFO.version}`);
      expect(root.textContent).not.toContain('About');
    });

    it('offers only the active themes while retaining Pale Rose', async () => {
      const { root } = await open();
      const options = [...root.querySelectorAll<HTMLOptionElement>('#bm-theme-select option')];
      expect(options.map((option) => option.value)).toEqual(['system', 'light', 'dark', 'pale-rose']);
      expect(options[3].textContent).toContain('Pale Rose');
    });

    it('credits the author in the footer with a link to the homepage', async () => {
      const { root } = await open();
      const footer = root.querySelector('.bm-set-footer') as HTMLElement;
      expect(footer.textContent).toContain('Made by');
      const link = footer.querySelector('a') as HTMLAnchorElement;
      expect(link.textContent).toContain('Muráncsik Adéna Auróra');
      expect(link.href).toBe('https://adena.dev/');
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noopener');
    });

    it('persists the chosen theme and language and re-renders in the new language', async () => {
      const { fixture, root } = await open();
      const settings = TestBed.inject(SettingsService);
      const radio = (name: string, value: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
      const themeSelect = root.querySelector<HTMLSelectElement>('#bm-theme-select')!;
      themeSelect.value = 'dark';
      themeSelect.dispatchEvent(new Event('change'));
      root.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click();
      await fixture.whenStable();
      radio('bm-language', 'fr').click();
      await fixture.whenStable();
      expect(settings.theme()).toBe('dark');
      expect(settings.language()).toBe('fr');
      expect(root.querySelector('h2')?.textContent).toContain('Langue');
      expect(root.querySelector('#bm-settings-title')?.textContent).toContain('Paramètres');
      expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual({ theme: 'dark', language: 'fr' });
    });

    it.each(['en', 'fr', 'hu'] as const)('renders the dialog fully in %s', async (lang) => {
      const { root } = await open(lang);
      const d = DICTIONARIES[lang];
      expect(root.querySelector('#bm-settings-title')?.textContent).toContain(d['settings.title']);
      expect(root.querySelector('h2')?.textContent).toContain(d['settings.appearance']);
      expect(root.textContent).toContain(d['theme.light']);
      expect(root.textContent).toContain(d['theme.system']);
      expect(root.textContent).toContain(d['settings.version']);
      expect(root.querySelector('.bm-set-footer')?.textContent).toContain(d['footer.madeBy']);
      expect(root.querySelector('.bm-set-close')?.getAttribute('aria-label')).toBe(d['common.close']);
    });

    it.each(['fr', 'hu'] as const)('translates the toolbar, selection toolbar and line menu in %s', async (lang) => {
      TestBed.inject(SettingsService).setLanguage(lang);
      const d = DICTIONARIES[lang];
      const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
      const b = store.addChild(a, false)!;
      store.select([a]);
      const toolbar = TestBed.createComponent(Toolbar);
      const selection = TestBed.createComponent(ContextToolbar);
      await toolbar.whenStable();
      await selection.whenStable();
      const labels = (el: HTMLElement) => [...el.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
      expect(labels(toolbar.nativeElement)).toEqual(expect.arrayContaining([d['tool.hand'], d['toolbar.undo']]));
      expect(labels(toolbar.nativeElement)).not.toContain(d['toolbar.settings']);
      expect(labels(selection.nativeElement)).toEqual(expect.arrayContaining([d['selection.color'], d['selection.delete']]));

      store.openEdgeMenu({ type: 'hierarchy', childId: b }, { x: 0, y: 0 });
      const menu = TestBed.createComponent(EdgeMenu);
      await menu.whenStable();
      expect(labels(menu.nativeElement)).toEqual(expect.arrayContaining([d['edge.pattern'], d['edge.thickness']]));
      expect((menu.nativeElement as HTMLElement).textContent).toContain(d['edge.reset']);
    });
  });

  describe('Board toolbar actions', () => {
    const setup = async () => {
      await TestBed.inject(BoardSession).init();
      const fixture = TestBed.createComponent(Toolbar);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      return { fixture, root };
    };

    it('keeps save, import, boards, settings, and inline rename out of the toolbar', async () => {
      const { root } = await setup();
      expect(root.querySelector(
        'button[aria-label="Save"], button[aria-label="Load"], button[aria-label="Rename board"], button[aria-label="Export"], button[aria-label^="Open boards"], button[aria-label="Settings"]',
      )).toBeNull();
      expect(root.querySelector('#bm-board-rename')).toBeNull();
    });
  });

  describe('Color palette and tags', () => {
    beforeEach(() => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          { provide: BOARD_REPOSITORY, useValue: new MemoryBoardRepository() },
          { provide: DialogRef, useValue: { close: jest.fn() } },
        ],
      });
      store = TestBed.inject(EditorStore);
    });

    it('lists the palette with localized names, one current color and one tab stop', async () => {
      @Component({ selector: 'bm-palette-host', imports: [ColorPalette], template: `<bm-color-palette label="Color" [value]="value" (picked)="last = $event" />` })
      class PaletteHost {
        value: ColorKey | undefined = 'rose';
        last: string | null = null;
      }
      const fixture = TestBed.createComponent(PaletteHost);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const swatches = [...root.querySelectorAll<HTMLButtonElement>('.bm-pal-swatch')];
      expect(swatches).toHaveLength(PALETTE_KEYS.length);
      expect(root.querySelectorAll('.bm-swatch-grid')[0].children).toHaveLength(12);
      expect(swatches.map((b) => b.getAttribute('aria-label'))).toEqual(PALETTE_KEYS.map((k) => DICTIONARIES.en[`color.${k}`]));
      expect(swatches.filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset['key'])).toEqual(['rose']);
      expect(swatches.filter((b) => b.tabIndex === 0).map((b) => b.dataset['key'])).toEqual(['rose']);
      swatches[0].click();
      expect(fixture.componentInstance.last).toBe('violet');
    });

    it('arrow keys move focus across the grid', async () => {
      @Component({ selector: 'bm-palette-host2', imports: [ColorPalette], template: `<bm-color-palette label="Color" />` })
      class PaletteHost {}
      const fixture = TestBed.createComponent(PaletteHost);
      await fixture.whenStable();
      const key = (k: string) => (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(`[data-key="${k}"]`)!;
      key('violet').focus();
      key('violet').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(document.activeElement).toBe(key('orchid'));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(key('tangerine'));
    });

    it('tag manager picks the new tag color and recolors a tag from the palette', async () => {
      const fixture = TestBed.createComponent(TagManager);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const click = async (el: Element | null) => {
        (el as HTMLElement).click();
        await fixture.whenStable();
      };
      await click(root.querySelector('button[aria-label^="Color"]'));
      await click(root.querySelector('[data-key="rose"]'));
      expect(root.querySelector('bm-color-palette')).toBeNull();
      const name = root.querySelector('#bm-tag-new') as HTMLInputElement;
      name.value = 'work';
      (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
      await fixture.whenStable();
      const tag = Object.values(store.doc().tags)[0];
      expect(tag).toMatchObject({ name: 'work', color: 'rose' });

      await click(root.querySelector('.bm-tag-item button[aria-label^="Tag color"]'));
      await click(root.querySelector('.bm-tag-item [data-key="navy"]'));
      expect(Object.values(store.doc().tags)[0].color).toBe('navy');
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

    it('shows a fixed-space progress indicator for local saves and cloud sync', async () => {
      const session = TestBed.inject(BoardSession);
      const workspace = TestBed.inject(WorkspaceSession);
      const fixture = TestBed.createComponent(AccountActions);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;

      expect(root.querySelector('.bm-account-save-progress')).toBeNull();
      expect(root.querySelector('.bm-save-spinner')).toBeNull();

      session.status.set('saving');
      fixture.detectChanges();
      expect(root.querySelector('.bm-account-save-progress .bm-save-spinner')).not.toBeNull();
      expect(root.querySelector('[role="status"]')?.textContent).toBe('Saving…');

      session.status.set('saved');
      workspace.account.set({ id: 'account', username: 'test', display_name: 'Test', role: 'basic' });
      workspace.syncState.set('syncing');
      fixture.detectChanges();
      expect(root.querySelector('.bm-account-save-progress .bm-save-spinner')).not.toBeNull();
      expect(root.querySelector('[role="status"]')?.textContent).toBe('Syncing to cloud');
    });
  });

  describe('ContextToolbar', () => {
    it('applies shape and todo to every selected node and stays available while editing', async () => {
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
      fixture.detectChanges();
      expect(root.hidden).toBe(false);
      expect(root.querySelector('[aria-label="Color"]')).not.toBeNull();
      expect(root.querySelector('[aria-label="Emoji"]')).not.toBeNull();
      expect(root.querySelector('[aria-label="Tags"]')).not.toBeNull();
      expect(root.querySelector('[aria-label="Delete"]')).not.toBeNull();
    });
  });
});
