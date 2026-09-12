import type { Box, RasterImage } from "../types";

/** One native-resolution region of the capture, in image-space pixels. */
export type OcrTile = { x: number; y: number; width: number; height: number };

export type TilePlanOptions = {
  /**
   * Longest side the text detector consumes without downsampling. Anything
   * larger is scaled down before detection runs.
   */
  nativeSideLength: number;
  /**
   * Fraction of a tile shared with each neighbour, so a word sitting on a
   * seam is still whole inside at least one tile.
   */
  overlap: number;
  /** Upper bound on how many tiles one scan may cost. */
  maxTiles: number;
};

const MAX_OVERLAP = 0.5;
const TILE_GROWTH_FACTOR = 1.25;

/**
 * Start offsets covering `extent` with `tile`-wide windows advancing by
 * `step`. The final window is pinned to the far edge so the last strip is
 * never left short.
 */
function axisStarts(extent: number, tile: number, step: number): number[] {
  if (extent <= tile) return [0];
  const starts: number[] = [];
  const last = extent - tile;
  for (let start = 0; start < last; start += step) starts.push(start);
  starts.push(last);
  return [...new Set(starts)];
}

function planStarts(
  bounds: { width: number; height: number },
  tile: number,
  overlap: number,
): { columns: number[]; rows: number[] } {
  const step = Math.max(1, Math.round(tile * (1 - overlap)));
  return {
    columns: axisStarts(bounds.width, Math.min(tile, bounds.width), step),
    rows: axisStarts(bounds.height, Math.min(tile, bounds.height), step),
  };
}

/**
 * Plans the native-resolution second OCR pass.
 *
 * A full-page capture is wider than the detector's input budget, so the
 * single full-image pass sees it downsampled -- which is why text baked into
 * small embedded images (thumbnails, previews) falls below the detector's
 * resolution and survives unredacted. Re-running detection over tiles no
 * larger than that budget puts those pixels back in front of the detector at
 * 1:1.
 *
 * Returns `[]` when the capture already fits the budget, because the
 * full-image pass is then already native and a second pass finds nothing new.
 *
 * Invariant: the returned tiles always cover every pixel of `bounds`. When
 * `maxTiles` binds, tiles grow (uniformly lower resolution) instead of
 * regions being dropped -- a skipped region is unredacted PII, which is
 * exactly the failure this exists to prevent.
 *
 * Every emitted tile has integer, in-bounds coordinates, so callers may use
 * `tile.x`/`tile.y` directly as the offset that maps a tile-local box back
 * into image space.
 */
export function planOcrTiles(
  bounds: { width: number; height: number },
  options: TilePlanOptions,
): OcrTile[] {
  const width = Math.floor(bounds.width);
  const height = Math.floor(bounds.height);
  if (width <= 0 || height <= 0) return [];

  const longSide = Math.max(width, height);
  const native = Math.max(1, Math.floor(options.nativeSideLength));
  if (longSide <= native) return [];

  const overlap = Math.min(MAX_OVERLAP, Math.max(0, options.overlap));
  const maxTiles = Math.max(1, Math.floor(options.maxTiles));

  let tile = native;
  let starts = planStarts({ width, height }, tile, overlap);
  while (starts.columns.length * starts.rows.length > maxTiles && tile < longSide) {
    tile = Math.min(longSide, Math.ceil(tile * TILE_GROWTH_FACTOR));
    starts = planStarts({ width, height }, tile, overlap);
  }

  const tileWidth = Math.min(tile, width);
  const tileHeight = Math.min(tile, height);
  // A single tile spanning the whole capture would just repeat the
  // full-image pass at the same scale; skip the duplicate work.
  if (tileWidth === width && tileHeight === height) return [];

  const tiles: OcrTile[] = [];
  for (const y of starts.rows) {
    for (const x of starts.columns) {
      tiles.push({ x, y, width: tileWidth, height: tileHeight });
    }
  }
  return tiles;
}

/**
 * Copies one tile out of a capture into a standalone `RasterImage`. The
 * source bitmap is never mutated -- the `LocalAudit` keeps holding it.
 */
export function cropRaster(image: RasterImage, tile: OcrTile): RasterImage {
  const x0 = Math.max(0, Math.min(image.width, Math.floor(tile.x)));
  const y0 = Math.max(0, Math.min(image.height, Math.floor(tile.y)));
  const x1 = Math.max(x0, Math.min(image.width, Math.ceil(tile.x + tile.width)));
  const y1 = Math.max(y0, Math.min(image.height, Math.ceil(tile.y + tile.height)));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width === 0 || height === 0) {
    return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const source = ((y0 + row) * image.width + x0) * 4;
    data.set(image.data.subarray(source, source + rowBytes), row * rowBytes);
  }
  return { width, height, data };
}

/** Maps a tile-local box back into full-capture image space. */
export function translateBox(box: Box, dx: number, dy: number): Box {
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
}
