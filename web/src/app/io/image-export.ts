import { toPng, toSvg } from 'html-to-image';
import { NodeId } from '../core/model';
import { Rect } from '../layout/layout';

export interface ImageExportOptions {
  format: 'png' | 'svg';
  pixelRatio: 1 | 2;
  /** null = whole board */
  include: Set<NodeId> | null;
  background: boolean;
  forceLight: boolean;
}

const SKIP_CLASSES = ['bm-overlay', 'bm-handle', 'bm-collapse', 'bm-edge-hit', 'bm-add-item'];

/** Renders the world layer cropped to `bounds` into a PNG or SVG data URL. */
export async function renderImage(world: HTMLElement, bounds: Rect, opts: ImageExportOptions): Promise<string> {
  const pad = 32;
  const root = world.ownerDocument.documentElement;
  if (opts.forceLight) root.classList.add('force-light');
  root.classList.add('exporting');
  try {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    const filter = (n: HTMLElement | SVGElement) => {
      if (!(n instanceof Element)) return true;
      if (SKIP_CLASSES.some((c) => n.classList.contains(c))) return false;
      if (opts.include) {
        const id = n.getAttribute('data-node-id');
        if (id && !opts.include.has(id)) return false;
        const ends = n.getAttribute('data-ends');
        if (ends && !ends.split(',').every((e) => opts.include!.has(e))) return false;
      }
      return true;
    };
    const config = {
      width: Math.ceil(bounds.w + pad * 2),
      height: Math.ceil(bounds.h + pad * 2),
      pixelRatio: opts.pixelRatio,
      backgroundColor: opts.background ? bg : undefined,
      filter,
      style: {
        transform: `translate(${pad - bounds.x}px, ${pad - bounds.y}px)`,
        transformOrigin: '0 0',
        transition: 'none',
      },
    };
    return opts.format === 'png' ? await toPng(world, config) : await toSvg(world, config);
  } finally {
    root.classList.remove('force-light', 'exporting');
  }
}

export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
