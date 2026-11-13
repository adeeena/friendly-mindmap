export const THEMES = ['system', 'light', 'dark', 'pale-rose'] as const;
/** Retained for existing account preferences, but no longer selectable in the app. */
export const LEGACY_THEMES = ['win98', 'cs3-gray'] as const;
export type ActiveThemePreference = typeof THEMES[number];
export type ThemePreference = ActiveThemePreference | typeof LEGACY_THEMES[number];
export const LANGUAGES = ['en', 'fr', 'hu'] as const;
export type LanguagePreference = typeof LANGUAGES[number];

export interface Preferences {
  theme?: ThemePreference;
  language?: LanguagePreference;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && [...THEMES, ...LEGACY_THEMES].some((theme) => theme === value);
}

export function isActiveThemePreference(value: unknown): value is ActiveThemePreference {
  return typeof value === 'string' && THEMES.some((theme) => theme === value);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === 'string' && LANGUAGES.some((language) => language === value);
}
