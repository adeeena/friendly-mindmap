import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { BoardSummary } from '../core/model';
import { EditorStore } from '../editor/editor-store';
import { BoardSession } from '../persistence/board-session';
import { Icon } from './icon';

export interface ConfirmData {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
}

@Component({
  selector: 'bm-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bm-dialog bm-panel' },
  template: `
    <h2 id="bm-confirm-title">{{ data.title }}</h2>
    <p id="bm-confirm-msg">{{ data.message }}</p>
    <div class="bm-dialog-actions">
      <button type="button" class="bm-button" cdkFocusInitial (click)="ref.close(false)">Cancel</button>
      <button type="button" class="bm-button bm-primary" [class.bm-danger]="data.danger" (click)="ref.close(true)">
        {{ data.confirm }}
      </button>
    </div>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<boolean>>(DialogRef);
}

export function confirmDialog(dialog: Dialog, data: ConfirmData): Promise<boolean> {
  const ref = dialog.open<boolean>(ConfirmDialog, {
    data,
    role: 'alertdialog',
    ariaLabelledBy: 'bm-confirm-title',
    ariaDescribedBy: 'bm-confirm-msg',
  });
  return new Promise((resolve) => ref.closed.subscribe((v) => resolve(!!v)));
}

@Component({
  selector: 'bm-board-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-dialog bm-panel bm-boards' },
  template: `
    <div class="bm-dialog-head">
      <h2 id="bm-boards-title">Boards</h2>
      <button type="button" class="bm-button" aria-label="Close" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    <form class="bm-row" (submit)="create($event)">
      <label class="visually-hidden" for="bm-new-board">New board name</label>
      <input id="bm-new-board" #newName type="text" placeholder="New board name" cdkFocusInitial maxlength="200" />
      <button type="submit" class="bm-button bm-primary"><bm-icon name="plus" /> Create</button>
    </form>
    <ul class="bm-board-list" aria-label="All boards">
      @for (b of session.boards(); track b.id) {
        <li [class.current]="b.id === store.doc().id">
          @if (renaming() === b.id) {
            <form class="bm-row bm-grow" (submit)="rename($event, b, nameInput.value)">
              <label class="visually-hidden" [attr.for]="'bm-rename-' + b.id">Board name</label>
              <input #nameInput [id]="'bm-rename-' + b.id" type="text" [value]="b.name" maxlength="200" (keydown.escape)="cancelRename($event)" />
              <button type="submit" class="bm-button">Save</button>
            </form>
          } @else {
            <button type="button" class="bm-board-open" (click)="open(b)" [attr.aria-current]="b.id === store.doc().id ? 'true' : null">
              <span class="bm-board-title">{{ b.name }}</span>
              <span class="bm-muted">{{ when(b.updatedAt) }}</span>
            </button>
            <button type="button" class="bm-button" [attr.aria-label]="'Rename ' + b.name" (click)="startRename(b)"><bm-icon name="edit" /></button>
            <button type="button" class="bm-button" [attr.aria-label]="'Duplicate ' + b.name" (click)="duplicate(b)"><bm-icon name="copy" /></button>
            <button type="button" class="bm-button" [attr.aria-label]="'Delete ' + b.name" (click)="remove(b)"><bm-icon name="trash" /></button>
          }
        </li>
      }
    </ul>
  `,
})
export class BoardSwitcher {
  protected readonly session = inject(BoardSession);
  protected readonly store = inject(EditorStore);
  protected readonly ref = inject(DialogRef);
  private readonly dialog = inject(Dialog);
  protected readonly renaming = signal<string | null>(null);

  protected when(t: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(t);
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector('input')!;
    await this.session.create(input.value.trim() || 'Untitled board');
    this.ref.close();
  }

  protected async open(b: BoardSummary): Promise<void> {
    await this.session.open(b.id);
    this.ref.close();
  }

  protected startRename(b: BoardSummary): void {
    this.renaming.set(b.id);
    setTimeout(() => document.getElementById('bm-rename-' + b.id)?.focus());
  }

  protected cancelRename(e: Event): void {
    e.stopPropagation();
    this.renaming.set(null);
  }

  protected async rename(e: Event, b: BoardSummary, name: string): Promise<void> {
    e.preventDefault();
    await this.session.rename(b.id, name);
    this.renaming.set(null);
  }

  protected async duplicate(b: BoardSummary): Promise<void> {
    await this.session.duplicate(b.id);
  }

  protected async remove(b: BoardSummary): Promise<void> {
    const ok = await confirmDialog(this.dialog, {
      title: 'Delete board?',
      message: `“${b.name}” and its attachments will be permanently deleted from this device.`,
      confirm: 'Delete',
      danger: true,
    });
    if (ok) await this.session.remove(b.id);
  }
}
