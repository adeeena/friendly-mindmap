import { dashArray, resolveEdgeStyle } from './edge-style';
import { DEFAULT_EDGE_WIDTH } from './model';

describe('edge style', () => {
  it('defaults to a solid, theme-colored line', () => {
    expect(resolveEdgeStyle(undefined)).toEqual({ pattern: 'solid', color: undefined, width: DEFAULT_EDGE_WIDTH });
    expect(resolveEdgeStyle({})).toEqual({ pattern: 'solid', color: undefined, width: DEFAULT_EDGE_WIDTH });
  });

  it('keeps explicit fields and fills the rest', () => {
    expect(resolveEdgeStyle({ color: 'blue', width: 4 })).toEqual({ pattern: 'solid', color: 'blue', width: 4 });
  });

  it('derives dash arrays from pattern and width', () => {
    expect(dashArray('solid', 2)).toBeNull();
    expect(dashArray('dashed', 2)).toBe('8 6');
    expect(dashArray('dotted', 2)).toBe('0.1 5');
  });
});
