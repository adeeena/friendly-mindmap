import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { CdkMenu, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { LayoutDirection, Shape } from '../core/model';
import { CommandRegistry } from '../editor/commands';
import { EditorStore, ToolId } from '../editor/editor-store';
import { BoardSession } from '../persistence/board-session';
import { Icon } from './icon';

interface ToolButton {
  id: ToolId;
  label: string;
  icon: string;
  command: string;
}

@Component({
  selector: 'bm-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkMenu, CdkMenuItemRadio, CdkMenuTrigger],
  host: { class: 'bm-toolbar bm-panel', role: 'toolbar', 'aria-label': 'Editor tools' },
  template: `
    <div class="bm-tb-group" role="group" aria-label="Tools">
      @for (t of tools; track t.id) {
        <button
          type="button"
          class="bm-button"
          [attr.aria-pressed]="store.tool() === t.id"
          [attr.aria-label]="t.label"
          [attr.title]="tip(t.label, t.command)"
          (click)="registry.run(t.command)"
        >
          <bm-icon [name]="t.icon" />
        </button>
      }
      <button
        type="button"
        class="bm-button bm-split"
        [attr.aria-label]="'New node shape: ' + shapeLabel()"
        title="New node shape"
        [cdkMenuTriggerFor]="shapeMenu"
      >
        <bm-icon [name]="store.newNodeKind() === 'checklist' ? 'checklist' : 'shape-' + store.newNodeShape()" [size]="14" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group" role="group" aria-label="Layout">
      <button
        type="button"
        class="bm-button"
        aria-label="Snap to grid"
        [attr.aria-pressed]="store.settings().snap"
        [attr.title]="tip('Snap to grid', 'toggle.snap')"
        (click)="registry.run('toggle.snap')"
      >
        <bm-icon name="snap" />
      </button>
      <button
        type="button"
        class="bm-button"
        aria-label="Auto align"
        [attr.aria-pressed]="store.settings().autoAlign"
        [attr.title]="tip('Auto align', 'toggle.autoAlign')"
        (click)="registry.run('toggle.autoAlign')"
      >
        <bm-icon name="align" />
      </button>
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="'Layout direction: ' + store.settings().direction"
        [attr.title]="tip('Layout direction', 'layout.cycle')"
        [cdkMenuTriggerFor]="layoutMenu"
      >
        <bm-icon [name]="'layout-' + store.settings().direction" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group" role="group" aria-label="History">
      <button
        type="button"
        class="bm-button"
        aria-label="Undo"
        [attr.title]="tip('Undo', 'undo')"
        [disabled]="!store.canUndo()"
        (click)="registry.run('undo')"
      >
        <bm-icon name="undo" />
      </button>
      <button
        type="button"
        class="bm-button"
        aria-label="Redo"
        [attr.title]="tip('Redo', 'redo')"
        [disabled]="!store.canRedo()"
        (click)="registry.run('redo')"
      >
        <bm-icon name="redo" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <div class="bm-tb-group" role="group" aria-label="File">
      <button type="button" class="bm-button" aria-label="Save to file" [attr.title]="tip('Save', 'file.save')" (click)="registry.run('file.save')">
        <bm-icon name="save" />
      </button>
      <button type="button" class="bm-button" aria-label="Load from file" [attr.title]="tip('Load', 'file.load')" (click)="registry.run('file.load')">
        <bm-icon name="load" />
      </button>
      <button type="button" class="bm-button" aria-label="Export" title="Export" (click)="registry.run('export.open')">
        <bm-icon name="export" />
      </button>
    </div>
    <span class="bm-tb-sep" aria-hidden="true"></span>
    <button
      type="button"
      class="bm-button bm-board-btn"
      [attr.aria-label]="'Boards. Current board: ' + store.doc().name"
      title="Boards"
      (click)="openBoards.emit()"
    >
      <bm-icon name="boards" />
      <span class="bm-board-name">{{ store.doc().name }}</span>
    </button>
    <span class="bm-save-status" role="status" [attr.data-status]="session.status()">{{ statusText() }}</span>
    <button type="button" class="bm-button" aria-label="Command palette" [attr.title]="tip('Commands', 'palette.open')" (click)="registry.run('palette.open')">
      <bm-icon name="search" />
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
            <bm-icon [name]="'shape-' + s.id" /> {{ s.label }}
          </button>
        }
        <button
          type="button"
          class="bm-button"
          cdkMenuItemRadio
          [cdkMenuItemChecked]="store.newNodeKind() === 'checklist'"
          (cdkMenuItemTriggered)="pickChecklist()"
        >
          <bm-icon name="checklist" /> Checklist
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
            <bm-icon [name]="'layout-' + d.id" /> {{ d.label }}
          </button>
        }
      </div>
    </ng-template>
  `,
})
export class Toolbar {
  protected readonly store = inject(EditorStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly session = inject(BoardSession);
  readonly openBoards = output<void>();

  protected readonly tools: ToolButton[] = [
    { id: 'pointer', label: 'Pointer', icon: 'pointer', command: 'tool.pointer' },
    { id: 'hand', label: 'Hand', icon: 'hand', command: 'tool.hand' },
    { id: 'node', label: 'New node', icon: 'node', command: 'tool.node' },
    { id: 'connect', label: 'New connection', icon: 'connect', command: 'tool.connect' },
  ];
  protected readonly shapes: { id: Shape; label: string }[] = [
    { id: 'none', label: 'Text only' },
    { id: 'rectangle', label: 'Rectangle' },
    { id: 'rounded', label: 'Rounded' },
  ];
  protected readonly directions: { id: LayoutDirection; label: string }[] = [
    { id: 'horizontal', label: 'Horizontal' },
    { id: 'vertical', label: 'Vertical' },
    { id: 'balanced', label: 'Balanced' },
  ];

  protected readonly shapeLabel = computed(() =>
    this.store.newNodeKind() === 'checklist'
      ? 'Checklist'
      : (this.shapes.find((s) => s.id === this.store.newNodeShape())?.label ?? ''),
  );

  protected readonly statusText = computed(() => {
    switch (this.session.status()) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return this.store.readOnly() ? 'Read-only' : 'Saved';
      case 'error':
        return 'Not saved';
      default:
        return '';
    }
  });

  protected tip(label: string, command: string): string {
    const k = this.registry.shortcutFor(command);
    return k ? `${label} (${k})` : label;
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
