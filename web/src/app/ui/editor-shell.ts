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
import { Overlay, OverlayContainer } from '@angular/cdk/overlay';
import { ComponentType } from '@angular/cdk/portal';
import { APP_INFO } from '../app-info';
import { AppUpdates } from '../app-updates';
import { Command, CommandRegistry, HotkeyService, eventCombo, isEditableTarget, isMac } from '../editor/commands';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, Msg, t, tm } from '../i18n';
import { BoardSession } from '../persistence/board-session';
import { WorkspaceSession } from '../persistence/workspace-session';
import { BoardSwitcher } from './board-dialogs';
import { AccountActions } from './account-actions';
import { CommandPalette } from './command-palette';
import { ContextToolbar } from './context-toolbar';
import { EditorActions, Toaster } from './editor-actions';
import { EdgeMenu } from './edge-menu';
import { EmojiBar } from './emoji-bar';
import { ExportDialog, ExportTab } from './export-dialog';
import { Icon } from './icon';
import { Minimap } from './minimap';
import { NotesPanel } from './notes-panel';
import { SettingsDialog } from './settings-dialog';
import { TagManager } from './tag-manager';
import { HistoryDialog } from './history-dialog';
import { Toolbar } from './toolbar';
import { Viewport } from './viewport';

/** Translation keys per command id; the palette reads them so labels follow the language. */
const COMMAND_TEXT: Record<string, [label: MessageKey, group: MessageKey]> = {
  'tool.pointer': ['tool.pointer', 'group.tools'],
  'tool.hand': ['cmd.handPan', 'group.tools'],
  'tool.node': ['tool.node', 'group.tools'],
  'tool.connect': ['tool.connect', 'group.tools'],
  'toggle.snap': ['cmd.snap', 'group.view'],
  'toggle.autoAlign': ['cmd.autoAlign', 'group.layout'],
  'layout.cycle': ['cmd.layoutNext', 'group.layout'],
  'layout.horizontal': ['layout.horizontal', 'group.layout'],
  'layout.vertical': ['layout.vertical', 'group.layout'],
  'layout.balanced': ['layout.balanced', 'group.layout'],
  'toggle.minimap': ['cmd.minimap', 'group.view'],
  undo: ['toolbar.undo', 'group.edit'],
  redo: ['toolbar.redo', 'group.edit'],
  'workspace.save': ['cmd.save', 'group.file'],
  'history.open': ['history.title', 'group.file'],
  'file.save': ['toolbar.save', 'group.file'],
  'file.load': ['toolbar.load', 'group.file'],
  'export.open': ['cmd.export', 'group.file'],
  'export.mermaid': ['cmd.exportMermaid', 'group.export'],
  'export.png': ['cmd.exportImage', 'group.export'],
  'export.checklist': ['cmd.exportChecklist', 'group.export'],
  'palette.open': ['toolbar.palette', 'group.view'],
  'zoom.in': ['zoom.in', 'group.view'],
  'zoom.out': ['zoom.out', 'group.view'],
  'zoom.reset': ['cmd.zoomReset', 'group.view'],
  'zoom.fit': ['zoom.fit', 'group.view'],
  'select.all': ['cmd.selectAll', 'group.edit'],
  'select.clear': ['cmd.clearSelection', 'group.edit'],
  'edit.delete': ['cmd.deleteSelection', 'group.edit'],
  'edit.duplicate': ['cmd.duplicate', 'group.edit'],
  'node.edit': ['cmd.editText', 'group.node'],
  'node.addChild': ['cmd.addChild', 'group.node'],
  'node.addSibling': ['cmd.addSibling', 'group.node'],
  'node.collapse': ['cmd.collapse', 'group.node'],
  'notes.toggle': ['cmd.notes', 'group.node'],
  'node.checklist': ['cmd.convertChecklist', 'group.node'],
  'node.todo': ['cmd.toggleTodo', 'group.node'],
  'node.resetPosition': ['cmd.resetPosition', 'group.node'],
  'tags.manage': ['cmd.manageTags', 'group.tags'],
  'tags.clear': ['cmd.clearTagFilter', 'group.tags'],
  'boards.open': ['cmd.switchBoard', 'group.boards'],
  'boards.new': ['cmd.newBoard', 'group.boards'],
  'boards.rename': ['cmd.renameBoard', 'group.boards'],
  'settings.open': ['cmd.settings', 'group.settings'],
};

function localized(c: Command): Command {
  const text = COMMAND_TEXT[c.id];
  if (!text) return c;
  return { ...c, label: t(text[0]), labelKey: text[0], group: t(text[1]), groupKey: text[1] };
}

@Component({
  selector: 'bm-editor-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Toolbar, Viewport, ContextToolbar, EmojiBar, EdgeMenu, Minimap, NotesPanel, Icon, AccountActions],
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
      <h1 class="visually-hidden">{{ t('shell.title', { app: appName, board: store.doc().name }) }}</h1>
      <bm-toolbar />
      <div class="bm-account-corner bm-panel">
        <div class="bm-account-tools">
          <button type="button" class="bm-button" [attr.aria-label]="t('toolbar.boardsLabel', { name: store.doc().name })" [attr.title]="t('toolbar.boardsOpen')" (click)="openBoards()">
            <bm-icon name="boards" [size]="16" />
            <span>{{ t('toolbar.boardsOpen') }}</span>
          </button>
          <button type="button" class="bm-button" [attr.aria-label]="t('toolbar.export')" [attr.title]="t('toolbar.export')" (click)="registry.run('export.open')">
            <bm-icon name="export" [size]="16" />
            <span>{{ t('toolbar.export') }}</span>
          </button>
          <button type="button" class="bm-button" [attr.aria-label]="t('toolbar.settings')" [attr.title]="t('toolbar.settings')" (click)="registry.run('settings.open')">
            <bm-icon name="settings" [size]="16" />
            <span>{{ t('toolbar.settings') }}</span>
          </button>
        </div>
        <bm-account-actions />
      </div>
    </header>
    <main class="bm-main" [attr.aria-label]="t('shell.canvas')">
      @if (banners().length || updates.available() || updates.failed()) {
        <div class="bm-banners">
          @if (updates.available() || updates.failed()) {
            <div class="bm-banner" role="status">
              <span>{{ t(updates.failed() ? 'update.failed' : 'update.ready') }}</span>
              <button type="button" class="bm-button" (click)="reloadUpdate()">{{ t('update.reload') }}</button>
            </div>
          }
          @for (msg of banners(); track msg) {
            <div class="bm-banner" role="alert">
              <span>{{ tm(msg) }}</span>
              @if (msg === session.conflictMessage()) {
                <button type="button" class="bm-button" (click)="session.conflictMessage.set(null)">{{ t('common.dismiss') }}</button>
              }
              @if (session.status() === 'error') {
                <button type="button" class="bm-button" (click)="registry.run('file.save')">{{ t('banner.exportBoard') }}</button>
              }
              @if (msg.key === workspace.syncError()) {
                <button type="button" class="bm-button" (click)="workspace.retrySync()">{{ t('sync.retry') }}</button>
              }
              @if (msg === workspace.recoveryMessage()) {
                <button type="button" class="bm-button" (click)="workspace.dismissRecovery()">{{ t('common.dismiss') }}</button>
              }
            </div>
          }
        </div>
      }
      <div class="bm-canvas">
        <bm-viewport />
        <bm-context-toolbar />
        <bm-emoji-bar />
        @if (store.edgeMenu()) {
          <bm-edge-menu />
        }
        @if (store.contextMenu(); as menu) {
          <div class="bm-menu bm-panel bm-context-menu" role="menu" [attr.aria-label]="t('shell.nodeMenu')" [style.left.px]="menu.x" [style.top.px]="menu.y" (keydown.escape)="closeMenu()">
            @for (item of menuItems; track item.id) {
              <button type="button" class="bm-button" role="menuitem" (click)="runMenu(item.id)">{{ t(item.label) }}</button>
            }
          </div>
        }
        <div class="bm-corner bm-corner-right">
          @if (store.settings().minimap) {
            <bm-minimap />
          }
          <div class="bm-panel bm-corner-buttons bm-view-zoom-group" role="group" [attr.aria-label]="t('shell.viewZoom')">
            <button type="button" class="bm-button" [attr.aria-label]="t('zoom.out')" [attr.title]="tip(t('zoom.out'), 'zoom.out')" (click)="registry.run('zoom.out')"><bm-icon name="zoom-out" /></button>
            <button type="button" class="bm-button bm-zoom-label" [attr.aria-label]="t('zoom.reset')" [attr.title]="tip(t('zoom.resetTip'), 'zoom.reset')">
              {{ zoomPct() }}%
            </button>
            <button type="button" class="bm-button" [attr.aria-label]="t('zoom.in')" [attr.title]="tip(t('zoom.in'), 'zoom.in')" (click)="registry.run('zoom.in')"><bm-icon name="zoom-in" /></button>
            <button type="button" class="bm-button" [attr.aria-label]="t('zoom.fit')" [attr.title]="tip(t('zoom.fit'), 'zoom.fit')" (click)="registry.run('zoom.fit')"><bm-icon name="fit" /></button>
            <span class="bm-corner-sep" aria-hidden="true"></span>
            <button type="button" class="bm-button" data-view-control="minimap" [attr.aria-label]="t('view.minimap')" [attr.aria-pressed]="store.settings().minimap" [attr.title]="tip(t('view.minimap'), 'toggle.minimap')" (click)="registry.run('toggle.minimap')"><bm-icon name="minimap" /></button>
            <button type="button" class="bm-button" data-view-control="tags" [attr.aria-label]="t('view.tags')" [attr.aria-pressed]="store.tagFilter().length > 0" [attr.title]="t('view.tags')" (click)="registry.run('tags.manage')"><bm-icon name="tag" /></button>
          </div>
        </div>
      </div>
    </main>
    @if (notesVisible()) {
      <bm-notes-panel />
    }
    <div class="bm-toasts" aria-live="polite">
      @for (toast of toaster.toasts(); track toast.id) {
        <div class="bm-toast bm-panel" [class.error]="toast.kind === 'error'" [class.warning]="toast.kind === 'warning'" [attr.role]="toast.kind === 'error' ? 'alert' : 'status'">
          {{ toast.text }}
          <button type="button" class="bm-button" [attr.aria-label]="t('common.dismiss')" (click)="toaster.dismiss(toast.id)"><bm-icon name="close" [size]="14" /></button>
        </div>
      }
    </div>
  `,
})
export class EditorShell {
  protected readonly updates = inject(AppUpdates);
  protected readonly workspace = inject(WorkspaceSession);

  protected async reloadUpdate(): Promise<void> {
    if (await this.updates.prepareReload()) window.location.reload();
  }
  protected readonly t = t;
  protected readonly tm = tm;
  protected readonly appName = APP_INFO.name;
  protected readonly store = inject(EditorStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly session = inject(BoardSession);
  protected readonly toaster = inject(Toaster);
  private readonly actions = inject(EditorActions);
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private openDialog: DialogRef<unknown> | null = null;

  protected readonly zoomPct = computed(() => Math.round(this.store.camera().zoom * 100));
  protected readonly notesVisible = computed(() => this.store.notesOpen());
  protected readonly banners = computed(() =>
    [this.session.storageWarning(), this.session.statusMessage(), this.session.conflictMessage(),
      this.workspace.error() ? { key: this.workspace.error()! } : null,
      this.workspace.syncError() ? { key: this.workspace.syncError()! } : null,
      this.workspace.recoveryMessage()].filter(
      (m): m is Msg => !!m,
    ),
  );
  protected readonly menuItems: { id: string; label: MessageKey }[] = [
    { id: 'node.edit', label: 'cmd.editText' },
    { id: 'node.addChild', label: 'cmd.addChild' },
    { id: 'node.addSibling', label: 'cmd.addSibling' },
    { id: 'node.collapse', label: 'cmd.collapse' },
    { id: 'edit.duplicate', label: 'cmd.duplicate' },
    { id: 'notes.toggle', label: 'cmd.notes' },
    { id: 'export.checklist', label: 'menu.exportChecklist' },
    { id: 'edit.delete', label: 'common.delete' },
  ];

  constructor() {
    const destroyRef = inject(DestroyRef);
    inject(HotkeyService).listen(destroyRef);
    this.registry.textEditing = () => !!this.store.editingId();
    const doc = this.host.nativeElement.ownerDocument;
    // Menus render in the CDK overlay; as a named region their content sits inside a landmark.
    const overlay = inject(OverlayContainer).getContainerElement();
    overlay.setAttribute('role', 'region');
    overlay.setAttribute('aria-label', APP_INFO.name);
    const typeAhead = (e: KeyboardEvent) => this.bufferTypeAhead(e);
    doc.addEventListener('keydown', typeAhead, true);
    destroyRef.onDestroy(() => doc.removeEventListener('keydown', typeAhead, true));
    destroyRef.onDestroy(this.registry.register(this.buildCommands()));
    void this.workspace.init(destroyRef);
    effect(() => {
      const menu = this.store.contextMenu();
      if (menu) setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.bm-context-menu button')?.focus());
    });
  }

  protected tip(label: string, id: string): string {
    const k = this.registry.shortcutFor(id);
    return k ? `${label} (${k})` : label;
  }

  private modal<T>(component: ComponentType<T>, config: {
    ariaLabelledBy: string; data?: unknown; panelClass?: string; backdropClass?: string[]; anchor?: HTMLElement | null;
  }): void {
    this.openDialog?.close();
    this.registry.modalOpen.set(true);
    const { anchor, ...dialogConfig } = config;
    const ref = this.dialog.open(component, {
      ...dialogConfig,
      ...(anchor ? { positionStrategy: this.anchoredTo(anchor), scrollStrategy: this.overlay.scrollStrategies.reposition(),
        backdropClass: ['cdk-overlay-transparent-backdrop'], maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 16px)' } : {}),
      autoFocus: 'first-tabbable', restoreFocus: true,
    });
    this.openDialog = ref as DialogRef<unknown>;
    ref.closed.subscribe(() => {
      if (this.openDialog === (ref as DialogRef<unknown>)) this.openDialog = null;
      this.registry.modalOpen.set(this.dialog.openDialogs.length > 0);
      // Safari/WebKit do not focus buttons on click, so the browser's restore would land on <body>.
      if (anchor?.isConnected) anchor.focus();
    });
  }

  /** Opens beside the trigger (above it for bottom-left controls), flips on collision and never leaves the viewport. */
  private anchoredTo(anchor: HTMLElement) {
    return this.overlay.position().flexibleConnectedTo(anchor)
      .withPositions([
        { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
        { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
        { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -8 },
        { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 8 },
      ])
      .withPush(true).withViewportMargin(8).withFlexibleDimensions(true).withGrowAfterOpen(true);
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

  private openSettings(): void {
    this.modal(SettingsDialog, { ariaLabelledBy: 'bm-settings-title', backdropClass: ['cdk-overlay-dark-backdrop', 'bm-blur-backdrop'] });
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
        this.toaster.show(r.ok ? t('toast.attached', { name: f.name }) : r.reason, r.ok ? 'info' : 'error');
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
        id: 'workspace.save',
        label: 'Save',
        group: 'File',
        keys: ['mod+s'],
        allowInEditable: true,
        run: () => void this.actions.saveWorkspace(),
      },
      {
        id: 'file.save',
        label: 'Export to file',
        group: 'File',
        allowInEditable: true,
        run: () => (this.actions.hasAttachments() ? this.openExport('file') : void this.actions.saveFile(false)),
      },
      { id: 'file.load', label: 'Import from file', group: 'File', keys: ['mod+o'], allowInEditable: true, run: () => this.actions.pickAndLoad() },
      { id: 'history.open', label: 'Board history', group: 'File', allowInEditable: true,
        run: () => this.modal(HistoryDialog, { ariaLabelledBy: 'bm-history-title' }),
        enabled: () => !!this.workspace.account() },
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
        enabled: () => idle() && (hasSel() || !!s.selectedEdge() || !!s.contextMenu() || !!s.edgeMenu() || s.tool() !== 'pointer'),
        run: () => {
          if (s.contextMenu()) return s.contextMenu.set(null);
          if (s.edgeMenu()) return s.edgeMenu.set(null);
          if (s.emojiPicker()) return s.emojiPicker.set(false);
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
      { id: 'tags.manage', label: 'Manage & filter tags', group: 'Tags', run: () => this.modal(TagManager, {
        ariaLabelledBy: 'bm-tags-title', anchor: this.host.nativeElement.querySelector<HTMLElement>('[data-view-control="tags"]'),
      }) },
      { id: 'tags.clear', label: 'Clear tag filter', group: 'Tags', run: () => s.tagFilter.set([]), enabled: () => s.tagFilter().length > 0 },
      { id: 'boards.open', label: 'Switch board…', group: 'Boards', run: () => this.openBoards() },
      { id: 'boards.new', label: 'New board', group: 'Boards', run: () => void this.session.create(t('board.untitled')) },
      { id: 'boards.rename', label: 'Rename board', group: 'Boards', run: () => this.openBoards(), enabled: editable },
      {
        id: 'node.resetPosition',
        label: 'Reset node position',
        group: 'Node',
        run: () => s.resetLayoutOffset(),
        enabled: () => editable() && s.selectedIds().some((id) => !!s.doc().nodes[id]?.layoutOffset),
      },
      { id: 'settings.open', label: 'Settings', group: 'Settings', run: () => this.openSettings() },
    ];
    return cmds.map(localized);
  }

  /** Tag filter commands are dynamic; re-registered when tags change. */
  private readonly tagCommands = effect((onCleanup) => {
    const tags = Object.values(this.store.doc().tags);
    const cmds: Command[] = tags.map((tag) => ({
      id: `tags.filter.${tag.id}`,
      label: t('cmd.tagFilter', { name: tag.name }),
      labelKey: 'cmd.tagFilter' as const,
      labelParams: { name: tag.name },
      group: t('group.tags'),
      groupKey: 'group.tags' as const,
      run: () =>
        this.store.tagFilter.update((f) => (f.includes(tag.id) ? f.filter((x) => x !== tag.id) : [...f, tag.id])),
    }));
    const unregister = this.registry.register(cmds);
    onCleanup(unregister);
  });
}
