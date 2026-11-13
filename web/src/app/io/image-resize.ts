export const MAX_IMAGE_EDGE = 1920;
const QUALITY = 0.85;
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Animated (gif) and vector (svg) images would lose their meaning, so only still rasters are touched. */
export function isResizableImage(mime: string): boolean {
  return RESIZABLE.has(mime);
}

/** Scales the longer edge down to the limit, keeps the aspect ratio and never enlarges. */
export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longer = Math.max(width, height);
  if (longer <= maxEdge) return { width, height };
  const scale = maxEdge / longer;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function optimisedName(name: string, mime: string): string {
  const extension = EXTENSIONS[mime];
  if (!extension) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** Returns null when the browser cannot produce an image. A browser may answer with a different type than requested. */
  encode(width: number, height: number, mime: string, quality: number): Promise<Blob | null>;
  close(): void;
}

export interface ImageCodec {
  decode(blob: Blob): Promise<DecodedImage>;
}

export type OptimiseResult =
  | { changed: false; reason: 'unsupported' | 'no-gain' | 'failed'; file: File }
  | { changed: true; file: File; width: number; height: number; savedBytes: number };

const browserCodec: ImageCodec = {
  async decode(source) {
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      async encode(width, height, mime, quality) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
      },
      close: () => bitmap.close(),
    };
  },
};

/**
 * Shrinks a photo or screenshot to at most {@link MAX_IMAGE_EDGE} px on its longer side and re-compresses it.
 * Photos stay jpeg; png becomes webp where the browser can write it. The original is returned
 * whenever the result would not be smaller, so the operation can never make a file worse.
 */
export async function optimiseImage(file: File, codec: ImageCodec = browserCodec): Promise<OptimiseResult> {
  if (!isResizableImage(file.type)) return { changed: false, reason: 'unsupported', file };
  let decoded: DecodedImage;
  try {
    decoded = await codec.decode(file);
  } catch {
    return { changed: false, reason: 'failed', file };
  }
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height);
    const encoded = await decoded.encode(width, height, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', QUALITY);
    if (!encoded) return { changed: false, reason: 'failed', file };
    if (encoded.size >= file.size) return { changed: false, reason: 'no-gain', file };
    const result = new File([encoded], optimisedName(file.name, encoded.type), { type: encoded.type, lastModified: Date.now() });
    return { changed: true, file: result, width, height, savedBytes: file.size - encoded.size };
  } catch {
    return { changed: false, reason: 'failed', file };
  } finally {
    decoded.close();
  }
}
