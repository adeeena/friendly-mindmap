import {
  AttachmentMeta,
  BoardDoc,
  BoardSettings,
  COLOR_KEYS,
  Camera,
  ChecklistItem,
  ColorKey,
  CrossLink,
  DEFAULT_SETTINGS,
  LayoutDirection,
  MindNode,
  ROOT_KEY,
  SHAPES,
  Shape,
  TagDef,
} from './model';
import { sanitizeRichDoc } from './rich-text';

export const MAX_NODES = 20_000;

export class BoardValidationError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 10_000): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const color = (v: unknown): ColorKey | undefined =>
  COLOR_KEYS.includes(v as ColorKey) ? (v as ColorKey) : undefined;
const shape = (v: unknown): Shape | undefined => (SHAPES.includes(v as Shape) ? (v as Shape) : undefined);

/**
 * Validates untrusted board data (files, storage) and returns a clean,
 * structurally consistent document. Throws BoardValidationError when unusable.
 */
export function validateBoardDoc(input: unknown): BoardDoc {
  if (!isObj(input)) throw new BoardValidationError('Board is not an object');
  const rawNodes = input['nodes'];
  if (!isObj(rawNodes)) throw new BoardValidationError('Board has no nodes');
  const entries = Object.entries(rawNodes);
  if (entries.length > MAX_NODES) throw new BoardValidationError(`Board exceeds ${MAX_NODES} nodes`);

  const tags: Record<string, TagDef> = {};
  if (isObj(input['tags'])) {
    for (const [id, t] of Object.entries(input['tags'])) {
      if (!isObj(t)) continue;
      const name = str(t['name'], 100);
      if (!name) continue;
      tags[id] = { id, name, color: color(t['color']) ?? 'slate' };
    }
  }

  const nodes: Record<string, MindNode> = {};
  for (const [id, raw] of entries) {
    if (!isObj(raw)) continue;
    const node: MindNode = {
      id,
      parentId: typeof raw['parentId'] === 'string' ? raw['parentId'] : null,
      kind: raw['kind'] === 'checklist' ? 'checklist' : 'topic',
      x: num(raw['x']),
      y: num(raw['y']),
      text: sanitizeRichDoc(raw['text']),
    };
    const s = shape(raw['shape']);
    if (s) node.shape = s;
    const c = color(raw['color']);
    if (c) node.color = c;
    const emoji = str(raw['emoji'], 16);
    if (emoji) node.emoji = emoji;
    if (Array.isArray(raw['tags'])) {
      const t = raw['tags'].filter((x): x is string => typeof x === 'string' && !!tags[x]);
      if (t.length) node.tags = t;
    }
    if (raw['tagsMode'] === 'override') node.tagsMode = 'override';
    if (raw['note'] !== undefined) node.note = sanitizeRichDoc(raw['note']);
    if (Array.isArray(raw['attachments'])) {
      const atts: AttachmentMeta[] = raw['attachments'].filter(isObj).map((a) => ({
        id: str(a['id'], 100) ?? '',
        name: str(a['name'], 255) ?? 'file',
        mime: str(a['mime'], 255) ?? 'application/octet-stream',
        size: num(a['size']),
      }));
      const valid = atts.filter((a) => a.id);
      if (valid.length) node.attachments = valid;
    }
    if (raw['todo'] === true) node.todo = true;
    if (typeof raw['checked'] === 'boolean') node.checked = raw['checked'];
    if (raw['collapsed'] === true) node.collapsed = true;
    if (node.kind === 'checklist') {
      const items: ChecklistItem[] = (Array.isArray(raw['items']) ? raw['items'] : [])
        .filter(isObj)
        .map((i) => ({ id: str(i['id'], 100) ?? '', text: str(i['text'], 2000) ?? '', checked: i['checked'] === true }))
        .filter((i) => i.id);
      node.items = items;
    }
    nodes[id] = node;
  }

  // Rebuild children from parentId + stored order, dropping cycles and dangling refs.
  for (const n of Object.values(nodes)) if (n.parentId && !nodes[n.parentId]) n.parentId = null;
  for (const n of Object.values(nodes)) {
    const seen = new Set<string>([n.id]);
    let cur = n.parentId;
    while (cur) {
      if (seen.has(cur)) {
        n.parentId = null;
        break;
      }
      seen.add(cur);
      cur = nodes[cur]?.parentId ?? null;
    }
  }
  const storedChildren = isObj(input['children']) ? input['children'] : {};
  const children: Record<string, string[]> = { [ROOT_KEY]: [] };
  const byParent = new Map<string, string[]>();
  for (const n of Object.values(nodes)) {
    const key = n.parentId ?? ROOT_KEY;
    byParent.set(key, [...(byParent.get(key) ?? []), n.id]);
  }
  for (const [key, ids] of byParent) {
    const order = Array.isArray(storedChildren[key]) ? (storedChildren[key] as unknown[]) : [];
    const ranked = order.filter((x): x is string => typeof x === 'string' && ids.includes(x));
    const rest = ids.filter((id) => !ranked.includes(id));
    children[key] = [...new Set([...ranked, ...rest])];
  }

  const links: Record<string, CrossLink> = {};
  if (isObj(input['links'])) {
    for (const [id, l] of Object.entries(input['links'])) {
      if (!isObj(l)) continue;
      const from = str(l['from'], 100);
      const to = str(l['to'], 100);
      if (from && to && from !== to && nodes[from] && nodes[to]) links[id] = { id, from, to };
    }
  }

  const rs = isObj(input['settings']) ? input['settings'] : {};
  const direction: LayoutDirection = ['horizontal', 'vertical', 'balanced'].includes(rs['direction'] as string)
    ? (rs['direction'] as LayoutDirection)
    : DEFAULT_SETTINGS.direction;
  const settings: BoardSettings = {
    snap: typeof rs['snap'] === 'boolean' ? rs['snap'] : DEFAULT_SETTINGS.snap,
    autoAlign: typeof rs['autoAlign'] === 'boolean' ? rs['autoAlign'] : DEFAULT_SETTINGS.autoAlign,
    direction,
    minimap: typeof rs['minimap'] === 'boolean' ? rs['minimap'] : DEFAULT_SETTINGS.minimap,
  };

  return {
    id: str(input['id'], 100) || 'board',
    name: str(input['name'], 200) || 'Untitled board',
    nodes,
    children,
    links,
    tags,
    settings,
  };
}

export function validateCamera(input: unknown): Camera {
  if (!isObj(input)) return { x: 0, y: 0, zoom: 1 };
  const zoom = num(input['zoom'], 1);
  return { x: num(input['x']), y: num(input['y']), zoom: Math.min(4, Math.max(0.1, zoom)) };
}
