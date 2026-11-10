/**
 * @jest-environment node
 */
import { produce } from 'immer';
import { strToU8, zipSync } from 'fflate';
import { addChild, createRoot, setChecked, setItems, setShape, setTodo } from '../core/commands';
import { BoardDoc, createBoard, textDoc } from '../core/model';
import { BoardValidationError } from '../core/validate';
import { richToHtml } from '../core/rich-text';
import { checklistOf, checklistToMarkdown, checklistToPlainText } from './checklist-export';
import { toMermaid } from './mermaid';
import { importBoardFile, toNativeJson, toNativeZip } from './native-format';

function sample(): { doc: BoardDoc; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const doc = produce(createBoard('Work'), (d) => {
    ids['plan'] = createRoot(d, { text: textDoc('Plan'), x: 10, y: 20 });
    setShape(d, ids['plan'], 'rectangle');
    ids['a'] = addChild(d, ids['plan'], { text: textDoc('A') });
    ids['b'] = addChild(d, ids['plan'], { text: textDoc('B (beta)') });
    d.nodes[ids['a']].attachments = [{ id: 'f1', name: 'x.txt', mime: 'text/plain', size: 3 }];
  });
  return { doc, ids };
}

describe('native format', () => {
  it('round-trips JSON', async () => {
    const { doc } = sample();
    const json = toNativeJson(doc, { x: 1, y: 2, zoom: 1.5 });
    const { board } = await importBoardFile(new Blob([json]));
    expect(board.doc).toEqual(doc);
    expect(board.camera).toEqual({ x: 1, y: 2, zoom: 1.5 });
  });

  it('round-trips zip with attachments', async () => {
    const { doc } = sample();
    const zip = await toNativeZip(doc, { x: 0, y: 0, zoom: 1 }, async () => new Blob(['abc']));
    const { board, files } = await importBoardFile(new Blob([zip as BlobPart]));
    expect(board.doc).toEqual(doc);
    expect(files).toHaveLength(1);
    expect(await files[0].blob.text()).toBe('abc');
  });

  it('round-trips layout offsets and edge styles', async () => {
    const { doc, ids } = sample();
    const styled = produce(doc, (d) => {
      d.nodes[ids['a']].layoutOffset = { x: 30, y: -12 };
      d.nodes[ids['a']].edgeStyle = { pattern: 'dashed', color: 'blue', width: 4 };
      d.links['l1'] = { id: 'l1', from: ids['a'], to: ids['b'], edgeStyle: { pattern: 'dotted', width: 1 } };
    });
    const json = toNativeJson(styled, { x: 0, y: 0, zoom: 1 });
    const { board } = await importBoardFile(new Blob([json]));
    expect(board.doc).toEqual(styled);
  });

  it('loads a version 1 file unchanged', async () => {
    const { doc } = sample();
    const v1 = JSON.parse(toNativeJson(doc, { x: 0, y: 0, zoom: 1 }));
    v1.schemaVersion = 1;
    const { board } = await importBoardFile(new Blob([JSON.stringify(v1)]));
    expect(board.doc).toEqual(doc);
  });

  it('rejects invalid files', async () => {
    await expect(importBoardFile(new Blob(['not json']))).rejects.toBeInstanceOf(BoardValidationError);
    await expect(importBoardFile(new Blob([JSON.stringify({ format: 'other' })]))).rejects.toBeInstanceOf(
      BoardValidationError,
    );
    const zip = zipSync({ 'readme.txt': strToU8('hi') });
    await expect(importBoardFile(new Blob([zip as BlobPart]))).rejects.toBeInstanceOf(BoardValidationError);
  });

  it('sanitizes malicious rich text and drops broken structure', async () => {
    const { doc, ids } = sample();
    const evil = JSON.parse(toNativeJson(doc, { x: 0, y: 0, zoom: 1 }));
    evil.board.doc.nodes[ids['a']].text = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
            { type: 'html', text: '<script>alert(1)</script>' },
            { type: 'text', text: '<img src=x onerror=alert(1)>' },
          ],
        },
      ],
    };
    evil.board.doc.nodes[ids['plan']].parentId = ids['a']; // cycle
    const { board } = await importBoardFile(new Blob([JSON.stringify(evil)]));
    const html = richToHtml(board.doc.nodes[ids['a']].text);
    expect(html).not.toMatch(/javascript:|<script|<img/);
    const roots = board.doc.children['__root__'];
    expect(roots.length).toBeGreaterThan(0);
  });

  it('rejects oversized files', async () => {
    const big = { size: 60 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Blob;
    await expect(importBoardFile(big)).rejects.toThrow('50 MB');
  });
});

describe('mermaid export', () => {
  it('exports hierarchy and shapes', () => {
    const { doc } = sample();
    expect(toMermaid(doc)).toBe(['mindmap', '  n1[Plan]', '    n2[A]', '    n3[B #40;beta#41;]'].join('\n'));
  });
});

describe('checklist export', () => {
  it('exports checklist nodes and todo children', () => {
    let list = '';
    let trip = '';
    const doc = produce(createBoard(), (d) => {
      list = createRoot(d, { kind: 'checklist', text: textDoc('Groceries') });
      setItems(d, list, [
        { id: '1', text: 'milk', checked: true },
        { id: '2', text: 'eggs', checked: false },
      ]);
      trip = createRoot(d, { text: textDoc('Trip') });
      setTodo(d, trip, true);
      const c = addChild(d, trip, { text: textDoc('Tickets') });
      addChild(d, trip, { text: textDoc('Hotel') });
      setChecked(d, c, true);
    });
    const md = checklistToMarkdown(checklistOf(doc, list)!);
    expect(md).toBe('## Groceries\n\n- [x] milk\n- [ ] eggs');
    expect(checklistToPlainText(checklistOf(doc, trip)!)).toBe('Trip\n✓ Tickets\n○ Hotel');
  });
});
