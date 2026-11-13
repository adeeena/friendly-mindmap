import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { APP_INFO } from '../app-info';
import { LANGUAGES, MessageKey, t } from '../i18n';
import { WorkspaceSession } from '../persistence/workspace-session';
import { SettingsService, Theme, isTheme } from '../settings.service';
import { confirmDialog } from './board-dialogs';
import { Toaster } from './editor-actions';
import { Icon } from './icon';

type SettingsTab = 'appearance' | 'language' | 'cloud';

interface CachedRow {
  id: string;
  name: string;
  username: string;
  pending: number;
  boards: number;
  active: boolean;
}

/** Two-pane settings dialog: brand and tab list on the left, the open tab on the right, credit footer below. */
@Component({
  selector: 'bm-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-dialog bm-panel bm-settings' },
  template: `
    <div class="bm-set-header">
      <div class="bm-set-brand">
        <bm-icon name="settings" [size]="16" />
        <span id="bm-settings-title">{{ t('settings.title') }}</span>
      </div>
      <div class="bm-set-heading">
        <h2>{{ t(current().label) }}</h2>
        <button type="button" class="bm-button bm-set-close" [attr.aria-label]="t('common.close')" (click)="ref.close()">
          <bm-icon name="close" />
        </button>
      </div>
    </div>
    <div class="bm-set-body">
      <div class="bm-set-side">
        <div role="tablist" aria-orientation="vertical" [attr.aria-label]="t('settings.title')" (keydown)="onTabKey($event)">
          @for (item of tabs(); track item.id) {
            <button
              type="button"
              role="tab"
              class="bm-set-tab"
              [id]="'bm-set-tab-' + item.id"
              [attr.aria-selected]="tab() === item.id"
              aria-controls="bm-set-panel"
              [attr.tabindex]="tab() === item.id ? 0 : -1"
              (click)="tab.set(item.id)"
            >
              <bm-icon [name]="item.icon" [size]="16" />
              <span>{{ t(item.label) }}</span>
            </button>
          }
        </div>
        <span class="bm-set-version">{{ t('settings.version') }} {{ app.version }}</span>
      </div>
      <section id="bm-set-panel" class="bm-set-panel" role="tabpanel" [attr.aria-labelledby]="'bm-set-tab-' + tab()">
        @switch (tab()) {
          @case ('appearance') {
            <label class="bm-set-title" for="bm-theme-select">{{ t('theme.label') }}</label>
            <select id="bm-theme-select" class="bm-select" (change)="onTheme($event)">
              @for (o of themes; track o.id) {
                <option [value]="o.id" [selected]="settings.theme() === o.id">{{ t(o.label) }}</option>
              }
            </select>
          }
          @case ('language') {
            @for (l of languages; track l.id) {
              <label class="bm-choice">
                <input type="radio" name="bm-language" [value]="l.id" [checked]="settings.language() === l.id" (change)="settings.setLanguage(l.id)" />
                <span [attr.lang]="l.id">{{ l.label }}</span>
              </label>
            }
          }
          @case ('cloud') {
            <p class="bm-muted">{{ t('cloudData.intro') }}</p>
            <ul class="bm-cache-list" [attr.aria-label]="t('cloudData.list')">
              @for (row of rows(); track row.id) {
                <li class="bm-cache-row">
                  <span class="bm-cache-name">{{ row.name }} <span class="bm-muted">({{ row.username }})</span></span>
                  <span class="bm-muted">{{ t('cloudData.summary', { boards: row.boards, pending: row.pending }) }}</span>
                  <button type="button" class="bm-button bm-danger" [disabled]="row.active" (click)="discard(row)">
                    <bm-icon name="trash" /> {{ t('cloudData.discard') }}
                  </button>
                  @if (row.active) { <span class="bm-muted">{{ t('cloudData.logoutFirst') }}</span> }
                </li>
              }
            </ul>
          }
        }
      </section>
    </div>
    <div class="bm-set-footer">
      <span class="bm-set-made">{{ t('footer.madeBy') }}</span>
      <a class="bm-set-author" [href]="app.homepage" target="_blank" rel="noopener">
        {{ app.author }}
        <bm-icon name="external" [size]="11" />
      </a>
    </div>
  `,
})
export class SettingsDialog {
  protected readonly t = t;
  protected readonly ref = inject(DialogRef);
  protected readonly settings = inject(SettingsService);
  protected readonly app = APP_INFO;
  protected readonly languages = LANGUAGES;
  protected readonly themes: { id: Theme; label: MessageKey }[] = [
    { id: 'system', label: 'theme.system' },
    { id: 'light', label: 'theme.light' },
    { id: 'dark', label: 'theme.dark' },
    { id: 'pale-rose', label: 'theme.paleRose' },
  ];
  protected readonly tabs = computed<{ id: SettingsTab; label: MessageKey; icon: string }[]>(() => [
    { id: 'appearance', label: 'settings.appearance', icon: 'appearance' },
    { id: 'language', label: 'settings.language', icon: 'language' },
    ...(this.rows().length ? [{ id: 'cloud' as const, label: 'settings.cloudData' as const, icon: 'boards' }] : []),
  ]);
  protected readonly tab = signal<SettingsTab>('appearance');
  protected readonly current = computed(() => this.tabs().find((x) => x.id === this.tab()) ?? this.tabs()[0]);
  private readonly workspace = inject(WorkspaceSession);
  private readonly dialog = inject(Dialog);
  private readonly toaster = inject(Toaster);
  protected readonly rows = signal<CachedRow[]>([]);

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const activeId = this.workspace.account()?.id;
    const rows: CachedRow[] = [];
    for (const account of this.workspace.cachedAccounts()) {
      let summary = { pending: 0, boards: 0 };
      try { summary = await this.workspace.cacheSummary(account.id); } catch { /* shown as empty */ }
      rows.push({ id: account.id, name: account.display_name, username: account.username, active: account.id === activeId, ...summary });
    }
    this.rows.set(rows);
  }

  protected async discard(row: CachedRow): Promise<void> {
    const ok = await confirmDialog(this.dialog, {
      title: t('cloudData.confirmTitle'),
      message: t(row.pending > 0 ? 'cloudData.confirmUnsynced' : 'cloudData.confirmMessage', { name: row.name, pending: row.pending }),
      confirm: t('cloudData.discard'),
      danger: true,
    });
    if (!ok) return;
    if (await this.workspace.discardCachedAccount(row.id)) this.toaster.show(t('cloudData.discarded', { name: row.name }));
    await this.refresh();
    if (!this.rows().length) this.tab.set('appearance');
  }

  protected onTheme(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    if (isTheme(value)) this.settings.setTheme(value);
  }

  protected onTabKey(e: KeyboardEvent): void {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const tabs = this.tabs();
    const i = tabs.findIndex((x) => x.id === this.tab());
    const next = tabs[(i + step + tabs.length) % tabs.length];
    this.tab.set(next.id);
    setTimeout(() => document.getElementById('bm-set-tab-' + next.id)?.focus());
  }
}
