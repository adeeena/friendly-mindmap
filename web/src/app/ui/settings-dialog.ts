import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { APP_INFO } from '../app-info';
import { LANGUAGES, MessageKey, t } from '../i18n';
import { SettingsService, Theme } from '../settings.service';
import { Icon } from './icon';

type SettingsTab = 'appearance' | 'language';

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
          @for (item of tabs; track item.id) {
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
            <h3 class="bm-set-title">{{ t('theme.label') }}</h3>
            @for (o of themes; track o.id) {
              <label class="bm-choice">
                <input type="radio" name="bm-theme" [value]="o.id" [checked]="settings.theme() === o.id" (change)="settings.setTheme(o.id)" />
                <span>{{ t(o.label) }}</span>
              </label>
            }
          }
          @case ('language') {
            @for (l of languages; track l.id) {
              <label class="bm-choice">
                <input type="radio" name="bm-language" [value]="l.id" [checked]="settings.language() === l.id" (change)="settings.setLanguage(l.id)" />
                <span [attr.lang]="l.id">{{ l.label }}</span>
              </label>
            }
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
    { id: 'light', label: 'theme.light' },
    { id: 'dark', label: 'theme.dark' },
    { id: 'system', label: 'theme.system' },
  ];
  protected readonly tabs: { id: SettingsTab; label: MessageKey; icon: string }[] = [
    { id: 'appearance', label: 'settings.appearance', icon: 'appearance' },
    { id: 'language', label: 'settings.language', icon: 'language' },
  ];
  protected readonly tab = signal<SettingsTab>('appearance');
  protected readonly current = computed(() => this.tabs.find((x) => x.id === this.tab())!);

  protected onTabKey(e: KeyboardEvent): void {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = this.tabs.findIndex((x) => x.id === this.tab());
    const next = this.tabs[(i + step + this.tabs.length) % this.tabs.length];
    this.tab.set(next.id);
    setTimeout(() => document.getElementById('bm-set-tab-' + next.id)?.focus());
  }
}
