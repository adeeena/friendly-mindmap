import {
  BoardDoc,
  BoardSettings,
  ChecklistItem,
  ColorKey,
  CrossLink,
  MindNode,
  NodeId,
  ROOT_KEY,
  RichDoc,
  Shape,
  TagDef,
  cloneJson,
  createId,
  createNode,
} from './model';

export const keyOf = (parentId: NodeId | null): string => parentId ?? ROOT_KEY;

export function childrenOf(doc: BoardDoc, parentId: NodeId | null): NodeId[] {
  return doc.children[keyOf(parentId)] ?? [];
}

export function isAncestor(doc: BoardDoc, ancestorId: NodeId, nodeId: NodeId): boolean {
  let cur = doc.nodes[nodeId]?.parentId ?? null;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = doc.nodes[cur]?.parentId ?? null;
  }
  return false;
}

export function descendantsOf(doc: BoardDoc, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = [...childrenOf(doc, id)];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    stack.push(...childrenOf(doc, n));
  }
  return out;
}

export function rootOf(doc: BoardDoc, id: NodeId): NodeId {
  let cur = id;
  while (doc.nodes[cur]?.parentId) cur = doc.nodes[cur].parentId!;
  return cur;
}

export function depthOf(doc: BoardDoc, id: NodeId): number {
  let d = 0;
  let cur = doc.nodes[id]?.parentId ?? null;
  while (cur) {
    d++;
    cur = doc.nodes[cur]?.parentId ?? null;
  }
  return d;
}

function detachFromParent(doc: BoardDoc, id: NodeId): number {
  const node = doc.nodes[id];
  const key = keyOf(node.parentId);
  const list = doc.children[key] ?? [];
  const idx = list.indexOf(id);
  if (idx >= 0) list.splice(idx, 1);
  return idx;
}

function insertChild(doc: BoardDoc, parentId: NodeId | null, id: NodeId, index?: number): void {
  const key = keyOf(parentId);
  const list = (doc.children[key] ??= []);
  const i = index === undefined || index < 0 || index > list.length ? list.length : index;
  list.splice(i, 0, id);
  doc.nodes[id].parentId = parentId;
}

export interface NewNodeOptions {
  id?: NodeId;
  x?: number;
  y?: number;
  shape?: Shape;
  kind?: MindNode['kind'];
  text?: RichDoc;
}

export function createRoot(doc: BoardDoc, opts: NewNodeOptions = {}): NodeId {
  const node = createNode({ ...opts, parentId: null });
  doc.nodes[node.id] = node;
  insertChild(doc, null, node.id);
  if (node.kind === 'checklist') node.items ??= [];
  return node.id;
}

export function addChild(doc: BoardDoc, parentId: NodeId, opts: NewNodeOptions = {}): NodeId {
  const parent = doc.nodes[parentId];
  if (!parent) throw new Error(`Unknown node ${parentId}`);
  const node = createNode({ ...opts, parentId });
  doc.nodes[node.id] = node;
  insertChild(doc, parentId, node.id);
  if (node.kind === 'checklist') node.items ??= [];
  if (parent.collapsed) delete parent.collapsed;
  return node.id;
}

/** New node directly after `id` under the same parent (a new root when `id` is a root). */
export function addSibling(doc: BoardDoc, id: NodeId, opts: NewNodeOptions = {}): NodeId {
  const ref = doc.nodes[id];
  if (!ref) throw new Error(`Unknown node ${id}`);
  const node = createNode({ ...opts, parentId: ref.parentId });
  doc.nodes[node.id] = node;
  const idx = childrenOf(doc, ref.parentId).indexOf(id);
  insertChild(doc, ref.parentId, node.id, idx + 1);
  return node.id;
}

/** Moves a node to be the next sibling of its parent; a child of a root becomes a root. */
export function promote(doc: BoardDoc, id: NodeId): boolean {
  const node = doc.nodes[id];
  if (!node?.parentId) return false;
  const parent = doc.nodes[node.parentId];
  detachFromParent(doc, id);
  const grand = parent.parentId;
  const idx = childrenOf(doc, grand).indexOf(parent.id);
  insertChild(doc, grand, id, idx + 1);
  return true;
}

export function reorder(doc: BoardDoc, id: NodeId, delta: number): boolean {
  const node = doc.nodes[id];
  if (!node) return false;
  const list = doc.children[keyOf(node.parentId)];
  const idx = list.indexOf(id);
  const next = idx + delta;
  if (next < 0 || next >= list.length) return false;
  list.splice(idx, 1);
  list.splice(next, 0, id);
  return true;
}

export function reparent(
  doc: BoardDoc,
  id: NodeId,
  newParentId: NodeId | null,
  index?: number,
): boolean {
  const node = doc.nodes[id];
  if (!node) return false;
  if (newParentId === id) return false;
  if (newParentId && (!doc.nodes[newParentId] || isAncestor(doc, id, newParentId))) return false;
  const sameParent = node.parentId === newParentId;
  const oldIdx = detachFromParent(doc, id);
  let target = index;
  if (sameParent && target !== undefined && oldIdx >= 0 && oldIdx < target) target--;
  insertChild(doc, newParentId, id, target);
  if (newParentId && doc.nodes[newParentId].collapsed) delete doc.nodes[newParentId].collapsed;
  return true;
}

export function deleteSubtrees(doc: BoardDoc, ids: NodeId[]): Set<NodeId> {
  const removed = new Set<NodeId>();
  for (const id of ids) {
    if (!doc.nodes[id] || removed.has(id)) continue;
    const all = [id, ...descendantsOf(doc, id)];
    detachFromParent(doc, id);
    for (const n of all) {
      removed.add(n);
      delete doc.children[n];
      delete doc.nodes[n];
    }
  }
  for (const [lid, link] of Object.entries(doc.links)) {
    if (removed.has(link.from) || removed.has(link.to)) delete doc.links[lid];
  }
  return removed;
}

export function updateNode(doc: BoardDoc, id: NodeId, patch: Partial<MindNode>): void {
  const node = doc.nodes[id];
  if (!node) return;
  for (const [k, v] of Object.entries(patch) as [keyof MindNode, unknown][]) {
    if (k === 'id' || k === 'parentId') continue;
    if (v === undefined) delete (node as unknown as Record<string, unknown>)[k];
    else (node as unknown as Record<string, unknown>)[k] = v;
  }
}

export const setText = (doc: BoardDoc, id: NodeId, text: RichDoc) => updateNode(doc, id, { text });
export const setShape = (doc: BoardDoc, id: NodeId, shape: Shape | undefined) =>
  updateNode(doc, id, { shape });
export const setColor = (doc: BoardDoc, id: NodeId, color: ColorKey | undefined) =>
  updateNode(doc, id, { color });
export const setEmoji = (doc: BoardDoc, id: NodeId, emoji: string | undefined) =>
  updateNode(doc, id, { emoji });
export const setNote = (doc: BoardDoc, id: NodeId, note: RichDoc | undefined) =>
  updateNode(doc, id, { note });
export const setTodo = (doc: BoardDoc, id: NodeId, todo: boolean) =>
  updateNode(doc, id, { todo: todo || undefined });
export const setChecked = (doc: BoardDoc, id: NodeId, checked: boolean) =>
  updateNode(doc, id, { checked });
export const setCollapsed = (doc: BoardDoc, id: NodeId, collapsed: boolean) =>
  updateNode(doc, id, { collapsed: collapsed || undefined });
export const setItems = (doc: BoardDoc, id: NodeId, items: ChecklistItem[]) =>
  updateNode(doc, id, { items });

export function setTags(
  doc: BoardDoc,
  id: NodeId,
  tags: string[] | undefined,
  mode?: MindNode['tagsMode'],
): void {
  updateNode(doc, id, { tags: tags?.length ? tags : undefined, tagsMode: mode });
}

export function setPosition(doc: BoardDoc, id: NodeId, x: number, y: number): void {
  const node = doc.nodes[id];
  if (!node) return;
  node.x = x;
  node.y = y;
}

export function addLink(doc: BoardDoc, from: NodeId, to: NodeId, id = createId()): string | null {
  if (from === to || !doc.nodes[from] || !doc.nodes[to]) return null;
  if (Object.values(doc.links).some((l) => l.from === from && l.to === to)) return null;
  doc.links[id] = { id, from, to };
  return id;
}

export function removeLink(doc: BoardDoc, id: string): void {
  delete doc.links[id];
}

export function upsertTag(doc: BoardDoc, tag: TagDef): void {
  doc.tags[tag.id] = tag;
}

export function removeTag(doc: BoardDoc, tagId: string): void {
  delete doc.tags[tagId];
  for (const node of Object.values(doc.nodes)) {
    if (node.tags?.includes(tagId)) {
      node.tags = node.tags.filter((t) => t !== tagId);
      if (!node.tags.length) delete node.tags;
    }
  }
}

export function setSettings(doc: BoardDoc, patch: Partial<BoardSettings>): void {
  Object.assign(doc.settings, patch);
}

export function addAttachment(doc: BoardDoc, id: NodeId, meta: NonNullable<MindNode['attachments']>[number]): void {
  const node = doc.nodes[id];
  if (!node) return;
  (node.attachments ??= []).push(meta);
}

export function removeAttachment(doc: BoardDoc, id: NodeId, attachmentId: string): void {
  const node = doc.nodes[id];
  if (!node?.attachments) return;
  node.attachments = node.attachments.filter((a) => a.id !== attachmentId);
  if (!node.attachments.length) delete node.attachments;
}

// ---------- clipboard ----------

export interface ClipboardPayload {
  format: 'better-mindmap/clip';
  rootIds: NodeId[];
  nodes: MindNode[];
  links: CrossLink[];
}

/** Top-most selected nodes only: descendants of other selected nodes are dropped. */
export function topLevel(doc: BoardDoc, ids: NodeId[]): NodeId[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cur = doc.nodes[id]?.parentId ?? null;
    while (cur) {
      if (set.has(cur)) return false;
      cur = doc.nodes[cur]?.parentId ?? null;
    }
    return !!doc.nodes[id];
  });
}

export function copySubtrees(doc: BoardDoc, ids: NodeId[]): ClipboardPayload {
  const rootIds = topLevel(doc, ids);
  const nodes: MindNode[] = [];
  const included = new Set<NodeId>();
  const visit = (id: NodeId) => {
    included.add(id);
    nodes.push(cloneJson(doc.nodes[id]));
    for (const c of childrenOf(doc, id)) visit(c);
  };
  rootIds.forEach(visit);
  const links = Object.values(doc.links)
    .filter((l) => included.has(l.from) && included.has(l.to))
    .map((l) => ({ ...l }));
  return { format: 'better-mindmap/clip', rootIds, nodes, links };
}

/** Inserts copies with fresh ids; returns new top-level ids. */
export function pasteSubtrees(
  doc: BoardDoc,
  payload: ClipboardPayload,
  parentId: NodeId | null,
  offset: { dx: number; dy: number } = { dx: 0, dy: 0 },
  index?: number,
): NodeId[] {
  const idMap = new Map<NodeId, NodeId>();
  for (const n of payload.nodes) idMap.set(n.id, createId());
  const byId = new Map(payload.nodes.map((n) => [n.id, n]));
  const childIds = new Map<NodeId, NodeId[]>();
  for (const n of payload.nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const list = childIds.get(n.parentId) ?? [];
      list.push(n.id);
      childIds.set(n.parentId, list);
    }
  }
  const insert = (oldId: NodeId, newParent: NodeId | null, at?: number) => {
    const src = byId.get(oldId)!;
    const copy: MindNode = {
      ...cloneJson(src),
      id: idMap.get(oldId)!,
      parentId: newParent,
      x: src.x + offset.dx,
      y: src.y + offset.dy,
    };
    if (copy.items) copy.items = copy.items.map((i) => ({ ...i, id: createId() }));
    doc.nodes[copy.id] = copy;
    insertChild(doc, newParent, copy.id, at);
    for (const c of childIds.get(oldId) ?? []) insert(c, copy.id);
  };
  const newRoots: NodeId[] = [];
  payload.rootIds.forEach((rid, i) => {
    if (!byId.has(rid)) return;
    insert(rid, parentId, index === undefined ? undefined : index + i);
    newRoots.push(idMap.get(rid)!);
  });
  if (parentId && doc.nodes[parentId]?.collapsed) delete doc.nodes[parentId].collapsed;
  for (const l of payload.links) {
    const from = idMap.get(l.from);
    const to = idMap.get(l.to);
    if (from && to) addLink(doc, from, to);
  }
  return newRoots;
}

/** Parses indented plain text into a clipboard payload (2 spaces or a tab per level). */
export function parseIndentedText(text: string, textToDoc: (t: string) => RichDoc): ClipboardPayload | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return null;
  const levelOf = (l: string) => {
    const m = /^[\t ]*/.exec(l)![0];
    return m.replace(/\t/g, '  ').length;
  };
  const indents = [...new Set(lines.map(levelOf))].sort((a, b) => a - b);
  const nodes: MindNode[] = [];
  const rootIds: NodeId[] = [];
  const stack: { level: number; id: NodeId }[] = [];
  for (const line of lines) {
    const level = indents.indexOf(levelOf(line));
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1]?.id ?? null;
    const clean = line.trim().replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '');
    const node = createNode({ parentId: parent, text: textToDoc(clean) });
    nodes.push(node);
    if (!parent) rootIds.push(node.id);
    stack.push({ level, id: node.id });
  }
  return { format: 'better-mindmap/clip', rootIds, nodes, links: [] };
}
