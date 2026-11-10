import { ChangeDetectionStrategy, Component, computed, effect, inject, output, viewChild, ElementRef } from '@angular/core';
import { ConnectedPosition } from '@angular/cdk/overlay';
import { CdkMenu, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { LayoutDirection, Shape } from '../core/model';
import { CommandRegistry } from '../editor/commands';
import { EditorStore, ToolId } from '../editor/editor-store';
import { MessageKey, t } from '../i18n';
import { BoardSession } from '../persistence/board-session';
import { Icon } from './icon';

interface ToolButton {
  id: ToolId;
  label: MessageKey;
  icon: string;
  command: string;
}

@Component({
  selector: 'bm-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkMenu, CdkMenuItemRadio, CdkMenuTrigger],
  host: { class: 'bm-toolbar bm-panel', role: 'toolbar', '[attr.aria-label]': 't("toolbar.label")' },
  template: `
    <div class="bm-tb-group" role="group" [attr.aria-label]="t('toolbar.tools')">
      @for (tool of tools; track tool.id) {
        <button
          type="button"
          class="bm-button"
          [attr.aria-pressed]="store.tool() === tool.id"
          [attr.aria-label]="t(tool.label)"
          [attr.title]="tip(t(tool.label), tool.command)"
          (click)="registry.run(tool.command)"
        >
          <bm-icon [name]="tool.icon" />
        </button>
      }
      <button
        type="button"
        class="bm-button bm-split"
        [attr.aria-label]="t('toolbar.newNodeShapeLabel', { shape: shapeLabel() })"
        [attr.title]="t('toolbar.newNodeShape')"
        [cdkMenuTriggerFor]="shapeMenu"
        [cdkMenuPosition]="menuPositions"
      >
        <bm-icon [name]="store.newNodeKind() === 'checklist' ? 'checklist' : 'shape-' + store.newNodeShape()" [size]="14" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group" role="group" [attr.aria-label]="t('toolbar.layout')">
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('toolbar.snap')"
        [attr.aria-pressed]="store.settings().snap"
        [attr.title]="tip(t('toolbar.snap'), 'toggle.snap')"
        (click)="registry.run('toggle.snap')"
      >
        <bm-icon name="snap" />
      </button>
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('toolbar.autoAlign')"
        [attr.aria-pressed]="store.settings().autoAlign"
        [attr.title]="tip(t('toolbar.autoAlign'), 'toggle.autoAlign')"
        (click)="registry.run('toggle.autoAlign')"
      >
        <bm-icon name="align" />
      </button>
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('toolbar.directionLabel', { direction: directionLabel() })"
        [attr.title]="tip(t('toolbar.direction'), 'layout.cycle')"
        [cdkMenuTriggerFor]="layoutMenu"
        [cdkMenuPosition]="menuPositions"
      >
        <bm-icon [name]="'layout-' + store.settings().direction" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group" role="group" [attr.aria-label]="t('toolbar.history')">
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('toolbar.undo')"
        [attr.title]="tip(t('toolbar.undo'), 'undo')"
        [disabled]="!store.canUndo()"
        (click)="registry.run('undo')"
      >
        <bm-icon name="undo" />
      </button>
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('toolbar.redo')"
        [attr.title]="tip(t('toolbar.redo'), 'redo')"
        [disabled]="!store.canRedo()"
        (click)="registry.run('redo')"
      >
        <bm-icon name="redo" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group" role="group" [attr.aria-label]="t('toolbar.file')">
      <button type="button" class="bm-button" [attr.aria-label]="t('toolbar.export')" [attr.title]="t('toolbar.export')" (click)="registry.run('export.open')">
        <bm-icon name="export" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group bm-board-group" role="group" [attr.aria-label]="t('toolbar.boards')">
      @if (store.boardRenaming()) {
        <form class="bm-row bm-board-rename" (submit)="commitRename($event, renameInput.value)">
          <label class="visually-hidden" for="bm-board-rename">{{ t('boards.renameLabel') }}</label>
          <input
            #renameInput
            id="bm-board-rename"
            type="text"
            maxlength="200"
            [value]="store.doc().name"
            (keydown.escape)="cancelRename($event)"
            (blur)="commitRename($event, renameInput.value)"
          />
        </form>
      } @else {
        <button
          type="button"
          class="bm-button bm-board-btn"
          [attr.aria-label]="t('toolbar.boardsLabel', { name: store.doc().name })"
          [attr.title]="t('toolbar.boardsOpen')"
          (click)="openBoards.emit()"
        >
          <bm-icon name="boards" />
          <span class="bm-board-name">{{ store.doc().name }}</span>
        </button>
        <button
          type="button"
          class="bm-button"
          [attr.aria-label]="t('toolbar.rename')"
          [attr.title]="t('toolbar.rename')"
          [disabled]="store.readOnly()"
          (click)="store.boardRenaming.set(true)"
        >
          <bm-icon name="edit" />
        </button>
      }
    </div>
    <span class="bm-save-status" role="status" [attr.data-status]="session.status()">{{ statusText() }}</span>
    <button type="button" class="bm-button" [attr.aria-label]="t('toolbar.palette')" [attr.title]="tip(t('toolbar.paletteTip'), 'palette.open')" (click)="registry.run('palette.open')">
      <bm-icon name="command" />
    </button>
    <button type="button" class="bm-button" [attr.aria-label]="t('toolbar.settings')" [attr.title]="t('toolbar.settings')" (click)="registry.run('settings.open')">
      <bm-icon name="settings" />
    </button>

    <ng-template #shapeMenu>
      <div class="bm-menu bm-panel" cdkMenu>
        @for (s of shapes; track s.id) {
          <button
            type="button"
            class="bm-button"
            cdkMenuItemRadio
            [cdkMenuItemChecked]="store.newNodeKind() === 'topic' && store.newNodeShape() === s.id"
            (cdkMenuItemTriggered)="pickShape(s.id)"
          >
            <bm-icon [name]="'shape-' + s.id" /> {{ t(s.label) }}
          </button>
        }
        <button
          type="button"
          class="bm-button"
          cdkMenuItemRadio
          [cdkMenuItemChecked]="store.newNodeKind() === 'checklist'"
          (cdkMenuItemTriggered)="pickChecklist()"
        >
          <bm-icon name="checklist" /> {{ t('shape.checklist') }}
        </button>
      </div>
    </ng-template>
    <ng-template #layoutMenu>
      <div class="bm-menu bm-panel" cdkMenu>
        @for (d of directions; track d.id) {
          <button
            type="button"
            class="bm-button"
            cdkMenuItemRadio
            [cdkMenuItemChecked]="store.settings().direction === d.id"
            (cdkMenuItemTriggered)="setDirection(d.id)"
          >
            <bm-icon [name]="'layout-' + d.id" /> {{ t(d.label) }}
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class Toolbar {
  protected readonly t = t;
  protected readonly store = inject(EditorStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly session = inject(BoardSession);
  readonly openBoards = output<void>();
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  protected readonly menuPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'top', overlayX: 'start', overlayY: 'top', offsetX: 8 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 4 },
  ];

  protected readonly tools: ToolButton[] = [
    { id: 'pointer', label: 'tool.pointer', icon: 'pointer', command: 'tool.pointer' },
    { id: 'hand', label: 'tool.hand', icon: 'hand', command: 'tool.hand' },
    { id: 'node', label: 'tool.node', icon: 'node', command: 'tool.node' },
    { id: 'connect', label: 'tool.connect', icon: 'connect', command: 'tool.connect' },
  ];
  protected readonly shapes: { id: Shape; label: MessageKey }[] = [
    { id: 'none', label: 'shape.none' },
    { id: 'rectangle', label: 'shape.rectangle' },
    { id: 'rounded', label: 'shape.rounded' },
  ];
  protected readonly directions: { id: LayoutDirection; label: MessageKey }[] = [
    { id: 'horizontal', label: 'layout.horizontal' },
    { id: 'vertical', label: 'layout.vertical' },
    { id: 'balanced', label: 'layout.balanced' },
  ];

  protected readonly shapeLabel = computed(() =>
    this.store.newNodeKind() === 'checklist'
      ? t('shape.checklist')
      : t(`shape.${this.store.newNodeShape()}` as MessageKey),
  );
  protected readonly directionLabel = computed(() => t(`layout.${this.store.settings().direction}` as MessageKey));

  protected readonly statusText = computed(() => {
    switch (this.session.status()) {
      case 'saving':
        return t('status.saving');
      case 'saved':
        return this.store.readOnly() ? t('status.readOnly') : t('status.saved');
      case 'error':
        return t('status.error');
      default:
        return '';
    }
  });

  constructor() {
    // Focus the field as soon as it is rendered, whichever action asked for the rename.
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      if (input && this.store.boardRenaming()) {
        input.focus();
        input.select();
      }
    });
  }

  protected tip(label: string, command: string): string {
    const k = this.registry.shortcutFor(command);
    return k ? `${label} (${k})` : label;
  }

  protected async commitRename(e: Event, name: string): Promise<void> {
    e.preventDefault();
    if (!this.store.boardRenaming()) return;
    this.store.boardRenaming.set(false);
    const clean = name.trim();
    if (clean && clean !== this.store.doc().name) await this.session.rename(this.store.doc().id, clean);
  }

  protected cancelRename(e: Event): void {
    e.stopPropagation();
    this.store.boardRenaming.set(false);
  }

  protected pickShape(shape: Shape): void {
    this.store.newNodeKind.set('topic');
    this.store.newNodeShape.set(shape);
    this.store.setTool('node');
  }

  protected pickChecklist(): void {
    this.store.newNodeKind.set('checklist');
    this.store.setTool('node');
  }

  protected setDirection(d: LayoutDirection): void {
    this.store.updateSettings({ direction: d });
  }
}
