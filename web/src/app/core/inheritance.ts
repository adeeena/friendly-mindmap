import { childrenOf } from './commands';
import { BoardDoc, ColorKey, NodeId, Shape } from './model';

export interface ResolvedStyle {
  shape: Shape;
  color?: ColorKey;
  emoji?: string;
  tags: string[];
  inherited: { shape: boolean; color: boolean; emoji: boolean; tags: boolean };
}

export const DEFAULT_ROOT_SHAPE: Shape = 'rounded';

/** Resolves cascading color/shape/tags/emoji top-down for every node. */
export function resolveStyles(doc: BoardDoc): Record<NodeId, ResolvedStyle> {
  const out: Record<NodeId, ResolvedStyle> = {};
  const visit = (id: NodeId, parent: ResolvedStyle | null) => {
    const n = doc.nodes[id];
    if (!n) return;
    const ownTags = (n.tags ?? []).filter((t) => doc.tags[t]);
    const inheritTags = n.tagsMode !== 'override' && parent;
    const tags = inheritTags ? [...new Set([...parent.tags, ...ownTags])] : ownTags;
    const style: ResolvedStyle = {
      shape: n.shape ?? parent?.shape ?? DEFAULT_ROOT_SHAPE,
      color: n.color ?? parent?.color,
      emoji: n.emoji ?? parent?.emoji,
      tags,
      inherited: {
        shape: n.shape === undefined && !!parent,
        color: n.color === undefined && parent?.color !== undefined,
        emoji: n.emoji === undefined && parent?.emoji !== undefined,
        tags: !!inheritTags && parent.tags.length > 0,
      },
    };
    out[id] = style;
    for (const c of childrenOf(doc, id)) visit(c, style);
  };
  for (const r of childrenOf(doc, null)) visit(r, null);
  return out;
}
