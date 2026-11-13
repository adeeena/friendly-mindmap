import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { BoardSummary } from '../core/model';
import { EditorStore } from '../editor/editor-store';
import { CommandRegistry } from '../editor/commands';
import { language, t } from '../i18n';
import { BoardSession } from '../persistence/board-session';
import { WorkspaceSession } from '../persistence/workspace-session';
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
      <button type="button" class="bm-button" cdkFocusInitial (click)="ref.close(false)">{{ t('common.cancel') }}</button>
      <button type="button" class="bm-button bm-primary" [class.bm-danger]="data.danger" (click)="ref.close(true)">
        {{ data.confirm }}
      </button>
    </div>
  `,
})
export class ConfirmDialog {
  protected readonly t = t;
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
    <div class="bm-bd-head">
      <div class="bm-bd-title">
        <bm-icon name="boards" [size]="18" />
        <h2 id="bm-boards-title">{{ t('boards.title') }}</h2>
      </div>
      <button type="button" class="bm-button" [attr.aria-label]="t('common.close')" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    @if (duplicateFailed()) {
      <p class="bm-error" role="alert">{{ t('boards.duplicateFailed') }}</p>
    }
    <form class="bm-bd-new" (submit)="create($event)">
      <label class="visually-hidden" for="bm-new-board">{{ t('boards.newName') }}</label>
      <input id="bm-new-board" #newName type="text" [attr.placeholder]="t('boards.newName')" cdkFocusInitial maxlength="200" />
      <button type="submit" class="bm-button bm-primary"><bm-icon name="plus" /> {{ t('boards.create') }}</button>
    </form>
    <ul class="bm-bd-list" [attr.aria-label]="t('boards.all')">
      @for (b of session.boards(); track b.id) {
        <li class="bm-bd-item" [class.current]="b.id === store.doc().id">
          @if (renaming() === b.id) {
            <form class="bm-bd-rename" (submit)="rename($event, b, nameInput.value)">
              <label class="visually-hidden" [attr.for]="'bm-rename-' + b.id">{{ t('boards.name') }}</label>
              <input #nameInput [id]="'bm-rename-' + b.id" type="text" [value]="b.name" maxlength="200" (keydown.escape)="cancelRename($event)" />
              <button type="submit" class="bm-button bm-primary" [attr.aria-label]="t('common.save')" [attr.title]="t('common.save')"><bm-icon name="check" /></button>
              <button type="button" class="bm-button" [attr.aria-label]="t('common.cancel')" [attr.title]="t('common.cancel')" (click)="cancelRename($event)"><bm-icon name="close" /></button>
            </form>
          } @else {
            <button type="button" class="bm-board-open" (click)="open(b)" [attr.aria-current]="b.id === store.doc().id ? 'true' : null">
              <span class="bm-bd-mark" aria-hidden="true">
                @if (b.id === store.doc().id) {
                  <bm-icon name="check" [size]="14" />
                }
              </span>
              <span class="bm-bd-text">
                <span class="bm-board-title">{{ b.name }}</span>
                <span class="bm-muted">{{ when(b.updatedAt) }}</span>
              </span>
            </button>
            <div class="bm-bd-actions">
              <button type="button" class="bm-button" [attr.aria-label]="t('boards.rename', { name: b.name })" [attr.title]="t('toolbar.rename')" (click)="startRename(b)"><bm-icon name="edit" /></button>
              <button type="button" class="bm-button" [attr.aria-label]="t('boards.duplicate', { name: b.name })" [attr.title]="t('cmd.duplicate')" (click)="duplicate(b)"><bm-icon name="copy" /></button>
              <button type="button" class="bm-button" [attr.aria-label]="t('boards.delete', { name: b.name })" [attr.title]="t('common.delete')" (click)="remove(b)"><bm-icon name="trash" /></button>
            </div>
          }
        </li>
      }
    </ul>
    @if (!workspace.account()) {
      <p class="bm-muted bm-cloud-notice">{{ t('auth.notice') }}</p>
    }
    <div class="bm-bd-foot">
      <button type="button" class="bm-button" (click)="saveWorkspace()"><bm-icon name="save" /> {{ t('boards.saveChanges') }}</button>
      <button type="button" class="bm-button" (click)="file('file.save')"><bm-icon name="save" /> {{ t('toolbar.save') }}</button>
      <button type="button" class="bm-button" (click)="file('file.load')"><bm-icon name="load" /> {{ t('toolbar.load') }}</button>
      @if (workspace.account()) {
        <button type="button" class="bm-button" (click)="history()"><bm-icon name="undo" /> {{ t('history.title') }}</button>
      }
    </div>
  `,
})
export class BoardSwitcher {
  protected readonly t = t;
  protected readonly session = inject(BoardSession);
  protected readonly workspace = inject(WorkspaceSession);
  protected readonly store = inject(EditorStore);
  protected readonly ref = inject(DialogRef);
  private readonly registry = inject(CommandRegistry);
  private readonly dialog = inject(Dialog);
  protected readonly renaming = signal<string | null>(null);
  protected readonly duplicateFailed = signal(false);

  protected history(): void {
    this.registry.run('history.open');
  }

  /** Runs a file command while the click still counts as a user gesture (the file picker needs it). */
  protected file(command: 'file.save' | 'file.load'): void {
    this.registry.run(command);
    this.ref.close();
  }

  protected saveWorkspace(): void {
    this.registry.run('workspace.save');
    this.ref.close();
  }

  protected when(ms: number): string {
    return new Intl.DateTimeFormat(language(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  }

  protected async create(e: Event): Promise<void> {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector('input')!;
    await this.session.create(input.value.trim() || t('board.untitled'));
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
    this.duplicateFailed.set(false);
    try { await this.session.duplicate(b.id); }
    catch { this.duplicateFailed.set(true); }
  }

  protected async remove(b: BoardSummary): Promise<void> {
    const ok = await confirmDialog(this.dialog, {
      title: t('boards.deleteTitle'),
      message: t('boards.deleteMessage', { name: b.name }),
      confirm: t('common.delete'),
      danger: true,
    });
    if (ok) await this.session.remove(b.id);
  }
}
