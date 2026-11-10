export type NodeId = string;
export type Shape = 'none' | 'rectangle' | 'rounded';
export type LayoutDirection = 'horizontal' | 'vertical' | 'balanced';
export type NodeKind = 'topic' | 'checklist';

export const COLOR_KEYS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

export const SHAPES: readonly Shape[] = ['none', 'rectangle', 'rounded'];

/** ProseMirror/TipTap JSON node. */
export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
}

export interface RichDoc extends RichNode {
  type: 'doc';
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface MindNode {
  id: NodeId;
  parentId: NodeId | null;
  kind: NodeKind;
  /** Top-left world position used for roots and in free (non auto-align) mode. */
  x: number;
  y: number;
  text: RichDoc;
  shape?: Shape;
  color?: ColorKey;
  emoji?: string;
  tags?: string[];
  /** 'override' stops inheriting ancestor tags. */
  tagsMode?: 'inherit' | 'override';
  note?: RichDoc;
  attachments?: AttachmentMeta[];
  /** Marks this node's direct children as checkable todos. */
  todo?: boolean;
  /** Checked state when the parent is a todo node. */
  checked?: boolean;
  items?: ChecklistItem[];
  collapsed?: boolean;
}

export interface CrossLink {
  id: string;
  from: NodeId;
  to: NodeId;
}

export interface TagDef {
  id: string;
  name: string;
  color: ColorKey;
}

export interface BoardSettings {
  snap: boolean;
  autoAlign: boolean;
  direction: LayoutDirection;
  minimap: boolean;
}

export const ROOT_KEY = '__root__';

export interface BoardDoc {
  id: string;
  name: string;
  nodes: Record<NodeId, MindNode>;
  /** Ordered children per parent id; roots are under ROOT_KEY. */
  children: Record<string, NodeId[]>;
  links: Record<string, CrossLink>;
  tags: Record<string, TagDef>;
  settings: BoardSettings;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const SCHEMA_VERSION = 1;

export interface StoredBoard {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  doc: BoardDoc;
  camera: Camera;
}

export interface BoardSummary {
  id: string;
  name: string;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  snap: true,
  autoAlign: true,
  direction: 'horizontal',
  minimap: false,
};

export const GRID_SIZE = 8;
export const MAX_NODE_WIDTH = 320;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function createId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyDoc(): RichDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function textDoc(text: string): RichDoc {
  const lines = text.split('\n');
  const content: RichNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  return { type: 'doc', content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }] };
}

export function createBoard(name = 'Untitled board', id = createId()): BoardDoc {
  return {
    id,
    name,
    nodes: {},
    children: { [ROOT_KEY]: [] },
    links: {},
    tags: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function createNode(partial: Partial<MindNode> & { id?: NodeId } = {}): MindNode {
  return {
    id: partial.id ?? createId(),
    parentId: partial.parentId ?? null,
    kind: partial.kind ?? 'topic',
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    text: partial.text ?? emptyDoc(),
    ...partial,
  } as MindNode;
}
