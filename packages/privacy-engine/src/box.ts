import type { Box } from "./types";

export function boxArea(box: Box): number {
  return box.width * box.height;
}

export function intersectionArea(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return width * height;
}

export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Intersection-over-union, 0 when the boxes don't overlap at all. */
export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union === 0 ? 0 : inter / union;
}

/** Expands `box` by `paddingPx` on every side, clamped to image bounds. */
export function padBox(
  box: Box,
  paddingPx: number,
  bounds: { width: number; height: number },
): Box {
  const x = Math.max(0, box.x - paddingPx);
  const y = Math.max(0, box.y - paddingPx);
  const right = Math.min(bounds.width, box.x + box.width + paddingPx);
  const bottom = Math.min(bounds.height, box.y + box.height + paddingPx);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}
