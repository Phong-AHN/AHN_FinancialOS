/**
 * Fitting a screenshot to what the model can read at full detail.
 *
 * Claude's high-resolution tier (Claude 4.7 and later) reads an image at up to
 * 2576 px on the long edge AND up to 4784 visual tokens, where one token is a
 * 28x28 patch: ceil(w/28) x ceil(h/28). An image over either limit is
 * downscaled by the API before it is read (platform.claude.com → Vision →
 * Resolution and token cost).
 *
 * THE BUG THIS EXISTS FOR. The first version only respected the long edge. A
 * phone's scrolling capture — 1170 x 8000, a month of transfers — was shrunk to
 * fit 2576 px tall, leaving it 377 px wide: amounts a few pixels high, read as
 * guesses. The sample screenshot (1169 x 2370, 3570 tokens) fits both limits,
 * so it never showed.
 *
 * Two answers, chosen by how much shrinking would cost:
 *
 *   - scale down a little and send one image — an ordinary screenshot that is
 *     slightly too tall loses almost nothing (iPhone 1290 x 2796 → 0.92);
 *   - cut a tall capture into overlapping tiles at a readable width — each tile
 *     within both limits, each overlap taller than a transaction card, so every
 *     card appears whole in at least one tile. Duplicates across tiles are
 *     merged by `mergeReviewRows`, exactly like overlapping screenshots.
 *
 * PURE: numbers in, numbers out. The browser does the drawing.
 */

export const MAX_LONG_EDGE = 2576;
export const MAX_VISUAL_TOKENS = 4784;
const PATCH = 28;

/** Shrinking text by more than this loses digits; below it, tile instead. */
const MIN_SINGLE_SCALE = 0.75;
/** A card on VietinBank's transfer list is about half the screen width tall. */
const OVERLAP_OF_WIDTH = 0.6;

export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

export interface SlicePlan {
  /** Output pixels per source pixel. */
  scale: number;
  /** Width of every tile, in output pixels. */
  width: number;
  /** Tiles from the top, in output pixels. One tile means one image. */
  slices: Array<{ top: number; height: number }>;
}

function fitsBoth(width: number, height: number): boolean {
  return Math.max(width, height) <= MAX_LONG_EDGE && visualTokens(width, height) <= MAX_VISUAL_TOKENS;
}

/** The largest scale ≤ 1 at which the whole image fits both limits. */
export function singleFitScale(srcWidth: number, srcHeight: number): number {
  let scale = Math.min(
    1,
    MAX_LONG_EDGE / Math.max(srcWidth, srcHeight),
    Math.sqrt((MAX_VISUAL_TOKENS * PATCH * PATCH) / (srcWidth * srcHeight)),
  );
  // Patch rounding can tip the estimate over by a token or two.
  while (scale > 0.01 && !fitsBoth(Math.round(srcWidth * scale), Math.round(srcHeight * scale))) scale *= 0.99;
  return scale;
}

export function planSlices(srcWidth: number, srcHeight: number): SlicePlan {
  const fit = singleFitScale(srcWidth, srcHeight);
  const tall = srcHeight > srcWidth * 1.2;

  if (fit >= MIN_SINGLE_SCALE || !tall) {
    const width = Math.round(srcWidth * fit);
    return { scale: fit, width, slices: [{ top: 0, height: Math.round(srcHeight * fit) }] };
  }

  // Tile at the largest width the long-edge limit allows, never enlarging.
  const scale = Math.min(1, MAX_LONG_EDGE / srcWidth);
  const width = Math.round(srcWidth * scale);
  const height = Math.round(srcHeight * scale);
  const columns = Math.ceil(width / PATCH);
  const tile = Math.min(MAX_LONG_EDGE, Math.floor(MAX_VISUAL_TOKENS / columns) * PATCH, height);
  const overlap = Math.min(Math.round(width * OVERLAP_OF_WIDTH), Math.floor(tile * 0.45));
  const stride = tile - overlap;

  const slices: Array<{ top: number; height: number }> = [];
  for (let top = 0; top + tile < height; top += stride) slices.push({ top, height: tile });
  const last = height - tile;
  if (!slices.length || slices[slices.length - 1]!.top < last) slices.push({ top: last, height: tile });
  return { scale, width, slices };
}
