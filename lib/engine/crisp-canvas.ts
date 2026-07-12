/**
 * crisp-canvas.ts -- One-call DPR-correct canvas setup.
 *
 * Replaces the manual devicePixelRatio boilerplate that every raw <canvas>
 * needs to render sharply on Retina / high-DPI displays. A single call to
 * {@link setupCrispCanvas} sizes the backing store at native resolution,
 * pins the CSS box to the logical size, and pre-scales the context so all
 * drawing code can keep working in plain CSS pixels.
 *
 * It fixes the two most common raw-canvas mistakes in one place:
 *   1. Blurry output from drawing at CSS size into a 1:1 backing store.
 *   2. Pixelated image scaling from leaving smoothing at the wrong setting.
 *
 * See the project memory rule `feedback_dpr_scaling.md` -- DPR scaling on
 * preview canvases is mandatory; this is the canonical helper for it.
 */

/** Tunables for {@link setupCrispCanvas} and {@link getCanvasDpr}. */
export interface CrispCanvasOptions {
  /**
   * Upper bound for the device pixel ratio. Some displays report 4+ which
   * quadruples the backing-store memory for no visible gain. Default 3.
   */
  maxDpr?: number;
  /** Whether the context smooths scaled images. Default true. */
  smoothing?: boolean;
  /** Quality of image smoothing when enabled. Default "high". */
  smoothingQuality?: ImageSmoothingQuality;
}

/**
 * Read the current device pixel ratio, clamped to a sane maximum.
 *
 * Falls back to 1 when `window.devicePixelRatio` is unavailable (SSR / older
 * environments). Exposed for callers that need the raw value (e.g. to scale
 * pointer coordinates or size an offscreen buffer) without re-running the
 * full canvas setup.
 *
 * @param maxDpr Upper bound for the ratio. Default 3.
 * @returns The clamped device pixel ratio, always >= 1.
 */
export function getCanvasDpr(maxDpr = 3): number {
  const raw =
    typeof window !== "undefined" && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;
  return Math.min(raw, maxDpr);
}

/**
 * Configure a canvas for crisp, DPR-correct rendering in a single call.
 *
 * This replaces the manual boilerplate that every preview canvas otherwise
 * has to repeat:
 *
 *   const dpr = window.devicePixelRatio || 1;
 *   canvas.width = cssWidth * dpr;
 *   canvas.height = cssHeight * dpr;
 *   canvas.style.width = cssWidth + "px";
 *   canvas.style.height = cssHeight + "px";
 *   const ctx = canvas.getContext("2d")!;
 *   ctx.scale(dpr, dpr);
 *
 * After calling this, draw everything in CSS pixels -- the context is already
 * pre-scaled to native resolution. `setTransform` (not `scale`) is used so
 * the helper is safe to re-run on resize without compounding the scale.
 *
 * Per the project memory rule `feedback_dpr_scaling.md`, DPR scaling on
 * preview canvases is a hard requirement.
 *
 * @param canvas The target canvas element.
 * @param cssWidth Logical (CSS) width in pixels.
 * @param cssHeight Logical (CSS) height in pixels.
 * @param opts Optional DPR clamp + image-smoothing overrides.
 * @returns The configured 2D rendering context.
 * @throws If a 2D context cannot be obtained from the canvas.
 */
export function setupCrispCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  opts: CrispCanvasOptions = {}
): CanvasRenderingContext2D {
  const dpr = getCanvasDpr(opts.maxDpr ?? 3);

  // Backing store at native resolution.
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  // CSS box stays at the logical size.
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(
      "setupCrispCanvas: getContext('2d') returned null -- canvas may already " +
        "have a context of a different type, or 2D rendering is unavailable."
    );
  }

  // setTransform (absolute) instead of scale (relative) so re-running this on
  // resize replaces the transform rather than multiplying it.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.imageSmoothingEnabled = opts.smoothing ?? true;
  ctx.imageSmoothingQuality = opts.smoothingQuality ?? "high";

  return ctx;
}
