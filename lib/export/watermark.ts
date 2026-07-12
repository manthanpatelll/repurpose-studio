/**
 * Watermark utility for NotifyMotion free tier exports.
 *
 * Large center badge - "Made with NotifyMotion" rendered dead-center of the frame
 * at ~25% opacity. Overlaps content so it cannot be cropped without destroying the video.
 *
 * No external image dependency - pure text rendering with drop shadow.
 * Adapted from TiltIt's proven watermark system.
 */

const BADGE_TEXT = "Made with NotifyMotion";
const BADGE_FONT_WEIGHT = 700;
const BADGE_FONT_FAMILY = "Inter, system-ui, sans-serif";
const BADGE_FONT_SIZE_RATIO = 0.045;
const BADGE_MIN_FONT_SIZE = 20;
const BADGE_DEFAULT_OPACITY = 0.25;

function drawCenterBadge(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  opacity: number = BADGE_DEFAULT_OPACITY
): void {
  const fontSize = Math.max(
    BADGE_MIN_FONT_SIZE,
    Math.round(height * BADGE_FONT_SIZE_RATIO)
  );

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `${BADGE_FONT_WEIGHT} ${fontSize}px ${BADGE_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";

  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  ctx.fillText(BADGE_TEXT, width / 2, height / 2);
  ctx.restore();
}

export async function applyWatermark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  opacity: number = BADGE_DEFAULT_OPACITY
): Promise<void> {
  drawCenterBadge(ctx, width, height, opacity);
}

// Pre-rendered watermark overlay cache
let _cachedOverlay: ImageBitmap | null = null;
let _cachedOverlayDims: { w: number; h: number; opacity: number } | null =
  null;

export async function createWatermarkOverlay(
  width: number,
  height: number,
  opacity: number = BADGE_DEFAULT_OPACITY
): Promise<ImageBitmap> {
  if (
    _cachedOverlay &&
    _cachedOverlayDims?.w === width &&
    _cachedOverlayDims?.h === height &&
    _cachedOverlayDims?.opacity === opacity
  ) {
    return _cachedOverlay;
  }

  _cachedOverlay?.close();

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get overlay canvas context");

  ctx.clearRect(0, 0, width, height);
  await applyWatermark(ctx, width, height, opacity);

  _cachedOverlay = canvas.transferToImageBitmap();
  _cachedOverlayDims = { w: width, h: height, opacity };
  return _cachedOverlay;
}

export function disposeWatermarkOverlay(): void {
  _cachedOverlay?.close();
  _cachedOverlay = null;
  _cachedOverlayDims = null;
}

export async function applyWatermarkToBitmap(
  bitmap: ImageBitmap,
  opacity: number = BADGE_DEFAULT_OPACITY
): Promise<ImageBitmap> {
  const { width, height } = bitmap;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");

  ctx.drawImage(bitmap, 0, 0);

  try {
    const overlay = await createWatermarkOverlay(width, height, opacity);
    ctx.drawImage(overlay, 0, 0);
  } catch {
    await applyWatermark(ctx, width, height, opacity);
  }

  return canvas.transferToImageBitmap();
}

export async function preloadWatermark(): Promise<void> {
  // Text-only watermark - nothing to preload
}
