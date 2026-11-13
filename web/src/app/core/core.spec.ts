import { produce } from 'immer';
import {
  addChild,
  createRoot,
  deleteSubtrees,
  reparent,
  setCollapsed,
  setColor,
  setEmoji,
  setItems,
  setNote,
  setPosition,
  setShape,
  setTags,
  setText,
  setTodo,
  upsertTag,
} from './commands';
import { History } from './history';
import { resolveStyles } from './inheritance';
import { BoardDoc, createBoard, textDoc } from './model';
import { richToHtml, richToPlain, sanitizeRichDoc } from './rich-text';

describe('content and style commands', () => {
  it('sets and clears node properties', () => {
    let id = '';
    const doc = produce(createBoard(), (d) => {
      id = createRoot(d);
      setText(d, id, textDoc('Hello'));
      setShape(d, id, 'none');
      setColor(d, id, 'green');
      setEmoji(d, id, '🛒');
      setNote(d, id, textDoc('note'));
      setTodo(d, id, true);
      setCollapsed(d, id, true);
      setItems(d, id, [{ id: 'i', text: 'milk', checked: true }]);
    });
    const n = doc.nodes[id];
    expect(richToPlain(n.text)).toBe('Hello');
    expect(n).toMatchObject({ shape: 'none', color: 'green', emoji: '🛒', todo: true, collapsed: true });
    expect(n.items?.[0].text).toBe('milk');
    const cleared = produce(doc, (d) => {
      setColor(d, id, undefined);
      setTodo(d, id, false);
      setCollapsed(d, id, false);
    });
    expect(cleared.nodes[id].color).toBeUndefined();
    expect(cleared.nodes[id].todo).toBeUndefined();
    expect(cleared.nodes[id].collapsed).toBeUndefined();
  });
});

describe('History', () => {
  function setup() {
    const h = new History<BoardDoc>();
    let doc = createBoard();
    let a = '';
    let a1 = '';
    ({ state: doc } = h.apply(doc, (d) => {
      a = createRoot(d, { text: textDoc('A') });
      a1 = addChild(d, a);
      addChild(d, a1);
    }));
    return { h, doc, a, a1 };
  }

  it('undoes a delete fully', () => {
    const { h, doc, a1 } = setup();
    const before = doc;
    const { state: after } = h.apply(doc, (d) => {
      deleteSubtrees(d, [a1]);
    });
    expect(after.nodes[a1]).toBeUndefined();
    const restored = h.undo(after)!;
    expect(restored).toEqual(before);
  });

  it('merges a transaction into one step', () => {
    const { h, doc, a } = setup();
    let s = doc;
    for (let i = 1; i <= 5; i++) {
      s = h.apply(s, (d) => setPosition(d, a, i * 10, 0), { txn: 'drag' }).state;
    }
    expect(s.nodes[a].x).toBe(50);
    s = h.undo(s)!;
    expect(s.nodes[a].x).toBe(0);
  });

  it('clears redo after a new edit', () => {
    const { h, doc, a } = setup();
    let s = h.apply(doc, (d) => setColor(d, a, 'red')).state;
    s = h.undo(s)!;
    expect(h.canRedo).toBe(true);
    h.apply(s, (d) => setColor(d, a, 'blue'));
    expect(h.canRedo).toBe(false);
  });

  it('does not record no-op recipes', () => {
    const { h, doc } = setup();
    h.undo(doc);
    expect(h.canUndo).toBe(false);
    const res = h.apply(doc, () => undefined);
    expect(res.changed).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it('keeps at most the configured number of steps', () => {
    const h = new History<BoardDoc>(3);
    let s = createBoard();
    for (let i = 0; i < 5; i++) s = h.apply(s, (d) => void createRoot(d)).state;
    let undos = 0;
    while (h.canUndo) {
      s = h.undo(s)!;
      undos++;
    }
    expect(undos).toBe(3);
  });
});

describe('resolveStyles', () => {
  it('cascades and supports override/reset and reparenting', () => {
    let a = '';
    let a1 = '';
    let b = '';
    let doc = produce(createBoard(), (d) => {
      upsertTag(d, { id: 'work', name: 'work', color: 'blue' });
      a = createRoot(d);
      a1 = addChild(d, a);
      b = createRoot(d);
      setColor(d, a, 'blue');
      setShape(d, a, 'rectangle');
      setTags(d, a, ['work']);
      setEmoji(d, a, '⭐');
      setColor(d, b, 'green');
    });
    let s = resolveStyles(doc);
    expect(s[a1]).toMatchObject({ color: 'blue', shape: 'rectangle', emoji: '⭐', tags: ['work'] });
    expect(s[a1].inherited.color).toBe(true);

    doc = produce(doc, (d) => setColor(d, a1, 'red'));
    s = resolveStyles(doc);
    expect(s[a1].color).toBe('red');
    expect(s[a1].inherited.color).toBe(false);

    doc = produce(doc, (d) => setColor(d, a1, undefined));
    expect(resolveStyles(doc)[a1].color).toBe('blue');

    doc = produce(doc, (d) => void reparent(d, a1, b));
    expect(resolveStyles(doc)[a1].color).toBe('green');
  });

  it('tag override mode stops inheritance', () => {
    let a = '';
    let a1 = '';
    const doc = produce(createBoard(), (d) => {
      upsertTag(d, { id: 'x', name: 'x', color: 'red' });
      upsertTag(d, { id: 'y', name: 'y', color: 'red' });
      a = createRoot(d);
      a1 = addChild(d, a);
      setTags(d, a, ['x']);
      setTags(d, a1, ['y'], 'override');
    });
    expect(resolveStyles(doc)[a1].tags).toEqual(['y']);
  });
});

describe('rich text', () => {
  it('drops unsafe links and escapes html', () => {
    const doc = sanitizeRichDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<b>x</b>', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
            { type: 'script', text: 'bad' },
            { type: 'text', text: 'ok', marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://a.b' } }] },
          ],
        },
      ],
    });
    const html = richToHtml(doc);
    expect(html).not.toContain('javascript');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('href="https://a.b"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('preserves and renders underline marks', () => {
    const doc = sanitizeRichDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'underlined', marks: [{ type: 'underline' }] }] }],
    });
    expect(doc.content?.[0].content?.[0].marks).toEqual([{ type: 'underline' }]);
    expect(richToHtml(doc)).toContain('<u>underlined</u>');
  });
});
