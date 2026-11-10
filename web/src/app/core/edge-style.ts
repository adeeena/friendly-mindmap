import { ColorKey, DEFAULT_EDGE_WIDTH, EdgePattern, EdgeStyle } from './model';

export interface ResolvedEdgeStyle {
  pattern: EdgePattern;
  color?: ColorKey;
  width: number;
}

/** Fills missing fields with the shared default: solid, untapered, theme edge color. */
export function resolveEdgeStyle(style?: EdgeStyle): ResolvedEdgeStyle {
  return { pattern: style?.pattern ?? 'solid', color: style?.color, width: style?.width ?? DEFAULT_EDGE_WIDTH };
}

/** SVG stroke-dasharray for a pattern; dots rely on round line caps. */
export function dashArray(pattern: EdgePattern, width: number): string | null {
  if (pattern === 'dashed') return `${width * 4} ${width * 3}`;
  if (pattern === 'dotted') return `0.1 ${width * 2.5}`;
  return null;
}
