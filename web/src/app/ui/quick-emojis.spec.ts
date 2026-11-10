import { TestBed } from '@angular/core/testing';
import { EMOJI_STORAGE_KEY, MAX_CUSTOM_EMOJIS, QUICK_EMOJIS, QuickEmojis, firstEmoji } from './quick-emojis';
import { EmojiBar } from './emoji-bar';
import { EditorStore } from '../editor/editor-store';
import { BOARD_REPOSITORY, MemoryBoardRepository } from '../persistence/board-repository';

describe('firstEmoji', () => {
  it('returns the first emoji with its modifiers and joiners', () => {
    expect(firstEmoji('🚩')).toBe('🚩');
    expect(firstEmoji('  ⚠️ warn')).toBe('⚠️');
    expect(firstEmoji('👍🏽 ok')).toBe('👍🏽');
    expect(firstEmoji('👨‍👩‍👧 family')).toBe('👨‍👩‍👧');
    expect(firstEmoji('🇫🇷')).toBe('🇫🇷');
  });

  it('rejects text that does not start with an emoji', () => {
    expect(firstEmoji('')).toBeNull();
    expect(firstEmoji('abc')).toBeNull();
    expect(firstEmoji('1')).toBeNull();
    expect(firstEmoji('x🚩')).toBeNull();
  });
});

describe('QuickEmojis', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const fresh = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(QuickEmojis);
  };

  it('starts with the fixed list in order', () => {
    expect(QUICK_EMOJIS.join(' ')).toBe('🚩 ✅ ⚠️ 📞 ❌ 🐞 ⌛ 🔄');
    expect(fresh().all()).toEqual([...QUICK_EMOJIS]);
  });

  it('appends picked emojis after the fixed ones and ignores duplicates', () => {
    const q = fresh();
    q.remember('🎉');
    q.remember('✅');
    q.remember('🎉');
    q.remember('🚀');
    expect(q.all()).toEqual([...QUICK_EMOJIS, '🎉', '🚀']);
  });

  it('keeps picks across a reload and drops invalid stored values', () => {
    fresh().remember('🎉');
    expect(JSON.parse(localStorage.getItem(EMOJI_STORAGE_KEY)!)).toEqual(['🎉']);
    expect(fresh().custom()).toEqual(['🎉']);
    localStorage.setItem(EMOJI_STORAGE_KEY, JSON.stringify(['🎉', 'abc', 5, '🚀🚀']));
    expect(fresh().custom()).toEqual(['🎉']);
    localStorage.setItem(EMOJI_STORAGE_KEY, '{nope');
    expect(fresh().custom()).toEqual([]);
  });

  it('keeps only the most recent picks', () => {
    const q = fresh();
    const many = ['🍎', '🍌', '🍇', '🍓', '🍕', '🍔', '🍟', '🌮', '🍣', '🍰', '🍪', '☕', '🍺', '🍷'];
    many.forEach((e) => q.remember(e));
    expect(q.custom()).toHaveLength(MAX_CUSTOM_EMOJIS);
    expect(q.custom()[MAX_CUSTOM_EMOJIS - 1]).toBe('🍷');
  });
});

describe('EmojiBar', () => {
  class ResizeObserverStub {
    observe(): void {}
    disconnect(): void {}
  }
  let store: EditorStore;

  beforeAll(() => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  });

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: BOARD_REPOSITORY, useValue: new MemoryBoardRepository() }] });
    store = TestBed.inject(EditorStore);
  });

  afterEach(() => localStorage.clear());

  const render = async () => {
    const fixture = TestBed.createComponent(EmojiBar);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const bar = () => [...root.querySelectorAll<HTMLButtonElement>('.bm-emoji-bar .bm-emoji-btn')];
    return { fixture, root, bar };
  };

  it('is hidden without a selection and lists the quick emojis when a node is selected', async () => {
    const { fixture, root, bar } = await render();
    expect(root.querySelector('.bm-emoji-bar')).toBeNull();
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.select([a]);
    await fixture.whenStable();
    expect(bar().map((b) => b.textContent?.trim())).toEqual([...QUICK_EMOJIS]);
  });

  it('a click sets the emoji on every selected node and a second click removes it', async () => {
    const { fixture, bar } = await render();
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    const b = store.createRootAt({ x: 0, y: 300 }, { edit: false });
    store.select([a, b]);
    await fixture.whenStable();
    bar()[0].click();
    await fixture.whenStable();
    expect(store.doc().nodes[a].emoji).toBe('🚩');
    expect(store.doc().nodes[b].emoji).toBe('🚩');
    expect(bar()[0].getAttribute('aria-pressed')).toBe('true');
    bar()[0].click();
    expect(store.doc().nodes[a].emoji).toBeUndefined();
    store.undo();
    expect(store.doc().nodes[a].emoji).toBe('🚩');
  });

  it('the picker sets the emoji, adds it after the predefined list and closes', async () => {
    const { fixture, root, bar } = await render();
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.select([a]);
    await fixture.whenStable();
    (root.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(root.querySelector('.bm-emoji-pop')).not.toBeNull();
    expect(root.querySelectorAll('.bm-emoji-pop section')).toHaveLength(8);
    const party = [...root.querySelectorAll<HTMLButtonElement>('.bm-emoji-pop .bm-emoji-btn')].find((b) => b.textContent?.trim() === '🎉')!;
    party.click();
    await fixture.whenStable();
    expect(store.doc().nodes[a].emoji).toBe('🎉');
    expect(root.querySelector('.bm-emoji-pop')).toBeNull();
    expect(bar().map((b) => b.textContent?.trim())).toEqual([...QUICK_EMOJIS, '🎉']);
  });

  it('accepts a typed emoji and rejects other text', async () => {
    const { fixture, root, bar } = await render();
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.select([a]);
    store.emojiPicker.set(true);
    await fixture.whenStable();
    const input = root.querySelector('#bm-emoji-input') as HTMLInputElement;
    const submit = () => input.form!.dispatchEvent(new Event('submit', { cancelable: true }));
    input.value = 'hello';
    submit();
    await fixture.whenStable();
    expect(root.querySelector('.bm-error')).not.toBeNull();
    expect(store.doc().nodes[a].emoji).toBeUndefined();
    input.value = '🦄';
    submit();
    await fixture.whenStable();
    expect(store.doc().nodes[a].emoji).toBe('🦄');
    expect(bar().map((b) => b.textContent?.trim()).at(-1)).toBe('🦄');
  });

  it('the picker closes when the selection goes away and can clear the emoji', async () => {
    const { fixture, root } = await render();
    const a = store.createRootAt({ x: 0, y: 0 }, { edit: false });
    store.setEmoji('🚩', [a]);
    store.select([a]);
    store.emojiPicker.set(true);
    await fixture.whenStable();
    const none = [...root.querySelectorAll<HTMLButtonElement>('.bm-emoji-pop > button')].find((b) => b.textContent?.trim() === 'No emoji')!;
    none.click();
    expect(store.doc().nodes[a].emoji).toBeUndefined();
    expect(store.emojiPicker()).toBe(false);
    store.emojiPicker.set(true);
    store.clearSelection();
    await fixture.whenStable();
    expect(store.emojiPicker()).toBe(false);
  });
});
