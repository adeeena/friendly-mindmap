import { fitBounds, screenToWorld, worldToScreen, zoomAt } from './camera';
import { hierarchyEdge, isFullyEnclosed, linkEdge, rectFromPoints, smartGuides, snapValue } from './geometry';

describe('camera math', () => {
  it('round-trips screen and world', () => {
    const cam = { x: 30, y: -20, zoom: 2 };
    const w = screenToWorld(cam, { x: 130, y: 80 });
    expect(worldToScreen(cam, w)).toEqual({ x: 130, y: 80 });
  });

  it('zoomAt keeps the focal world point fixed and clamps', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    const focus = { x: 200, y: 100 };
    const before = screenToWorld(cam, focus);
    const next = zoomAt(cam, 2.5, focus);
    expect(screenToWorld(next, focus).x).toBeCloseTo(before.x);
    expect(screenToWorld(next, focus).y).toBeCloseTo(before.y);
    expect(zoomAt(cam, 10, focus).zoom).toBe(4);
    expect(zoomAt(cam, 0.01, focus).zoom).toBe(0.1);
  });

  it('fit centers bounds and resets to 100% for empty boards', () => {
    const fit = fitBounds({ x: 0, y: 0, w: 1000, h: 500 }, { w: 1096, h: 800 });
    expect(fit.zoom).toBeCloseTo(1);
    const c = screenToWorld(fit, { x: 548, y: 400 });
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(250);
    expect(fitBounds(null, { w: 800, h: 600 })).toEqual({ x: 400, y: 300, zoom: 1 });
  });
});

describe('geometry', () => {
  it('snaps to the 8px grid', () => {
    expect(snapValue(103)).toBe(104);
    expect(snapValue(99)).toBe(96);
  });

  it('full enclosure excludes partially covered rects', () => {
    const marquee = rectFromPoints({ x: 100, y: 100 }, { x: 0, y: 0 });
    expect(isFullyEnclosed({ x: 10, y: 10, w: 50, h: 20 }, marquee)).toBe(true);
    expect(isFullyEnclosed({ x: 80, y: 10, w: 50, h: 20 }, marquee)).toBe(false);
  });

  it('smart guides snap centers within threshold', () => {
    const res = smartGuides({ x: 0, y: 103, w: 100, h: 40 }, [{ x: 300, y: 100, w: 100, h: 40 }], 4);
    expect(res.dy).toBe(-3);
    expect(res.lines.some((l) => l.axis === 'y')).toBe(true);
    const none = smartGuides({ x: 0, y: 120, w: 100, h: 41 }, [{ x: 300, y: 100, w: 10, h: 10 }], 4);
    expect(none.lines).toHaveLength(0);
  });

  it('hierarchy edges connect facing sides', () => {
    const g = hierarchyEdge({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 80, h: 30 }, 'horizontal');
    expect(g.start).toEqual({ x: 100, y: 20 });
    expect(g.end).toEqual({ x: 200, y: 115 });
    expect(g.d).toBe(g.center);
    expect(g.d.endsWith('Z')).toBe(false);
    expect(g.d.match(/C/g)).toHaveLength(1);
    const v = hierarchyEdge({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 100, w: 100, h: 40 }, 'vertical');
    expect(v.start).toEqual({ x: 50, y: 40 });
    expect(v.end).toEqual({ x: 50, y: 100 });
    const left = hierarchyEdge({ x: 0, y: 0, w: 100, h: 40 }, { x: -200, y: 0, w: 80, h: 40 }, 'balanced');
    expect(left.start.x).toBe(0);
  });

  it('cross-links pick sides by dominant axis', () => {
    const g = linkEdge({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 300, w: 100, h: 40 });
    expect(g.start).toEqual({ x: 50, y: 40 });
    expect(g.end).toEqual({ x: 50, y: 300 });
  });
});
