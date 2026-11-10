import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Language, isLanguage, language, setLanguage } from './i18n';

export type Theme = 'system' | 'light' | 'dark';

export const SETTINGS_STORAGE_KEY = 'friendly-mindmap.settings';

interface Stored {
  theme?: Theme;
  language?: Language;
}

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
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

/** App-wide preferences (theme, language), kept in the browser and independent of any board. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly document = inject(DOCUMENT);
  private readonly themeChoice = signal<Theme>('system');
  private readonly systemDark = signal(false);

  readonly theme = this.themeChoice.asReadonly();
  readonly language = language;
  readonly resolvedTheme = computed<'light' | 'dark'>(() => {
    const choice = this.themeChoice();
    if (choice === 'system') return this.systemDark() ? 'dark' : 'light';
    return choice;
  });

  constructor() {
    const stored = readStored();
    if (isTheme(stored.theme)) this.themeChoice.set(stored.theme);
    setLanguage(isLanguage(stored.language) ? stored.language : browserLanguage());
    this.followSystem();

    effect(() => {
      const root = this.document.documentElement;
      const resolved = this.resolvedTheme();
      root.dataset['theme'] = resolved;
      root.style.colorScheme = resolved;
    });
    effect(() => {
      this.document.documentElement.lang = this.language();
    });
  }

  setTheme(theme: Theme): void {
    this.themeChoice.set(theme);
    this.save();
  }

  setLanguage(next: Language): void {
    setLanguage(next);
    this.save();
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
