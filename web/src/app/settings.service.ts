import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  Preferences as StoredPreferences,
  ThemePreference,
  ActiveThemePreference,
  THEMES,
  isActiveThemePreference,
} from '../../../shared/preferences';
import { Language, isLanguage, language, setLanguage } from './i18n';

export type Theme = ActiveThemePreference;
export type ResolvedTheme = Exclude<Theme, 'system'>;
export { THEMES, isActiveThemePreference as isTheme };

export const SETTINGS_STORAGE_KEY = 'friendly-mindmap.settings';
/** Effective choice remembered only so index.html can paint the right theme before Angular starts. */
export const PAINT_STORAGE_KEY = 'friendly-mindmap.paint-theme';

interface Stored {
  theme?: ThemePreference;
  language?: Language;
}

export interface PreferenceChanges {
  theme?: Theme;
  language?: Language;
}

function readStored(): Stored {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/** The language the browser asks for, when the app has it. */
function browserLanguage(): Language {
  const preferred = typeof navigator === 'undefined' ? '' : (navigator.language ?? '').slice(0, 2).toLowerCase();
  return isLanguage(preferred) ? preferred : 'en';
}

/**
 * App-wide preferences (theme, language). Guests keep them in this browser; a logged-in account
 * uses its own synchronized configuration and never writes the guest values.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly document = inject(DOCUMENT);
  private readonly themeChoice = signal<Theme>('system');
  private readonly systemDark = signal(false);
  private accountChange: ((changes: PreferenceChanges) => void) | null = null;

  readonly theme = this.themeChoice.asReadonly();
  readonly language = language;
  readonly resolvedTheme = computed<ResolvedTheme>(() => {
    const choice = this.themeChoice();
    if (choice === 'system') return this.systemDark() ? 'dark' : 'light';
    return choice;
  });

  constructor() {
    this.applyGuest();
    this.followSystem();

    effect(() => {
      const root = this.document.documentElement;
      const resolved = this.resolvedTheme();
      root.dataset['theme'] = resolved;
      root.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
    });
    effect(() => {
      this.document.documentElement.lang = this.language();
    });
    effect(() => {
      const choice = this.themeChoice();
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(PAINT_STORAGE_KEY, choice); }
      catch { /* first paint falls back to the guest value */ }
    });
  }

  private applyGuest(): void {
    const stored = readStored();
    this.themeChoice.set(isActiveThemePreference(stored.theme) ? stored.theme : 'system');
    setLanguage(isLanguage(stored.language) ? stored.language : browserLanguage());
  }

  /** Switches to account preferences; `change` receives only the fields the user edits. */
  useAccount(values: StoredPreferences, change: (changes: PreferenceChanges) => void): void {
    this.accountChange = change;
    this.applyValues(values);
  }

  /** Applies values received from the account (cache, another tab or device). */
  applyAccountValues(values: StoredPreferences): void {
    if (this.accountChange) this.applyValues(values);
  }

  /** Returns to this browser's guest preferences, untouched by any account choices. */
  useGuest(): void {
    this.accountChange = null;
    this.applyGuest();
  }

  private applyValues(values: StoredPreferences): void {
    if ('theme' in values) this.themeChoice.set(isActiveThemePreference(values.theme) ? values.theme : 'system');
    if (isLanguage(values.language)) setLanguage(values.language);
  }

  setTheme(theme: Theme): void {
    this.themeChoice.set(theme);
    if (this.accountChange) this.accountChange({ theme });
    else this.save();
  }

  setLanguage(next: Language): void {
    setLanguage(next);
    if (this.accountChange) this.accountChange({ language: next });
    else this.save();
  }

  private followSystem(): void {
    const view = this.document.defaultView;
    if (!view || typeof view.matchMedia !== 'function') return;
    const query = view.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark.set(query.matches);
    query.addEventListener?.('change', (e) => this.systemDark.set(e.matches));
  }

  private save(): void {
    try {
      const stored: Stored = { theme: this.themeChoice(), language: this.language() };
      if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Private mode or full storage: choices last for this visit only.
    }
  }
}
