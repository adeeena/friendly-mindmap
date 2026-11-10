import { childrenOf } from '../core/commands';
import { BoardDoc, NodeId } from '../core/model';
import { richToPlain } from '../core/rich-text';

export interface ChecklistData {
  title: string;
  items: { text: string; checked: boolean }[];
}

/** Items of a checklist node, or the direct children of a todo node. */
export function checklistOf(doc: BoardDoc, id: NodeId): ChecklistData | null {
  const node = doc.nodes[id];
  if (!node) return null;
  const title = richToPlain(node.text).replace(/\s+/g, ' ').trim() || (node.kind === 'checklist' ? 'Checklist' : 'Todo');
  if (node.kind === 'checklist') {
    return { title, items: (node.items ?? []).map((i) => ({ text: i.text, checked: i.checked })) };
  }
  if (node.todo) {
    return {
      title,
      items: childrenOf(doc, id).map((c) => ({
        text: richToPlain(doc.nodes[c].text).replace(/\s+/g, ' ').trim(),
        checked: !!doc.nodes[c].checked,
      })),
    };
  }
  return null;
}

export function checklistToMarkdown(c: ChecklistData): string {
  return [`## ${c.title}`, '', ...c.items.map((i) => `- [${i.checked ? 'x' : ' '}] ${i.text}`)].join('\n');
}

export function checklistToPlainText(c: ChecklistData): string {
  return [c.title, ...c.items.map((i) => `${i.checked ? '✓' : '○'} ${i.text}`)].join('\n');
}

export function checklistProgress(c: ChecklistData): { done: number; total: number } {
  return { done: c.items.filter((i) => i.checked).length, total: c.items.length };
}
