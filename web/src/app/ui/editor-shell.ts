import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
} from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { ComponentType } from '@angular/cdk/portal';
import { Command, CommandRegistry, HotkeyService, eventCombo, isEditableTarget, isMac } from '../editor/commands';
import { EditorStore } from '../editor/editor-store';
import { BoardSession } from '../persistence/board-session';
import { BoardSwitcher } from './board-dialogs';
import { CommandPalette } from './command-palette';
import { ContextToolbar } from './context-toolbar';
import { EditorActions, Toaster } from './editor-actions';
import { ExportDialog, ExportTab } from './export-dialog';
import { Icon } from './icon';
import { Minimap } from './minimap';
import { NotesPanel } from './notes-panel';
import { TagManager } from './tag-manager';
import { Toolbar } from './toolbar';
import { Viewport } from './viewport';

@Component({
  selector: 'bm-editor-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Toolbar, Viewport, ContextToolbar, Minimap, NotesPanel, Icon],
  host: {
    class: 'bm-shell',
    '[class.notes-open]': 'notesVisible()',
    '(document:copy)': 'onCopy($event)',
    '(document:cut)': 'onCut($event)',
    '(document:paste)': 'onPaste($event)',
    '(dragover)': 'onDragOver($event)',
    '(drop)': 'onDrop($event)',
  },
  template: `
    <header class="bm-header">
      <h1 class="visually-hidden">Better Mindmap — {{ store.doc().name }}</h1>
      <bm-toolbar (openBoards)="openBoards()" />
      @for (msg of banners(); track msg) {
        <div class="bm-banner" role="alert">
          <span>{{ msg }}</span>
          @if (msg === session.conflictMessage()) {
            <button type="button" class="bm-button" (click)="session.conflictMessage.set(null)">Dismiss</button>
          }
          @if (session.status() === 'error') {
            <button type="button" class="bm-button" (click)="registry.run('file.save')">Export board</button>
          }
        </div>
      }
    </header>
    <main class="bm-main" aria-label="Canvas">
      <bm-viewport />
      <bm-context-toolbar />
      @if (store.contextMenu(); as menu) {
        <div class="bm-menu bm-panel bm-context-menu" role="menu" aria-label="Node actions" [style.left.px]="menu.x" [style.top.px]="menu.y" (keydown.escape)="closeMenu()">
          @for (item of menuItems; track item.id) {
            <button type="button" class="bm-button" role="menuitem" (click)="runMenu(item.id)">{{ item.label }}</button>
          }
        </div>
      }
      <div class="bm-corner bm-corner-right bm-panel" role="group" aria-label="Zoom">
        <button type="button" class="bm-button" aria-label="Zoom out" [attr.title]="tip('Zoom out', 'zoom.out')" (click)="registry.run('zoom.out')"><bm-icon name="zoom-out" /></button>
        <button type="button" class="bm-button bm-zoom-label" aria-label="Reset zoom to 100%" [attr.title]="tip('Reset zoom', 'zoom.reset')" (click)="registry.run('zoom.reset')">
          {{ zoomPct() }}%
        </button>
        <button type="button" class="bm-button" aria-label="Zoom in" [attr.title]="tip('Zoom in', 'zoom.in')" (click)="registry.run('zoom.in')"><bm-icon name="zoom-in" /></button>
        <button type="button" class="bm-button" aria-label="Fit to screen" [attr.title]="tip('Fit to screen', 'zoom.fit')" (click)="registry.run('zoom.fit')"><bm-icon name="fit" /></button>
      </div>
      <div class="bm-corner bm-corner-left">
        <div class="bm-panel bm-corner-buttons" role="group" aria-label="View">
          <button type="button" class="bm-button" aria-label="Minimap" [attr.aria-pressed]="store.settings().minimap" [attr.title]="tip('Minimap', 'toggle.minimap')" (click)="registry.run('toggle.minimap')"><bm-icon name="minimap" /></button>
          <button type="button" class="bm-button" aria-label="Tags and filter" [attr.aria-pressed]="store.tagFilter().length > 0" title="Tags and filter" (click)="registry.run('tags.manage')"><bm-icon name="filter" /></button>
        </div>
        @if (store.settings().minimap) {
          <bm-minimap />
        }
      </div>
    </main>
    @if (notesVisible()) {
      <bm-notes-panel />
    }
    <div class="bm-toasts" aria-live="polite">
      @for (t of toaster.toasts(); track t.id) {
        <div class="bm-toast bm-panel" [class.error]="t.kind === 'error'" [attr.role]="t.kind === 'error' ? 'alert' : 'status'">
          {{ t.text }}
          <button type="button" class="bm-button" aria-label="Dismiss" (click)="toaster.dismiss(t.id)"><bm-icon name="close" [size]="14" /></button>
        </div>
      }
    </div>
  `,
})
export class EditorShell {
  protected readonly store = inject(EditorStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly session = inject(BoardSession);
  protected readonly toaster = inject(Toaster);
  private readonly actions = inject(EditorActions);
  private readonly dialog = inject(Dialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private openDialog: DialogRef<unknown> | null = null;

  protected readonly zoomPct = computed(() => Math.round(this.store.camera().zoom * 100));
  protected readonly notesVisible = computed(() => this.store.notesOpen());
  protected readonly banners = computed(() =>
    [this.session.storageWarning(), this.session.statusMessage(), this.session.conflictMessage()].filter(
      (m): m is string => !!m,
    ),
  );
  protected readonly menuItems = [
    { id: 'node.edit', label: 'Edit text' },
    { id: 'node.addChild', label: 'Add child' },
    { id: 'node.addSibling', label: 'Add sibling' },
    { id: 'node.collapse', label: 'Collapse / expand' },
    { id: 'edit.duplicate', label: 'Duplicate' },
    { id: 'notes.toggle', label: 'Notes & attachments' },
    { id: 'export.checklist', label: 'Export checklist…' },
    { id: 'edit.delete', label: 'Delete' },
  ];

  constructor() {
    const destroyRef = inject(DestroyRef);
    inject(HotkeyService).listen(destroyRef);
    this.registry.textEditing = () => !!this.store.editingId();
    const doc = this.host.nativeElement.ownerDocument;
    const typeAhead = (e: KeyboardEvent) => this.bufferTypeAhead(e);
    doc.addEventListener('keydown', typeAhead, true);
    destroyRef.onDestroy(() => doc.removeEventListener('keydown', typeAhead, true));
    destroyRef.onDestroy(this.registry.register(this.buildCommands()));
    void this.session.init(destroyRef);
    effect(() => {
      const menu = this.store.contextMenu();
      if (menu) setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.bm-context-menu button')?.focus());
    });
  }

  protected tip(label: string, id: string): string {
    const k = this.registry.shortcutFor(id);
    return k ? `${label} (${k})` : label;
  }

  private modal<T>(component: ComponentType<T>, config: { ariaLabelledBy: string; data?: unknown; panelClass?: string }): void {
    this.openDialog?.close();
    this.registry.modalOpen.set(true);
    const ref = this.dialog.open(component, { ...config, autoFocus: 'first-tabbable', restoreFocus: true });
    this.openDialog = ref as DialogRef<unknown>;
    ref.closed.subscribe(() => {
      if (this.openDialog === (ref as DialogRef<unknown>)) this.openDialog = null;
      this.registry.modalOpen.set(this.dialog.openDialogs.length > 0);
    });
  }

  protected openBoards(): void {
    this.modal(BoardSwitcher, { ariaLabelledBy: 'bm-boards-title' });
  }

  private openExport(tab?: ExportTab): void {
    this.modal(ExportDialog, { ariaLabelledBy: 'bm-export-title', data: { tab } });
  }

  private openPalette(): void {
    if (this.dialog.openDialogs.some((d) => d.componentInstance instanceof CommandPalette)) return;
    this.modal(CommandPalette, { ariaLabelledBy: 'bm-palette-title', panelClass: 'bm-palette-pane' });
  }

  protected closeMenu(): void {
    this.store.contextMenu.set(null);
  }

  /** While a node editor is about to mount, capture keys so fast typing is not lost. */
  private bufferTypeAhead(e: KeyboardEvent): void {
    const editing = this.store.editingId();
    if (!editing || e.isComposing) return;
    const active = this.host.nativeElement.ownerDocument.activeElement;
    const nodeEl = active?.closest('[data-node-id]');
    if (nodeEl) {
      // Focus may still sit in the previous node's editor right after Tab/Enter.
      if (nodeEl.getAttribute('data-node-id') === editing && active?.closest('.ProseMirror, input')) return;
    } else if (active?.closest('.ProseMirror, input, textarea, select, [role="dialog"]')) {
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return;
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    if (mod || e.altKey) {
      // Global shortcuts that work while typing (save, palette...) are not buffered.
      const combo = eventCombo(e);
      const global = this.registry
        .commands()
        .some((c) => c.allowInEditable && c.keys?.includes(combo) && (!c.enabled || c.enabled()));
      if (global) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.store.typeAhead.push(`${mod ? 'Mod-' : ''}${e.altKey ? 'Alt-' : ''}${e.shiftKey ? 'Shift-' : ''}${key}`);
      e.preventDefault();
      e.stopPropagation();
      queueMicrotask(() => this.store.drainTypeAhead?.());
      return;
    }
    const token = e.key.length === 1 ? e.key : (e.shiftKey ? 'Shift+' : '') + e.key;
    e.preventDefault();
    e.stopPropagation();
    this.store.typeAhead.push(token);
    queueMicrotask(() => this.store.drainTypeAhead?.());
  }

  protected runMenu(id: string): void {
    this.closeMenu();
    this.registry.run(id);
  }

  // ------------------------------------------------------------ clipboard

  private canvasClipboard(e: ClipboardEvent): boolean {
    return !isEditableTarget(e.target) && !this.registry.modalOpen() && !this.store.editingId();
  }

  protected onCopy(e: ClipboardEvent): void {
    if (!this.canvasClipboard(e)) return;
    const text = this.store.copySelection();
    if (text === null) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  }

  protected onCut(e: ClipboardEvent): void {
    if (!this.canvasClipboard(e) || this.store.readOnly()) return;
    const text = this.store.cutSelection();
    if (text === null) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  }

  protected onPaste(e: ClipboardEvent): void {
    if (!this.canvasClipboard(e) || this.store.readOnly()) return;
    e.preventDefault();
    this.store.paste(e.clipboardData?.getData('text/plain') ?? null);
  }

  // ------------------------------------------------------------ file drop

  protected onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  }

  protected async onDrop(e: DragEvent): Promise<void> {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    const nodeId = (e.target as Element).closest('[data-node-id]')?.getAttribute('data-node-id');
    if (nodeId && !this.store.readOnly()) {
      for (const f of files) {
        const r = await this.session.attach(nodeId, f);
        this.toaster.show(r.ok ? `Attached “${f.name}”` : r.reason, r.ok ? 'info' : 'error');
      }
      return;
    }
    const board = files.find((f) => /\.(json|zip)$/i.test(f.name));
    if (board) await this.actions.loadFile(board);
  }

  // ------------------------------------------------------------- commands

  private buildCommands(): Command[] {
    const s = this.store;
    const editable = () => !s.readOnly();
    const hasSel = () => s.selectedIds().length > 0;
    const idle = () => !s.dragging() && !s.marquee() && !s.connectPreview();
    const dir = (d: 'horizontal' | 'vertical' | 'balanced') => () => s.updateSettings({ direction: d });
    const cmds: Command[] = [
      { id: 'tool.pointer', label: 'Pointer', group: 'Tools', keys: ['p', 'v'], run: () => s.setTool('pointer') },
      { id: 'tool.hand', label: 'Hand (pan)', group: 'Tools', keys: ['h'], run: () => s.setTool('hand') },
      { id: 'tool.node', label: 'New node', group: 'Tools', keys: ['n'], run: () => s.setTool('node'), enabled: editable },
      { id: 'tool.connect', label: 'New connection', group: 'Tools', keys: ['c'], run: () => s.setTool('connect'), enabled: editable },
      { id: 'toggle.snap', label: 'Toggle snap to grid', group: 'View', keys: ['g'], run: () => s.updateSettings({ snap: !s.settings().snap }), enabled: editable },
      {
        id: 'toggle.autoAlign',
        label: 'Toggle auto align',
        group: 'Layout',
        keys: ['a'],
        run: () => {
          s.updateSettings({ autoAlign: !s.settings().autoAlign });
          s.announce(s.settings().autoAlign ? 'Auto align on' : 'Auto align off');
        },
        enabled: editable,
      },
      { id: 'layout.cycle', label: 'Next layout direction', group: 'Layout', keys: ['l'], run: () => s.cycleDirection(), enabled: editable },
      { id: 'layout.horizontal', label: 'Horizontal', group: 'Layout', run: dir('horizontal'), enabled: editable },
      { id: 'layout.vertical', label: 'Vertical', group: 'Layout', run: dir('vertical'), enabled: editable },
      { id: 'layout.balanced', label: 'Balanced', group: 'Layout', run: dir('balanced'), enabled: editable },
      { id: 'toggle.minimap', label: 'Toggle minimap', group: 'View', keys: ['m'], run: () => s.updateSettings({ minimap: !s.settings().minimap }) },
      { id: 'undo', label: 'Undo', group: 'Edit', keys: ['mod+z'], run: () => s.undo(), enabled: () => s.canUndo() },
      { id: 'redo', label: 'Redo', group: 'Edit', keys: ['mod+shift+z', 'mod+y'], run: () => s.redo(), enabled: () => s.canRedo() },
      {
        id: 'file.save',
        label: 'Save to file',
        group: 'File',
        keys: ['mod+s'],
        allowInEditable: true,
        run: () => (this.actions.hasAttachments() ? this.openExport('file') : void this.actions.saveFile(false)),
      },
      { id: 'file.load', label: 'Load from file', group: 'File', keys: ['mod+o'], allowInEditable: true, run: () => this.actions.pickAndLoad() },
      { id: 'export.open', label: 'Export…', group: 'File', run: () => this.openExport() },
      { id: 'export.mermaid', label: 'Export Mermaid', group: 'Export', run: () => this.openExport('mermaid') },
      { id: 'export.png', label: 'Export PNG / SVG image', group: 'Export', run: () => this.openExport('image') },
      { id: 'export.checklist', label: 'Export checklist', group: 'Export', run: () => this.openExport('checklist'), enabled: () => !!this.actions.checklistFor() },
      { id: 'palette.open', label: 'Command palette', group: 'View', keys: ['mod+k'], allowInEditable: true, hidden: true, run: () => this.openPalette(), enabled: () => !s.editingId() },
      { id: 'zoom.in', label: 'Zoom in', group: 'View', keys: ['mod+='], run: () => s.zoomBy(1.2) },
      { id: 'zoom.out', label: 'Zoom out', group: 'View', keys: ['mod+-'], run: () => s.zoomBy(1 / 1.2) },
      { id: 'zoom.reset', label: 'Zoom to 100%', group: 'View', keys: ['mod+0'], run: () => s.zoomReset() },
      { id: 'zoom.fit', label: 'Fit to screen', group: 'View', keys: ['shift+1'], run: () => s.fitToScreen() },
      { id: 'select.all', label: 'Select all', group: 'Edit', keys: ['mod+a'], run: () => s.selectAll() },
      {
        id: 'select.clear',
        label: 'Clear selection',
        group: 'Edit',
        keys: ['escape'],
        hidden: true,
        enabled: () => idle() && (hasSel() || !!s.selectedEdge() || !!s.contextMenu() || s.tool() !== 'pointer'),
        run: () => {
          if (s.contextMenu()) return s.contextMenu.set(null);
          if (s.tool() !== 'pointer') return s.setTool('pointer');
          s.clearSelection();
        },
      },
      {
        id: 'edit.delete',
        label: 'Delete selection',
        group: 'Edit',
        keys: ['delete', 'backspace'],
        run: () => s.deleteSelection(),
        enabled: () => editable() && (hasSel() || !!s.selectedEdge()),
      },
      { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', keys: ['mod+d'], run: () => s.duplicateSelection(), enabled: () => editable() && hasSel() },
      { id: 'node.edit', label: 'Edit text', group: 'Node', hidden: true, run: () => s.primaryId() && s.beginEdit(s.primaryId()!), enabled: hasSel },
      { id: 'node.addChild', label: 'Add child', group: 'Node', run: () => void s.addChild(), enabled: () => editable() && hasSel() },
      { id: 'node.addSibling', label: 'Add sibling', group: 'Node', run: () => void s.addSibling(), enabled: () => editable() && hasSel() },
      { id: 'node.collapse', label: 'Collapse / expand', group: 'Node', keys: ['mod+.'], run: () => s.toggleCollapse(), enabled: hasSel },
      { id: 'notes.toggle', label: 'Notes & attachments', group: 'Node', run: () => s.notesOpen.update((v) => !v), enabled: () => s.selectedIds().length === 1 || s.notesOpen() },
      { id: 'node.checklist', label: 'Convert to checklist', group: 'Node', run: () => s.convertToChecklist(), enabled: () => editable() && hasSel() },
      { id: 'node.todo', label: 'Toggle todo list for children', group: 'Node', run: () => s.setTodo(!s.doc().nodes[s.primaryId()!]?.todo), enabled: () => editable() && hasSel() },
      { id: 'tags.manage', label: 'Manage & filter tags', group: 'Tags', run: () => this.modal(TagManager, { ariaLabelledBy: 'bm-tags-title' }) },
      { id: 'tags.clear', label: 'Clear tag filter', group: 'Tags', run: () => s.tagFilter.set([]), enabled: () => s.tagFilter().length > 0 },
      { id: 'boards.open', label: 'Switch board…', group: 'Boards', run: () => this.openBoards() },
      { id: 'boards.new', label: 'New board', group: 'Boards', run: () => void this.session.create('Untitled board') },
    ];
    return cmds;
  }

  /** Tag filter commands are dynamic; re-registered when tags change. */
  private readonly tagCommands = effect((onCleanup) => {
    const tags = Object.values(this.store.doc().tags);
    const cmds: Command[] = tags.map((t) => ({
      id: `tags.filter.${t.id}`,
      label: `Filter by tag: ${t.name}`,
      group: 'Tags',
      run: () =>
        this.store.tagFilter.update((f) => (f.includes(t.id) ? f.filter((x) => x !== t.id) : [...f, t.id])),
    }));
    const unregister = this.registry.register(cmds);
    onCleanup(unregister);
  });
}
