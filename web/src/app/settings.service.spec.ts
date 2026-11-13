import { TestBed } from '@angular/core/testing';
import { APP_INFO } from './app-info';
import { setLanguage } from './i18n';
import { PAINT_STORAGE_KEY, SETTINGS_STORAGE_KEY, SettingsService, THEMES } from './settings.service';
import pkg from '../../package.json';

interface FakeQuery {
  matches: boolean;
  listeners: ((e: { matches: boolean }) => void)[];
  addEventListener: (type: string, fn: (e: { matches: boolean }) => void) => void;
}

function stubMatchMedia(dark: boolean): FakeQuery {
  const query: FakeQuery = {
    matches: dark,
    listeners: [],
    addEventListener: (_t, fn) => query.listeners.push(fn),
  };
  window.matchMedia = jest.fn().mockReturnValue(query) as unknown as typeof window.matchMedia;
  return query;
}

describe('SettingsService', () => {
  const original = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
    stubMatchMedia(false);
  });

  afterEach(() => {
    window.matchMedia = original;
    localStorage.clear();
    setLanguage('en');
  });

  const fresh = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(SettingsService);
  };

  it('defaults to the system theme and English', () => {
    const s = fresh();
    expect(s.theme()).toBe('system');
    expect(s.language()).toBe('en');
    expect(s.resolvedTheme()).toBe('light');
  });

  it('persists theme and language across a reload', () => {
    const s = fresh();
    s.setTheme('dark');
    s.setLanguage('hu');
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual({ theme: 'dark', language: 'hu' });

    setLanguage('en');
    const reloaded = fresh();
    expect(reloaded.theme()).toBe('dark');
    expect(reloaded.language()).toBe('hu');
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'neon', language: 'de' }));
    const s = fresh();
    expect(s.theme()).toBe('system');
    expect(s.language()).toBe('en');
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(fresh().theme()).toBe('system');
  });

  it('follows OS theme changes only while System is selected', () => {
    const query = stubMatchMedia(false);
    const s = fresh();
    expect(s.resolvedTheme()).toBe('light');
    query.listeners.forEach((l) => l({ matches: true }));
    expect(s.resolvedTheme()).toBe('dark');

    s.setTheme('light');
    expect(s.resolvedTheme()).toBe('light');
    query.listeners.forEach((l) => l({ matches: false }));
    query.listeners.forEach((l) => l({ matches: true }));
    expect(s.resolvedTheme()).toBe('light');

    s.setTheme('system');
    expect(s.resolvedTheme()).toBe('dark');
  });

  it('applies the resolved theme and language to the document', () => {
    stubMatchMedia(true);
    const s = fresh();
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    s.setTheme('light');
    s.setLanguage('fr');
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('supports active themes and keeps retired choices out of the selectable list', () => {
    const query = stubMatchMedia(false);
    const s = fresh();
    s.setTheme('pale-rose');
    TestBed.tick();
    expect(s.resolvedTheme()).toBe('pale-rose');
    expect(document.documentElement.dataset['theme']).toBe('pale-rose');
    expect(document.documentElement.style.colorScheme).toBe('light');
    query.listeners.forEach((l) => l({ matches: true }));
    expect(s.resolvedTheme()).toBe('pale-rose');
    query.listeners.forEach((l) => l({ matches: false }));
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).theme).toBe('pale-rose');
    expect(localStorage.getItem(PAINT_STORAGE_KEY)).toBe('pale-rose');
    expect(Array.from(THEMES)).toEqual(['system', 'light', 'dark', 'pale-rose']);
  });

  it('falls back to System for retired themes in guest preferences', () => {
    for (const theme of ['win98', 'cs3-gray']) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme }));
      expect(fresh().theme()).toBe('system');
    }
  });

  it('keeps account choices out of guest storage and restores guest values on logout', () => {
    const s = fresh();
    s.setTheme('dark');
    s.setLanguage('hu');
    const changes: unknown[] = [];
    s.useAccount({ theme: 'pale-rose' }, (change) => changes.push(change));
    expect(s.theme()).toBe('pale-rose');
    s.setTheme('light');
    s.setLanguage('fr');
    expect(changes).toEqual([{ theme: 'light' }, { language: 'fr' }]);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toEqual({ theme: 'dark', language: 'hu' });
    s.applyAccountValues({ theme: 'cs3-gray', language: 'en' });
    expect(s.theme()).toBe('system');
    s.useGuest();
    expect(s.theme()).toBe('dark');
    expect(s.language()).toBe('hu');
    s.applyAccountValues({ theme: 'light' });
    expect(s.theme()).toBe('dark');
  });
});

describe('APP_INFO', () => {
  it('holds the configurable name, the package version and the homepage', () => {
    expect(APP_INFO.name).toBe('Friendly Mindmap');
    expect(APP_INFO.version).toBe(pkg.version);
    expect(APP_INFO.homepage).toBe('https://adena.dev');
  });
});
