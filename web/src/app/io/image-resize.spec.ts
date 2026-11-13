import { ImageCodec, MAX_IMAGE_EDGE, fitWithin, isResizableImage, optimisedName, optimiseImage } from './image-resize';

function fakeCodec(width: number, height: number, produce: (mime: string) => Blob | null | Error) {
  const encode = jest.fn(async (_w: number, _h: number, mime: string) => {
    const result = produce(mime);
    if (result instanceof Error) throw result;
    return result;
  });
  const close = jest.fn();
  const codec: ImageCodec = { decode: async () => ({ width, height, encode, close }) };
  return { codec, encode, close };
}

const image = (name: string, type: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type });
const blob = (type: string, bytes: number) => new Blob([new Uint8Array(bytes)], { type });

describe('fitWithin', () => {
  it('limits the longer edge and keeps the aspect ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1920, height: 1440 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1440, height: 1920 });
    expect(fitWithin(2000, 2000)).toEqual({ width: 1920, height: 1920 });
  });

  it('never enlarges an image', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(MAX_IMAGE_EDGE, 1000)).toEqual({ width: 1920, height: 1000 });
  });

  it('keeps at least one pixel on the shorter edge', () => {
    expect(fitWithin(20000, 5)).toEqual({ width: 1920, height: 1 });
  });

  it('honours a custom limit', () => {
    expect(fitWithin(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
  });
});

describe('isResizableImage', () => {
  it('accepts still raster formats only', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) expect(isResizableImage(mime)).toBe(true);
    for (const mime of ['image/gif', 'image/svg+xml', 'application/pdf', '']) expect(isResizableImage(mime)).toBe(false);
  });
});

describe('optimisedName', () => {
  it('replaces the extension to match the new format', () => {
    expect(optimisedName('photo.png', 'image/webp')).toBe('photo.webp');
    expect(optimisedName('IMG_001.JPEG', 'image/jpeg')).toBe('IMG_001.jpg');
    expect(optimisedName('a.b.c.png', 'image/png')).toBe('a.b.c.png');
  });

  it('adds an extension when the name has none', () => {
    expect(optimisedName('scan', 'image/webp')).toBe('scan.webp');
  });
});

describe('optimiseImage', () => {
  it('returns unsupported formats untouched', async () => {
    const file = image('anim.gif', 'image/gif', 1000);
    const { codec } = fakeCodec(10, 10, () => blob('image/jpeg', 1));
    expect(await optimiseImage(file, codec)).toEqual({ changed: false, reason: 'unsupported', file });
  });

  it('shrinks a large jpeg to 1920px on the longer side and keeps it a jpeg', async () => {
    const file = image('holiday.jpg', 'image/jpeg', 6_000_000);
    const { codec, encode, close } = fakeCodec(4000, 3000, () => blob('image/jpeg', 700_000));
    const result = await optimiseImage(file, codec);
    expect(encode).toHaveBeenCalledWith(1920, 1440, 'image/jpeg', 0.85);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: true, width: 1920, height: 1440, savedBytes: 5_300_000 });
    if (!result.changed) throw new Error('expected a change');
    expect(result.file.name).toBe('holiday.jpg');
    expect(result.file.type).toBe('image/jpeg');
    expect(result.file.size).toBe(700_000);
  });

  it('converts png to webp when the browser can encode it', async () => {
    const file = image('screen.png', 'image/png', 4_000_000);
    const { codec, encode } = fakeCodec(3840, 2160, (mime) => blob(mime, 300_000));
    const result = await optimiseImage(file, codec);
    expect(encode).toHaveBeenCalledWith(1920, 1080, 'image/webp', 0.85);
    if (!result.changed) throw new Error('expected a change');
    expect(result.file.name).toBe('screen.webp');
    expect(result.file.type).toBe('image/webp');
  });

  it('keeps png when the browser silently falls back to it', async () => {
    const file = image('screen.png', 'image/png', 4_000_000);
    const { codec } = fakeCodec(3840, 2160, () => blob('image/png', 900_000));
    const result = await optimiseImage(file, codec);
    if (!result.changed) throw new Error('expected a change');
    expect(result.file.name).toBe('screen.png');
    expect(result.file.type).toBe('image/png');
  });

  it('keeps the original when re-encoding gains nothing', async () => {
    const file = image('small.jpg', 'image/jpeg', 50_000);
    const { codec } = fakeCodec(800, 600, () => blob('image/jpeg', 60_000));
    expect(await optimiseImage(file, codec)).toEqual({ changed: false, reason: 'no-gain', file });
  });

  it('reports a failure when the image cannot be decoded or encoded', async () => {
    const file = image('broken.jpg', 'image/jpeg', 1000);
    const failing: ImageCodec = { decode: async () => { throw new Error('bad image'); } };
    expect(await optimiseImage(file, failing)).toEqual({ changed: false, reason: 'failed', file });
    const nothing = fakeCodec(3000, 2000, () => null);
    expect(await optimiseImage(file, nothing.codec)).toEqual({ changed: false, reason: 'failed', file });
    expect(nothing.close).toHaveBeenCalledTimes(1);
    const throwing = fakeCodec(3000, 2000, () => new Error('canvas lost'));
    expect(await optimiseImage(file, throwing.codec)).toEqual({ changed: false, reason: 'failed', file });
    expect(throwing.close).toHaveBeenCalledTimes(1);
  });
});
