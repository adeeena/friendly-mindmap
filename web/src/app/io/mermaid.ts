import { childrenOf } from '../core/commands';
import { BoardDoc, NodeId, Shape } from '../core/model';
import { resolveStyles } from '../core/inheritance';
import { richToPlain } from '../core/rich-text';

/** Mermaid node text: one line, no characters that break shape delimiters. */
export function mermaidText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim() || 'Untitled';
  return clean.replace(/["()[\]{}]/g, (c) => `#${c.charCodeAt(0)};`);
}

function wrap(shape: Shape, text: string, id: string): string {
  switch (shape) {
    case 'rectangle':
      return `${id}[${text}]`;
    case 'rounded':
      return `${id}(${text})`;
    default:
      return text;
  }
}

/** One `mindmap` diagram per root tree. Positions, links, styles, notes and attachments are dropped. */
export function toMermaid(doc: BoardDoc): string {
  const styles = resolveStyles(doc);
  const diagrams: string[] = [];
  let counter = 0;
  for (const root of childrenOf(doc, null)) {
    const lines = ['mindmap'];
    const visit = (id: NodeId, depth: number) => {
      const node = doc.nodes[id];
      const base =
        node.kind === 'checklist'
          ? [richToPlain(node.text) || 'Checklist']
          : [richToPlain(node.text)];
      const text = mermaidText(base.join(''));
      const shape = styles[id]?.shape ?? 'none';
      lines.push('  '.repeat(depth + 1) + wrap(shape, text, `n${++counter}`));
      if (node.kind === 'checklist') {
        for (const item of node.items ?? []) {
          lines.push('  '.repeat(depth + 2) + mermaidText(`${item.checked ? '☑' : '☐'} ${item.text}`));
        }
      }
      for (const c of childrenOf(doc, id)) visit(c, depth + 1);
    };
    visit(root, 0);
    diagrams.push(lines.join('\n'));
  }
  return diagrams.join('\n\n%% ----\n\n');
}
