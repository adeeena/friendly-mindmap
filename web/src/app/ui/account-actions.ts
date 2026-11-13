import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { t } from '../i18n';
import { BoardSession } from '../persistence/board-session';
import { WorkspaceSession } from '../persistence/workspace-session';
import { Icon } from './icon';
import { Toaster } from './editor-actions';

@Component({
  selector: 'bm-login-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Icon],
  host: { class: 'bm-dialog bm-panel bm-login-dialog' },
  template: `
    <h2 id="bm-login-title" class="bm-login-title">
      <span class="bm-login-mark"><bm-icon name="cloud" [size]="22" /></span>
      <span>{{ t('auth.login') }}</span>
    </h2>
    <p class="bm-login-notice">{{ t('auth.notice') }}</p>
    <form class="bm-login-form" [formGroup]="form" (ngSubmit)="submit()">
      <div class="bm-login-fields">
        <label class="bm-login-field">
          <span>{{ t('auth.username') }}</span>
          <input id="bm-login-username" type="text" autocomplete="username" formControlName="username" maxlength="128" cdkFocusInitial />
        </label>
        <label class="bm-login-field">
          <span>{{ t('auth.password') }}</span>
          <input id="bm-login-password" type="password" autocomplete="current-password" formControlName="password" maxlength="1024" />
        </label>
      </div>
      <div class="bm-dialog-actions">
        <button type="button" class="bm-button" [disabled]="workspace.busy()" (click)="ref.close()">{{ t('common.cancel') }}</button>
        <button type="submit" class="bm-button bm-primary" [disabled]="workspace.busy() || form.invalid">{{ t('auth.login') }}</button>
      </div>
    </form>
  `,
})
export class LoginDialog {
  protected readonly t = t;
  protected readonly ref = inject(DialogRef);
  protected readonly workspace = inject(WorkspaceSession);
  private readonly toaster = inject(Toaster);
  protected readonly form = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(128)] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(1024)] }),
  });

  protected async submit(): Promise<void> {
    if (this.form.invalid || this.workspace.busy()) return;
    const { username, password } = this.form.getRawValue();
    this.form.controls.password.reset();
    if (await this.workspace.login(username, password)) {
      this.ref.close();
      return;
    }
    const error = this.workspace.error();
    if (error) {
      this.workspace.error.set(null);
      this.toaster.show(t(error), 'error', 7000);
    }
  }
}

@Component({
  selector: 'bm-account-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-account-actions', role: 'group', '[attr.aria-label]': "t('auth.account')" },
  template: `
    @if (saveInProgress()) {
      <span class="bm-account-save-progress" aria-hidden="true"><span class="bm-save-spinner"></span></span>
    }
    <span class="visually-hidden" role="status" aria-live="polite">{{ saveStatusLabel() }}</span>
    @if (workspace.account(); as account) {
      <div class="bm-account-identity">
        <span class="bm-account-avatar" aria-hidden="true">{{ account.display_name.slice(0, 1).toUpperCase() }}</span>
        <span class="bm-account-name">{{ account.display_name }}</span>
      </div>
      <button type="button" class="bm-button bm-account-logout" [attr.aria-label]="t('auth.logout')" [disabled]="workspace.busy()" (click)="workspace.logout()">
        <bm-icon name="logout" />
      </button>
      @if (workspace.syncState() !== 'idle') {
        <span class="visually-hidden" role="status">{{ t('auth.localPending') }}</span>
      }
      @if (!workspace.verified()) {
        <button type="button" class="bm-button bm-account-login bm-primary" [disabled]="workspace.busy()" (click)="login()">
          {{ t('auth.login') }}
        </button>
      }
    } @else {
      <button type="button" class="bm-button bm-account-login bm-primary" [disabled]="workspace.busy()" (click)="login()">
        {{ t('auth.login') }}
      </button>
    }
  `,
})
export class AccountActions {
  protected readonly t = t;
  protected readonly workspace = inject(WorkspaceSession);
  private readonly session = inject(BoardSession);
  private readonly dialog = inject(Dialog);
  protected readonly saveInProgress = computed(() =>
    this.session.status() === 'saving' ||
    (this.workspace.account() !== null && this.workspace.syncState() === 'syncing'),
  );
  protected readonly saveStatusLabel = computed(() => {
    if (this.session.status() === 'saving') return t('status.saving');
    if (this.workspace.account() && this.workspace.syncState() === 'syncing') return t('sync.active');
    return '';
  });

  protected login(): void {
    this.workspace.error.set(null);
    this.dialog.open(LoginDialog, { ariaLabelledBy: 'bm-login-title' });
  }
}
