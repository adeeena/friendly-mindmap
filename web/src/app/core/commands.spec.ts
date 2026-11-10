import { produce } from 'immer';
import {
  addChild,
  addLink,
  addSibling,
  childrenOf,
  copySubtrees,
  createRoot,
  deleteSubtrees,
  parseIndentedText,
  pasteSubtrees,
  promote,
  removeTag,
  reorder,
  reparent,
  setTags,
  upsertTag,
} from './commands';
import { BoardDoc, ROOT_KEY, createBoard, textDoc } from './model';
import { richToPlain } from './rich-text';

function build(): { doc: BoardDoc; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const doc = produce(createBoard('Test'), (d) => {
    ids['A'] = createRoot(d, { text: textDoc('A') });
    ids['A1'] = addChild(d, ids['A'], { text: textDoc('A1') });
    ids['A1x'] = addChild(d, ids['A1'], { text: textDoc('A1x') });
    ids['A2'] = addChild(d, ids['A'], { text: textDoc('A2') });
    ids['B'] = createRoot(d, { text: textDoc('B') });
  });
  return { doc, ids };
}

describe('model', () => {
  it('constructs a sample board with two roots', () => {
    const { doc, ids } = build();
    expect(doc.children[ROOT_KEY]).toEqual([ids['A'], ids['B']]);
    expect(Object.keys(doc.nodes)).toHaveLength(5);
  });
});

describe('structural commands', () => {
  it('adds child as last child and sibling directly after', () => {
    const { doc, ids } = build();
    let sib = '';
    const next = produce(doc, (d) => {
      sib = addSibling(d, ids['A1']);
    });
    expect(childrenOf(next, ids['A'])).toEqual([ids['A1'], sib, ids['A2']]);
    expect(next.nodes[sib].parentId).toBe(ids['A']);
  });

  it('Enter on a root creates a new root after it', () => {
    const { doc, ids } = build();
    let sib = '';
    const next = produce(doc, (d) => {
      sib = addSibling(d, ids['A']);
    });
    expect(next.children[ROOT_KEY]).toEqual([ids['A'], sib, ids['B']]);
    expect(next.nodes[sib].parentId).toBeNull();
  });

  it('promotes to next sibling of the parent', () => {
    const { doc, ids } = build();
    const next = produce(doc, (d) => {
      promote(d, ids['A1x']);
    });
    expect(childrenOf(next, ids['A'])).toEqual([ids['A1'], ids['A1x'], ids['A2']]);
    expect(childrenOf(next, ids['A1'])).toEqual([]);
  });

  it('promoting a child of a root makes it a root', () => {
    const { doc, ids } = build();
    const next = produce(doc, (d) => {
      promote(d, ids['A2']);
    });
    expect(next.nodes[ids['A2']].parentId).toBeNull();
    expect(next.children[ROOT_KEY]).toEqual([ids['A'], ids['A2'], ids['B']]);
  });

  it('reorders among siblings', () => {
    const { doc, ids } = build();
    const next = produce(doc, (d) => {
      reorder(d, ids['A2'], -1);
    });
    expect(childrenOf(next, ids['A'])).toEqual([ids['A2'], ids['A1']]);
  });

  it('rejects reparenting onto a descendant', () => {
    const { doc, ids } = build();
    let ok = true;
    const next = produce(doc, (d) => {
      ok = reparent(d, ids['A'], ids['A1x']);
    });
    expect(ok).toBe(false);
    expect(next).toBe(doc);
  });

  it('reparents a subtree and detaches as root', () => {
    const { doc, ids } = build();
    const next = produce(doc, (d) => {
      reparent(d, ids['A1'], ids['B']);
      reparent(d, ids['A2'], null);
    });
    expect(childrenOf(next, ids['B'])).toEqual([ids['A1']]);
    expect(childrenOf(next, ids['A1'])).toEqual([ids['A1x']]);
    expect(next.nodes[ids['A2']].parentId).toBeNull();
  });

  it('deletes subtree and attached cross-links', () => {
    const { doc, ids } = build();
    const next = produce(doc, (d) => {
      addLink(d, ids['B'], ids['A1x']);
      deleteSubtrees(d, [ids['A1']]);
    });
    expect(next.nodes[ids['A1']]).toBeUndefined();
    expect(next.nodes[ids['A1x']]).toBeUndefined();
    expect(Object.keys(next.links)).toHaveLength(0);
    expect(childrenOf(next, ids['A'])).toEqual([ids['A2']]);
  });
});

describe('cross-links', () => {
  it('prevents self links and duplicates', () => {
    const { doc, ids } = build();
    const results: (string | null)[] = [];
    const next = produce(doc, (d) => {
      results.push(addLink(d, ids['A'], ids['A']));
      results.push(addLink(d, ids['A'], ids['B']));
      results.push(addLink(d, ids['A'], ids['B']));
    });
    expect(results[0]).toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).toBeNull();
    expect(Object.keys(next.links)).toHaveLength(1);
  });
});

describe('tags', () => {
  it('removing a tag strips it from nodes', () => {
    const { doc, ids } = build();
    const next = produce(doc, (d) => {
      upsertTag(d, { id: 't1', name: 'work', color: 'blue' });
      setTags(d, ids['A'], ['t1']);
      removeTag(d, 't1');
    });
    expect(next.nodes[ids['A']].tags).toBeUndefined();
  });
});

describe('clipboard', () => {
  it('pastes a copy with new ids as children of target', () => {
    const { doc, ids } = build();
    const clip = copySubtrees(doc, [ids['A1'], ids['A1x']]);
    expect(clip.rootIds).toEqual([ids['A1']]);
    let pasted: string[] = [];
    const next = produce(doc, (d) => {
      pasted = pasteSubtrees(d, clip, ids['B']);
    });
    expect(childrenOf(next, ids['B'])).toEqual(pasted);
    expect(pasted[0]).not.toBe(ids['A1']);
    const grand = childrenOf(next, pasted[0]);
    expect(grand).toHaveLength(1);
    expect(richToPlain(next.nodes[grand[0]].text)).toBe('A1x');
  });

  it('parses indented text', () => {
    const clip = parseIndentedText('Root\n  child 1\n    grand\n  child 2\nOther', textDoc)!;
    expect(clip.rootIds).toHaveLength(2);
    const byText = (t: string) => clip.nodes.find((n) => richToPlain(n.text) === t)!;
    expect(byText('grand').parentId).toBe(byText('child 1').id);
    expect(byText('child 2').parentId).toBe(byText('Root').id);
    expect(byText('Other').parentId).toBeNull();
  });
});
