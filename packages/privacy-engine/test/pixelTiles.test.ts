import { describe, expect, test } from "bun:test";
import { cropRaster, planOcrTiles, translateBox } from "../src/pixel/tiles";
import type { RasterImage } from "../src/types";

const BUDGET = { nativeSideLength: 960, overlap: 0.15, maxTiles: 8 };

function coversEveryPixel(
  tiles: Array<{ x: number; y: number; width: number; height: number }>,
  bounds: { width: number; height: number },
): boolean {
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const covered = tiles.some(
        (tile) => x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height,
      );
      if (!covered) return false;
    }
  }
  return true;
}

function gradientImage(width: number, height: number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = index % 256;
    data[index * 4 + 1] = (index * 3) % 256;
    data[index * 4 + 2] = (index * 7) % 256;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe("planOcrTiles", () => {
  test("skips tiling when the capture already fits the detector's native budget", () => {
    expect(planOcrTiles({ width: 800, height: 600 }, BUDGET)).toEqual([]);
    expect(planOcrTiles({ width: 960, height: 400 }, BUDGET)).toEqual([]);
  });

  test("tiles a full-page capture that would otherwise be downsampled", () => {
    const tiles = planOcrTiles({ width: 1920, height: 1080 }, BUDGET);
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(BUDGET.maxTiles);
  });

  test("covers every pixel of the capture", () => {
    const bounds = { width: 1920, height: 1080 };
    expect(coversEveryPixel(planOcrTiles(bounds, BUDGET), bounds)).toBe(true);
  });

  test("keeps tiles within the detector's native budget so no downsampling occurs", () => {
    for (const tile of planOcrTiles({ width: 1920, height: 1080 }, BUDGET)) {
      expect(Math.max(tile.width, tile.height)).toBeLessThanOrEqual(BUDGET.nativeSideLength);
    }
  });

  test("emits integer, in-bounds tiles so tile.x/tile.y is a valid box offset", () => {
    const bounds = { width: 1920, height: 1080 };
    for (const tile of planOcrTiles(bounds, BUDGET)) {
      expect(Number.isInteger(tile.x)).toBe(true);
      expect(Number.isInteger(tile.y)).toBe(true);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(bounds.width);
      expect(tile.y + tile.height).toBeLessThanOrEqual(bounds.height);
    }
  });

  test("grows tiles instead of dropping regions when maxTiles binds", () => {
    const bounds = { width: 4000, height: 3000 };
    const tiles = planOcrTiles(bounds, { ...BUDGET, maxTiles: 4 });
    expect(tiles.length).toBeLessThanOrEqual(4);
    // A skipped region is unredacted PII, so coverage must survive the cap.
    expect(coversEveryPixel(tiles, bounds)).toBe(true);
    expect(Math.max(tiles[0]!.width, tiles[0]!.height)).toBeGreaterThan(BUDGET.nativeSideLength);
  });

  test("overlaps neighbouring tiles so text on a seam is whole in one tile", () => {
    const tiles = planOcrTiles({ width: 1920, height: 1080 }, BUDGET);
    const columns = [...new Set(tiles.map((tile) => tile.x))].sort((a, b) => a - b);
    expect(columns.length).toBeGreaterThan(1);
    expect(columns[1]! - columns[0]!).toBeLessThan(tiles[0]!.width);
  });

  test("returns no tiles for a degenerate capture", () => {
    expect(planOcrTiles({ width: 0, height: 0 }, BUDGET)).toEqual([]);
    expect(planOcrTiles({ width: -10, height: 500 }, BUDGET)).toEqual([]);
  });
});

describe("cropRaster", () => {
  test("copies the exact tile pixels without mutating the source", () => {
    const image = gradientImage(6, 4);
    const before = Uint8ClampedArray.from(image.data);
    const crop = cropRaster(image, { x: 2, y: 1, width: 3, height: 2 });

    expect(crop.width).toBe(3);
    expect(crop.height).toBe(2);
    expect(crop.data.length).toBe(3 * 2 * 4);
    // Top-left of the crop is source pixel (2, 1) -> flat index 1*6 + 2 = 8.
    expect(crop.data[0]).toBe(8 % 256);
    expect(image.data).toEqual(before);
  });

  test("clamps a tile that runs past the image edge", () => {
    const crop = cropRaster(gradientImage(5, 5), { x: 3, y: 3, width: 10, height: 10 });
    expect(crop.width).toBe(2);
    expect(crop.height).toBe(2);
  });

  test("returns an empty raster for an out-of-bounds tile", () => {
    const crop = cropRaster(gradientImage(5, 5), { x: 9, y: 9, width: 4, height: 4 });
    expect(crop.width).toBe(0);
    expect(crop.data.length).toBe(0);
  });
});

describe("translateBox", () => {
  test("maps a tile-local box back into capture space", () => {
    expect(translateBox({ x: 5, y: 7, width: 20, height: 10 }, 960, 480)).toEqual({
      x: 965,
      y: 487,
      width: 20,
      height: 10,
    });
  });
});
