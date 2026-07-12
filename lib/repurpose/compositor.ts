// ===========================================================================
// REPURPOSE STUDIO -- preview/export compositor
// ===========================================================================
// Pure Canvas 2D render module: no React, no DOM lookups beyond the video/
// image sources handed to it. Shared verbatim between the live PreviewCanvas
// (app/repurpose-studio/_components/PreviewCanvas.tsx) and the export agent's
// frame renderer, so the split-screen composite is byte-for-byte identical
// between "what you see" and "what you export".
//
// Coordinate contract (matches PanZoomTransform + FaceFraming):
//   - `x`/`y` are normalized crop-center offsets in [-1, 1]; 0,0 = centered,
//     no pan. +x pans the visible crop right (source content appears to move
//     left), +y pans down.
//   - `scale` is a zoom multiplier on top of the cover-fit scale; 1 = no
//     extra zoom (plain cover-fit), 2 = crop to half-width/half-height, etc.
//
// COLOR GRADE: an optional per-region `filter` (a CSS filter list) can be set;
// it is applied via `ctx.filter` around that region's drawImage. The strings
// come from lib/repurpose/color-grade.ts (COLOR_GRADES / gradeFilter). An empty
// or absent filter is a no-op, so grading is strictly additive -- zero behavior
// change when no grade is selected. ctx.filter is supported on BOTH
// CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D in Chrome
// (this project is Chrome-only, local), so the preview and the offscreen export
// grade identically.
//
// SMART TRANSITION (per-cut MOTION, NOT a fade): an optional `transition` field
// on DrawFrameOptions carries the incoming clip's Descript-style "Smart
// transition" -- a zoom-settle or a small match-move slide that plays as the
// clip enters. It is INCOMING-ONLY (needs just the current frame, no
// outgoing-frame snapshot), so it composites cleanly with the two shared
// <video> sources. The window's `progress` (0 at the cut, 1 when settled) comes
// from `transitionProgressAt(clips, t)` in lib/repurpose/time-map.ts; the caller
// (preview loop AND export frame-walk) passes its result straight through, so
// both render the SAME motion frame-for-frame.
//
// The effect is pure MOTION -- we never touch globalAlpha and never cross-fade:
//   - zoom-settle: the incoming frame starts `amount` larger (e.g. 6%) and eases
//     to the region's normal scale. A larger scale = tighter crop, so this is
//     just extra scale about each region center, fed through the SAME
//     computeCoverSourceRect path (grade / cover-fit / clip all stay consistent).
//   - slide: the frame is translated in from `direction` by `amount * destW` and
//     eases to rest, clipped to the band (never bleeding across the split line).
// Both are applied to BOTH regions, with the FACE (bottom) panel staggered a hair
// behind the SCREEN (top) panel so the two halves don't move in lockstep. When
// `transition` is absent, or type "none", or progress <= 0 / >= 1, drawFrame
// behaves BYTE-FOR-BYTE as it did before this field existed -- strictly additive,
// exactly like `filter` above.
//
// FREE-FLOATING OVERLAYS (drawn AFTER the two base regions + divider): an
// optional `overlays` array on DrawFrameOptions composites external image/video
// layers on top of the base frame via a plain translate/rotate/scale drawImage
// in normalized 9:16 space (see OverlayDraw). This is the ONLY place globalAlpha
// is touched, and ONLY for an overlay's own static `opacity` asset property --
// it is constant per overlay, never tweened at cuts, so the no-fade convention
// still holds (opacity is not a crossfade). An absent/empty `overlays` array is
// a strict no-op: drawFrame renders byte-for-byte as before -- same additive
// discipline as `filter` and `transition`.
// ===========================================================================

import type { ClipTransition } from "./types";

/** Resolved (non-keyframed) pan/zoom transform for one frame. */
export interface PanZoomTransform {
  x: number;
  y: number;
  scale: number;
}

/** Any source `drawImage` accepts that behaves like a 2D raster (video/img/canvas). */
export type DrawableSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap;

/** Any 2D context flavor drawFrame can target -- live preview or offscreen export. */
export type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Default output resolution: 1080x1920 (9:16 vertical short). */
export const DEFAULT_WIDTH = 1080;
export const DEFAULT_HEIGHT = 1920;

/** Clamp helper -- keeps pan offsets and split ratio inside sane bounds. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Ease-in-out cubic -- Descript's default "Smart transition" curve. Slow start,
 * fast middle, slow settle. Maps [0,1] -> [0,1] with f(0)=0, f(1)=1.
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Ease-out-back -- overshoots past 1 near the end then settles, giving a subtle
 * "spring" pop to the zoom-settle. Standard 1.70158 back constant (2.70158 =
 * that + 1). Maps [0,1] -> [~0, 1] with f(0)=0, f(1)=1 (overshoots >1 mid-way).
 */
export function easeOutBack(t: number): number {
  return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
}

/**
 * Resolve a `ClipTransition.easing` label to its curve. "natural" (and the
 * absent default) = ease-in-out cubic; "bounce" = ease-out-back. Kept internal
 * -- callers pass the label from the transition, not a function.
 */
function applyEasing(
  easing: "natural" | "bounce" | undefined,
  t: number
): number {
  return easing === "bounce" ? easeOutBack(t) : easeInOutCubic(t);
}

/** One region's draw inputs: a source, its intrinsic size, and pan/zoom transform. */
export interface RegionSource {
  /** The drawable (video/image/canvas). Null renders a labeled placeholder instead. */
  source: DrawableSource | null;
  /** Intrinsic pixel width of the source (e.g. `video.videoWidth`). */
  sourceWidth: number;
  /** Intrinsic pixel height of the source (e.g. `video.videoHeight`). */
  sourceHeight: number;
  /** Pan/zoom transform already sampled for the current frame. */
  transform: PanZoomTransform;
  /** Label drawn when `source` is null (placeholder mode). E.g. "SCREEN" / "FACE". */
  placeholderLabel: string;
  /**
   * Optional CSS filter list (from lib/repurpose/color-grade.ts) applied to
   * this region's drawImage. Empty/absent = untouched. Ignored in placeholder
   * mode (no real footage to grade).
   */
  filter?: string;
}

/** Full set of inputs to {@link drawFrame}. */
export interface DrawFrameOptions {
  /** Screen (landscape source) region -- rendered in the TOP band. */
  screen: RegionSource;
  /** Face-cam region -- rendered in the BOTTOM band. */
  face: RegionSource;
  /** Fraction (0-1) of the output height given to the screen band. Clamped [0.4, 0.6] by convention upstream; not re-clamped here so callers can preview out-of-range values deliberately. */
  splitRatio: number;
  /** Output width in px. Default 1080. */
  width?: number;
  /** Output height in px. Default 1920. */
  height?: number;
  /** Draw a thin divider line at the split. Default true. */
  showDivider?: boolean;
  /** Divider line color. Default a soft neutral. */
  dividerColor?: string;
  /** Divider line thickness in px. Default 2. */
  dividerWidth?: number;
  /** Background fill behind both bands (visible only via letterboxing gaps, if any). Default "#0b0b0c" (dark). */
  backgroundColor?: string;
  /**
   * Active per-cut "Smart transition" MOTION for THIS frame (zoom-settle or
   * slide), if a transition window is currently playing. Populated straight from
   * `transitionProgressAt(clips, t)` in lib/repurpose/time-map.ts -- pass its
   * `transition` fields plus `progress` through. Preview and export MUST build
   * this identically so both render the same motion frame-for-frame.
   *
   * Absent, or `type === "none"`, or `progress <= 0` / `progress >= 1` is a
   * strict no-op: drawFrame renders the plain two-region composite exactly as it
   * did before this field existed. Never affects globalAlpha -- motion only.
   */
  transition?: {
    /** Which motion to run. "none" (or absent field) = no-op. */
    type: ClipTransition["type"];
    /** Window position: 0 at the cut, 1 fully settled. Edge values (<=0 / >=1) = no-op. */
    progress: number;
    /** Effect strength: scale-up fraction (zoom-settle) or slide fraction of destW (slide). e.g. 0.06. */
    amount: number;
    /** Slide direction ("left" enters from the right). Ignored by zoom-settle. Default "left". */
    direction?: "left" | "right";
    /** Easing curve. "natural" = ease-in-out cubic (default); "bounce" = ease-out-back. */
    easing?: "natural" | "bounce";
  };
  /**
   * Free-floating overlays drawn ON TOP of the two base regions, in the order
   * given (the caller sorts by z ASCENDING so index 0 is bottom-most). Absent or
   * empty is a strict no-op: drawFrame renders the plain two-region composite
   * exactly as before this field existed -- same additive discipline as `filter`
   * and `transition`.
   *
   * INVARIANT: overlays are the LAST thing drawFrame paints, and captions are
   * NEVER drawn here -- every caller draws them via drawCaptions AFTER drawFrame
   * returns (see PreviewCanvas + export-short drawOneFrame). That ordering makes
   * captions the strict top layer above both the split video and every overlay.
   * Do not add a caption draw inside drawFrame; keep it caller-last.
   */
  overlays?: OverlayDraw[];
}

/**
 * One free-floating overlay already resolved for THIS frame: a source (the
 * <video>/<img>/canvas/ImageBitmap to draw), its intrinsic size, and a free
 * affine transform in NORMALIZED output space. A null source (media not loaded
 * yet) or a non-positive natural dimension is skipped.
 *
 * Transform contract (normalized 9:16 output space):
 *   - x,y: overlay CENTER as a fraction of output width/height (0..1). 0.5,0.5 =
 *     dead center. Values outside [0,1] intentionally bleed the asset off-frame.
 *   - scale: the overlay's natural width as a FRACTION OF OUTPUT WIDTH at this
 *     scale (aspect ratio comes from naturalWidth/naturalHeight, so height is
 *     derived). This is why an overlay renders at the correct size at BOTH 1080p
 *     and 4K with no extra code.
 *   - rotation: DEGREES, clockwise, about the overlay center (converted to
 *     radians once at draw time here).
 *   - opacity: 0..1. The ONE place globalAlpha is used -- overlays only, never
 *     the base composite. It is a STATIC asset property, not a crossfade (it is
 *     constant per overlay, never tweened at cuts), so the no-fade convention is
 *     preserved.
 */
export interface OverlayDraw {
  source: DrawableSource | null;
  naturalWidth: number;
  naturalHeight: number;
  transform: {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    opacity: number;
  };
  /**
   * Which split-screen band this overlay is CLIPPED to, so cover-crop overflow
   * never bleeds onto the neighboring panel:
   *   - "screen": clip to the TOP band [0, topH] (topH = round(height*splitRatio)).
   *     Use for overlays that should cover the screen-recording panel -- overflow
   *     off the frame's top/left/right edges is fine, but it can never spill onto
   *     the face-cam (bottom) panel.
   *   - "face": clip to the BOTTOM band [topH, height] symmetrically.
   *   - "free" / undefined (DEFAULT): NO clip -- draws exactly as before this
   *     field existed (byte-identical). Overflow may cross the split line.
   */
  band?: "screen" | "face" | "free";
}

/**
 * Compute the cover-fit source rect (in source pixel space) for a region,
 * given the region's aspect ratio, the source's intrinsic size, and a
 * normalized pan/zoom transform.
 *
 * Cover-fit: scale the source so it fully covers the destination region
 * (no letterboxing), cropping whichever axis overflows. `transform.scale`
 * zooms in further on top of that; `transform.x`/`y` pan the crop center
 * within the remaining overflow, each in [-1, 1] where +/-1 pans to the
 * extreme edge of the available crop range.
 */
function computeCoverSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
  transform: PanZoomTransform
): { sx: number; sy: number; sw: number; sh: number } {
  const zoom = Math.max(transform.scale, 0.0001);

  const destAspect = destWidth / destHeight;
  const srcAspect = sourceWidth / sourceHeight;

  // Base cover-fit crop size (before extra zoom): the largest destAspect-
  // shaped rect that fits inside the source.
  let baseCropW: number;
  let baseCropH: number;
  if (srcAspect > destAspect) {
    // Source is relatively wider than dest -> crop source width.
    baseCropH = sourceHeight;
    baseCropW = baseCropH * destAspect;
  } else {
    // Source is relatively taller than dest -> crop source height.
    baseCropW = sourceWidth;
    baseCropH = baseCropW / destAspect;
  }

  // Extra zoom shrinks the crop further (zooming in = smaller source rect).
  const cropW = baseCropW / zoom;
  const cropH = baseCropH / zoom;

  // Available pan range: how far the crop center can move from the source
  // center before the crop rect would exceed the source bounds.
  const maxOffsetX = Math.max(0, (sourceWidth - cropW) / 2);
  const maxOffsetY = Math.max(0, (sourceHeight - cropH) / 2);

  const centerX = sourceWidth / 2 + clamp(transform.x, -1, 1) * maxOffsetX;
  const centerY = sourceHeight / 2 + clamp(transform.y, -1, 1) * maxOffsetY;

  const sx = clamp(centerX - cropW / 2, 0, Math.max(0, sourceWidth - cropW));
  const sy = clamp(centerY - cropH / 2, 0, Math.max(0, sourceHeight - cropH));

  return { sx, sy, sw: Math.min(cropW, sourceWidth), sh: Math.min(cropH, sourceHeight) };
}

/**
 * Draw a labeled placeholder rectangle for a region that has no footage
 * loaded yet, so the split-screen layout stays visible during setup.
 */
function drawPlaceholder(
  ctx: AnyCtx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = "#1c1c1f";
  ctx.fillRect(x, y, w, h);

  // Subtle diagonal hatch so it reads as "placeholder", not a real frame.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 2;
  const step = 48;
  ctx.beginPath();
  for (let d = -h; d < w + h; d += step) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font =
    "600 32px -apple-system, 'SF Pro Text', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

/**
 * Optional per-region "Smart transition" MOTION, already resolved for THIS
 * frame and THIS panel by {@link drawFrame} (which handles the face-vs-screen
 * stagger and easing). Both fields default to a no-op so an absent motion draws
 * the region byte-for-byte as before.
 */
interface RegionMotion {
  /**
   * Zoom-settle scale boost: a multiplier (>= 1) folded onto the region's own
   * `transform.scale`. 1 = no boost (identity). A boost > 1 tightens the crop
   * about the region center via the SAME computeCoverSourceRect path.
   */
  scaleBoost: number;
  /** Slide translate in destination px along x (enters offset, eases to 0). 0 = no slide. */
  translateX: number;
}

const NO_MOTION: RegionMotion = { scaleBoost: 1, translateX: 0 };

/**
 * Draw one region (screen or face) cover-fit + pan/zoomed into a
 * destination band, clipped to that band's bounds.
 *
 * `motion` layers the per-cut Smart transition ON TOP of the region's own
 * pan/zoom, entirely INSIDE this band's clip so it never bleeds across the
 * split line. It is additive and defaults to a no-op ({@link NO_MOTION}): with
 * scaleBoost 1 and translateX 0 the source rect and draw are identical to the
 * pre-transition path.
 */
function drawRegion(
  ctx: AnyCtx2D,
  region: RegionSource,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
  motion: RegionMotion = NO_MOTION
): void {
  if (!region.source || region.sourceWidth <= 0 || region.sourceHeight <= 0) {
    drawPlaceholder(ctx, destX, destY, destW, destH, region.placeholderLabel);
    return;
  }

  // Zoom-settle folds an extra scale onto the region's own transform. When the
  // boost is exactly 1 (no transition / settled) this spreads to an identical
  // transform, so computeCoverSourceRect returns the SAME rect as before.
  const drawTransform: PanZoomTransform =
    motion.scaleBoost === 1
      ? region.transform
      : { ...region.transform, scale: region.transform.scale * motion.scaleBoost };

  const { sx, sy, sw, sh } = computeCoverSourceRect(
    region.sourceWidth,
    region.sourceHeight,
    destW,
    destH,
    drawTransform
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(destX, destY, destW, destH);
  ctx.clip();
  // Slide translate is applied AFTER the clip, so the band stays fixed and only
  // the drawn frame moves within it (edges reveal background, never neighbors).
  // translateX 0 leaves the transform untouched -> byte-identical draw.
  if (motion.translateX !== 0) ctx.translate(motion.translateX, 0);
  // Apply the region's color grade (if any) INSIDE this save/restore, so the
  // surrounding restore() -- which resets ctx.filter as part of the saved
  // drawing state -- clears it after the draw. Empty/absent filter = no-op.
  if (region.filter) ctx.filter = region.filter;
  ctx.drawImage(
    region.source as CanvasImageSource,
    sx,
    sy,
    sw,
    sh,
    destX,
    destY,
    destW,
    destH
  );
  ctx.restore();
}

/**
 * Face-panel stagger: the bottom (face) panel runs its transition this fraction
 * of the window BEHIND the top (screen) panel, so the two halves don't move in
 * perfect lockstep -- a subtle premium touch. Small on purpose (5% of the
 * window); larger reads as a visible desync rather than parallax.
 */
const FACE_STAGGER = 0.05;

/**
 * Resolve the active transition into this panel's {@link RegionMotion} for the
 * current frame. `progressOffset` shifts the panel's position within the window
 * (used to stagger the face panel behind the screen panel); the shifted
 * progress is clamped to [0,1] and re-eased so the effect still starts fully at
 * the cut and fully settles by the window's end.
 *
 * Returns {@link NO_MOTION} for the no-op cases (no transition, type "none",
 * edge progress), which keeps the region's draw byte-identical to the
 * pre-transition path.
 */
function resolveRegionMotion(
  transition: DrawFrameOptions["transition"],
  destW: number,
  progressOffset: number
): RegionMotion {
  if (
    !transition ||
    transition.type === "none" ||
    transition.progress <= 0 ||
    transition.progress >= 1
  ) {
    return NO_MOTION;
  }

  // Shift this panel within the window, then re-ease. clamp keeps a staggered
  // panel from running negative (before the cut) or past settle.
  const shifted = clamp(transition.progress - progressOffset, 0, 1);
  const e = applyEasing(transition.easing, shifted);

  if (transition.type === "slide") {
    // "left" (default) enters from the RIGHT (+destW) and slides left to rest;
    // "right" enters from the LEFT (-destW). Magnitude eases (1 - e) -> 0.
    const dir = transition.direction === "right" ? -1 : 1;
    const translateX = dir * transition.amount * destW * (1 - e);
    return { scaleBoost: 1, translateX };
  }

  // zoom-settle (default): start `amount` larger, ease down to the region's
  // normal scale. boost = 1 + amount*(1-e); at e=1 boost=1 (settled, no-op).
  return { scaleBoost: 1 + transition.amount * (1 - e), translateX: 0 };
}

/** Degrees -> radians for the overlay rotation (the transform carries degrees). */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Draw one free-floating overlay onto the whole 9:16 frame via a plain
 * translate/rotate/scale drawImage in NORMALIZED output space -- NOT the
 * cover-fit region model (computeCoverSourceRect crops; overlays draw the whole
 * source into a dest rect and must never be cropped). Wrapped in save/restore so
 * globalAlpha, transform, and smoothing state never leak to the next draw.
 *
 * Skips (draws nothing) when the source is null or a natural dimension is <= 0,
 * so an unloaded overlay is invisible rather than a broken draw. Never uses
 * shadowBlur (known OOM gotcha inside a transformed loop).
 *
 * `topH` is the screen/face band boundary in px -- the SAME `Math.round(height*
 * ratio)` drawFrame uses for the base composite, so a band clip lines up with the
 * split line to the pixel. When `ov.band` is "screen" the draw is clipped to
 * [0, topH]; "face" clips to [topH, height]; "free"/undefined adds NO clip (the
 * pre-band draw, byte-identical). The clip is set BEFORE the affine transform so
 * it stays in output pixel space, and the single trailing restore() unwinds it
 * together with globalAlpha/transform/smoothing -- balanced save/restore.
 */
function drawOverlay(
  ctx: AnyCtx2D,
  ov: OverlayDraw,
  width: number,
  height: number,
  topH: number
): void {
  if (!ov.source || ov.naturalWidth <= 0 || ov.naturalHeight <= 0) return;

  const t = ov.transform;
  // Natural width occupies `scale` fraction of output width at this scale;
  // height is derived from the intrinsic aspect so the asset never stretches.
  const destW = t.scale * width;
  const destH = destW * (ov.naturalHeight / ov.naturalWidth);
  const cx = t.x * width;
  const cy = t.y * height;

  ctx.save();
  // Band clip (output pixel space, before the affine transform below). "screen"
  // clips overflow to the top band, "face" to the bottom; "free"/undefined skips
  // it so the draw is byte-identical to the pre-band path. The trailing restore()
  // clears this clip along with the rest of the saved state.
  if (ov.band === "screen") {
    ctx.beginPath();
    ctx.rect(0, 0, width, topH);
    ctx.clip();
  } else if (ov.band === "face") {
    ctx.beginPath();
    ctx.rect(0, topH, width, height - topH);
    ctx.clip();
  }
  if (t.opacity < 1) ctx.globalAlpha = t.opacity;
  ctx.translate(cx, cy);
  if (t.rotation !== 0) ctx.rotate(t.rotation * DEG_TO_RAD);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    ov.source as CanvasImageSource,
    -destW / 2,
    -destH / 2,
    destW,
    destH
  );
  ctx.restore();
}

/**
 * Composite the screen (top) and face-cam (bottom) regions into a single
 * 1080x1920 (by default) vertical frame, each cover-fit + pan/zoomed into
 * its band per `splitRatio`.
 *
 * Framework-free: takes a bare 2D context and raw drawable sources so the
 * exact same function drives both the live `PreviewCanvas` (video elements)
 * and the export pipeline (decoded video frames / ImageBitmaps).
 *
 * @param ctx Destination 2D context, already sized to `width x height`
 *            (or pre-scaled for DPR by the caller -- this function draws in
 *            the logical `width x height` coordinate space).
 * @param opts Screen/face sources + transforms, split ratio, output size, and
 *             an optional active Smart transition (zoom-settle / slide).
 */
export function drawFrame(ctx: AnyCtx2D, opts: DrawFrameOptions): void {
  const {
    screen,
    face,
    splitRatio,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    showDivider = true,
    dividerColor = "rgba(255,255,255,0.14)",
    dividerWidth = 2,
    backgroundColor = "#0b0b0c",
    transition,
  } = opts;

  const ratio = clamp(splitRatio, 0, 1);
  const topH = Math.round(height * ratio);
  const bottomH = height - topH;

  // Per-panel Smart-transition motion. The screen (top) leads; the face
  // (bottom) trails by FACE_STAGGER of the window. Both are NO_MOTION when no
  // transition is active, so the two draws below stay byte-identical to before.
  const screenMotion = resolveRegionMotion(transition, width, 0);
  const faceMotion = resolveRegionMotion(transition, width, FACE_STAGGER);

  const prevSmoothing = ctx.imageSmoothingEnabled;
  const prevQuality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Background fill first (covers any rounding gaps between bands).
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  // TOP: screen region.
  drawRegion(ctx, screen, 0, 0, width, topH, screenMotion);

  // BOTTOM: face region.
  drawRegion(ctx, face, 0, topH, width, bottomH, faceMotion);

  // Divider.
  if (showDivider && dividerWidth > 0) {
    ctx.save();
    ctx.fillStyle = dividerColor;
    ctx.fillRect(0, topH - dividerWidth / 2, width, dividerWidth);
    ctx.restore();
  }

  // FREE-FLOATING OVERLAYS -- drawn on top of the base composite + divider,
  // bottom-to-top by z (the caller pre-sorts ascending). This is the LAST draw
  // in drawFrame: captions are NEVER drawn here -- each caller runs drawCaptions
  // AFTER drawFrame returns, so text is the strict top layer above every overlay.
  // Do not append a caption draw after this loop. Absent/empty overlays is a
  // strict no-op -> byte-identical to before.
  if (opts.overlays && opts.overlays.length > 0) {
    // Pass the SAME topH the base composite used, so a "screen"/"face" band clip
    // lines up with the split line to the pixel. "free"/undefined overlays ignore
    // it -> byte-identical to before.
    for (const ov of opts.overlays) drawOverlay(ctx, ov, width, height, topH);
  }

  ctx.imageSmoothingEnabled = prevSmoothing;
  ctx.imageSmoothingQuality = prevQuality;
}
