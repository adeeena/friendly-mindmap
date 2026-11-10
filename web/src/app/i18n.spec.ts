import { DICTIONARIES, LANGUAGES, MessageKey, setLanguage, t, tm } from './i18n';

const keys = Object.keys(DICTIONARIES.en) as MessageKey[];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  afterEach(() => setLanguage('en'));

  it('offers English, French and Hungarian', () => {
    expect(LANGUAGES.map((l) => l.id)).toEqual(['en', 'fr', 'hu']);
  });

  it.each(['fr', 'hu'] as const)('%s defines exactly the English keys', (lang) => {
    expect(Object.keys(DICTIONARIES[lang]).sort()).toEqual([...keys].sort());
  });

  it.each(['en', 'fr', 'hu'] as const)('%s has no empty text and keeps the same placeholders', (lang) => {
    for (const key of keys) {
      const text = DICTIONARIES[lang][key];
      expect(text.trim()).not.toBe('');
      expect(placeholders(text)).toEqual(placeholders(DICTIONARIES.en[key]));
    }
  });

  it('translates only French and Hungarian texts that differ from English where expected', () => {
    for (const key of ['settings.title', 'toolbar.undo', 'selection.delete', 'edge.menu'] as const) {
      expect(DICTIONARIES.fr[key]).not.toBe(DICTIONARIES.en[key]);
      expect(DICTIONARIES.hu[key]).not.toBe(DICTIONARIES.en[key]);
    }
  });

  it('switches language and interpolates parameters', () => {
    expect(t('toast.loaded', { name: 'Work' })).toBe('Loaded “Work”');
    setLanguage('fr');
    expect(t('toast.loaded', { name: 'Work' })).toBe('« Work » chargé');
    setLanguage('hu');
    expect(tm({ key: 'toast.loaded', params: { name: 'Work' } })).toBe('„Work” betöltve');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(t('toast.loaded', {})).toBe('Loaded “{name}”');
  });
});
