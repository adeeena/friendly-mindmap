import { Camera } from '../core/model';
import { Point, Rect } from '../layout/layout';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Camera maps world to screen as `screen = world * zoom + (x, y)`. */
export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
}

export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y };
}

/** Zooms so the world point under `focus` (screen coords) stays fixed. */
export function zoomAt(cam: Camera, nextZoom: number, focus: Point): Camera {
  const zoom = clampZoom(nextZoom);
  const k = zoom / cam.zoom;
  return { zoom, x: focus.x - (focus.x - cam.x) * k, y: focus.y - (focus.y - cam.y) * k };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

export function fitBounds(bounds: Rect | null, viewport: { w: number; h: number }, margin = 48): Camera {
  if (!bounds) return { x: viewport.w / 2, y: viewport.h / 2, zoom: 1 };
  const zoom = clampZoom(
    Math.min((viewport.w - margin * 2) / Math.max(bounds.w, 1), (viewport.h - margin * 2) / Math.max(bounds.h, 1), 1.5),
  );
  return {
    zoom,
    x: viewport.w / 2 - (bounds.x + bounds.w / 2) * zoom,
    y: viewport.h / 2 - (bounds.y + bounds.h / 2) * zoom,
  };
}

/** Centers the camera on a world point, keeping zoom. */
export function centerOn(cam: Camera, world: Point, viewport: { w: number; h: number }): Camera {
  return { ...cam, x: viewport.w / 2 - world.x * cam.zoom, y: viewport.h / 2 - world.y * cam.zoom };
}
