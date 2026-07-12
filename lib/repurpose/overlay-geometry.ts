// ===========================================================================
// REPURPOSE STUDIO -- overlay canvas geometry (PURE, no React / no DOM)
// ===========================================================================
// The math behind canvas direct-manipulation of a free-floating Overlay:
//   - normalized <-> screen (CSS-pixel) mapping against the preview rect,
//   - the overlay's four rotated corners + a rotated-rect hit-test,
//   - the four drag solvers (move / corner-resize / edge-resize / rotate),
//   - Shift modifiers (axis-lock, 5% scale snap, 15deg rotation snap).
//
// COORDINATE CONTRACT (identical to the compositor's OverlayDraw):
//   - transform.x / transform.y: overlay CENTER as a fraction of output
//     width / height (0..1). 0.5,0.5 = dead center.
//   - transform.scale: the overlay's natural width as a FRACTION OF OUTPUT
//     WIDTH. Height is derived from the intrinsic aspect (naturalHeight /
//     naturalWidth), so the asset is never stretched.
//   - transform.rotation: DEGREES, clockwise, about the overlay center.
//
// The preview canvas is drawn in logical 1080x1920 space but displayed
// CSS-scaled to fill a container rect. Because EVERYTHING here is a FRACTION
// of the output, the same math drives the DOM chrome (which lives in the CSS
// rect) and the compositor (which draws in 1080x1920 / 4K) with no extra code.
// Screen px below always means CSS px inside the preview rect.
//
// Every solver takes a FROZEN start snapshot (`start`) and the CURRENT pointer
// position and returns a fresh transform derived from that snapshot -- never
// from the live transform -- so a gesture never compounds its own output.
// ===========================================================================

import type { OverlayTransform } from "./types";

/** The preview canvas's on-screen box in CSS pixels (from getBoundingClientRect). */
export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point in CSS pixels, absolute (clientX/clientY) or rect-local. */
export interface Point {
  x: number;
  y: number;
}

/** The eight resize handles plus the rotate grip, named by compass position. */
export type HandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "rotate";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Smallest scale an overlay can shrink to (fraction of output width). */
export const MIN_OVERLAY_SCALE = 0.02;
/** Largest scale an overlay can grow to (4x the output width -- deliberate bleed). */
export const MAX_OVERLAY_SCALE = 4;

/** Snap step for Shift+resize: round scale to the nearest 5%. */
const SCALE_SNAP_STEP = 0.05;
/** Snap step for Shift+rotate: round rotation to the nearest 15 degrees. */
const ROTATION_SNAP_STEP = 15;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Convert an absolute client point (clientX/clientY) to NORMALIZED output
 * coordinates (0..1 fraction of the preview rect). Values run outside 0..1 when
 * the pointer is outside the rect -- intentional, so an overlay can be dragged
 * partway off-frame.
 */
export function normFromClient(client: Point, rect: PreviewRect): Point {
  return {
    x: (client.x - rect.left) / rect.width,
    y: (client.y - rect.top) / rect.height,
  };
}

/**
 * The overlay's on-canvas size in NORMALIZED units. Width = scale (by
 * definition). Height is derived from the intrinsic aspect and re-expressed as a
 * fraction of HEIGHT via the rect's aspect ratio, so a normalized box maps to a
 * visually correct rectangle in the (non-square) 9:16 preview.
 *
 * normHalf.x = scale/2 (fraction of width). normHalf.y = the same pixel height
 * expressed as a fraction of the rect HEIGHT: (scale * rectWidth * aspect) /
 * rectHeight / 2.
 */
function normHalfExtents(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect
): Point {
  const aspect = naturalHeight > 0 && naturalWidth > 0 ? naturalHeight / naturalWidth : 1;
  const halfW = transform.scale / 2; // fraction of WIDTH
  const destWidthPx = transform.scale * rect.width;
  const destHeightPx = destWidthPx * aspect;
  const halfH = rect.height > 0 ? destHeightPx / rect.height / 2 : 0; // fraction of HEIGHT
  return { x: halfW, y: halfH };
}

/**
 * The overlay's four corners in NORMALIZED output space, rotation applied,
 * ordered [nw, ne, se, sw]. Because x is a fraction of width and y a fraction of
 * height (different pixel scales), rotation is done in PIXEL space using the
 * rect, then mapped back to normalized -- otherwise a rotated box would shear in
 * the non-square 9:16 frame.
 */
export function overlayCornersNorm(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect
): [Point, Point, Point, Point] {
  const half = normHalfExtents(transform, naturalWidth, naturalHeight, rect);
  // Half-extents in PIXELS (rect-local) for a correct, non-sheared rotation.
  const hxPx = half.x * rect.width;
  const hyPx = half.y * rect.height;
  const cxPx = transform.x * rect.width;
  const cyPx = transform.y * rect.height;
  const theta = transform.rotation * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Local corner offsets (nw, ne, se, sw) in px, then rotate + translate.
  const locals: Array<[number, number]> = [
    [-hxPx, -hyPx],
    [hxPx, -hyPx],
    [hxPx, hyPx],
    [-hxPx, hyPx],
  ];
  const out = locals.map(([lx, ly]) => {
    const px = cxPx + lx * cos - ly * sin;
    const py = cyPx + lx * sin + ly * cos;
    return { x: px / rect.width, y: py / rect.height };
  });
  return out as [Point, Point, Point, Point];
}

/**
 * Hit-test a NORMALIZED point against a rotated overlay rectangle. Inverts the
 * overlay transform (translate to center, un-rotate) in PIXEL space, then does a
 * plain axis-aligned bounds check in the overlay's local frame. Returns true
 * when the point is inside the (unrotated) rectangle.
 *
 * `padPx` inflates the box by that many CSS px on every side so the grab
 * tolerance is a little forgiving (a thin overlay is still easy to click).
 */
export function hitTestOverlay(
  norm: Point,
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect,
  padPx = 0
): boolean {
  const half = normHalfExtents(transform, naturalWidth, naturalHeight, rect);
  const hxPx = half.x * rect.width;
  const hyPx = half.y * rect.height;
  const cxPx = transform.x * rect.width;
  const cyPx = transform.y * rect.height;
  const pxAbs = norm.x * rect.width;
  const pyAbs = norm.y * rect.height;
  const theta = -transform.rotation * DEG_TO_RAD; // invert rotation
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dx = pxAbs - cxPx;
  const dy = pyAbs - cyPx;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return (
    Math.abs(localX) <= hxPx + padPx && Math.abs(localY) <= hyPx + padPx
  );
}

// ---------------------------------------------------------------------------
// Drag solvers. Each takes the FROZEN start transform + snapshot and the
// current pointer position, returning a fresh transform (never compounding).
// ---------------------------------------------------------------------------

/** A frozen snapshot captured at pointer-down for a resize/rotate gesture. */
export interface GestureStart {
  transform: OverlayTransform;
  naturalWidth: number;
  naturalHeight: number;
  /** Pointer position at gesture start, NORMALIZED. */
  pointerNorm: Point;
}

/**
 * MOVE solver: translate the overlay center by the pointer's normalized delta
 * from the gesture start. Shift axis-locks to whichever axis has moved more.
 */
export function solveMove(
  start: GestureStart,
  pointerNorm: Point,
  shift: boolean
): OverlayTransform {
  let dx = pointerNorm.x - start.pointerNorm.x;
  let dy = pointerNorm.y - start.pointerNorm.y;
  if (shift) {
    // Axis-lock: compare deltas in PIXEL terms would need the rect, but the
    // normalized deltas are close enough for a lock decision (both are small
    // fractions); keep the dominant axis, zero the other.
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  return {
    ...start.transform,
    x: start.transform.x + dx,
    y: start.transform.y + dy,
  };
}

/**
 * The world-space (normalized) position of a named corner for a given
 * transform. Used by the corner-resize solver to pin the OPPOSITE corner.
 */
function cornerNorm(
  handle: "nw" | "ne" | "se" | "sw",
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect
): Point {
  const [nw, ne, se, sw] = overlayCornersNorm(
    transform,
    naturalWidth,
    naturalHeight,
    rect
  );
  switch (handle) {
    case "nw":
      return nw;
    case "ne":
      return ne;
    case "se":
      return se;
    case "sw":
      return sw;
  }
}

const OPPOSITE_CORNER: Record<"nw" | "ne" | "se" | "sw", "nw" | "ne" | "se" | "sw"> = {
  nw: "se",
  ne: "sw",
  se: "nw",
  sw: "ne",
};

/**
 * CORNER-RESIZE solver (aspect-locked): the OPPOSITE corner is the fixed anchor.
 * We measure how far the dragged corner moved from the anchor (in the overlay's
 * OWN rotated frame) versus at gesture start, take the ratio along the local X
 * axis as the new scale factor, then reposition the center so the anchor corner
 * stays put. Rotation is preserved. Shift snaps the resulting scale to 5%.
 */
export function solveCornerResize(
  start: GestureStart,
  handle: "nw" | "ne" | "se" | "sw",
  pointerNorm: Point,
  rect: PreviewRect,
  shift: boolean
): OverlayTransform {
  const anchorHandle = OPPOSITE_CORNER[handle];
  const anchor = cornerNorm(
    anchorHandle,
    start.transform,
    start.naturalWidth,
    start.naturalHeight,
    rect
  );

  // Work in PIXELS in the overlay's local (un-rotated) frame so aspect holds in
  // the non-square 9:16 canvas. Vector anchor -> pointer, un-rotated.
  const theta = -start.transform.rotation * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const anchorPx = { x: anchor.x * rect.width, y: anchor.y * rect.height };
  const pointerPx = { x: pointerNorm.x * rect.width, y: pointerNorm.y * rect.height };
  const vx = pointerPx.x - anchorPx.x;
  const vy = pointerPx.y - anchorPx.y;
  const localVX = vx * cos - vy * sin; // along the box width axis

  // The box's full width in px at start (scale * rectWidth). New width is the
  // absolute local-X distance from the anchor. Guard against a zero/negative
  // collapse; the sign is absorbed (the anchor is the opposite corner, so the
  // dragged corner should stay on the same side, but clamp keeps it stable).
  const startWidthPx = start.transform.scale * rect.width;
  const newWidthPx = Math.abs(localVX);
  let nextScale =
    startWidthPx > 0
      ? clamp(
          (newWidthPx / startWidthPx) * start.transform.scale,
          MIN_OVERLAY_SCALE,
          MAX_OVERLAY_SCALE
        )
      : start.transform.scale;
  if (shift) nextScale = snapScale(nextScale);

  // Reposition the center so the ANCHOR corner is invariant: build the
  // provisional transform at the new scale (center unchanged), find where the
  // anchor corner would land, and shift the center by the anchor's drift.
  const provisional: OverlayTransform = { ...start.transform, scale: nextScale };
  const anchorNow = cornerNorm(
    anchorHandle,
    provisional,
    start.naturalWidth,
    start.naturalHeight,
    rect
  );
  return {
    ...provisional,
    x: provisional.x + (anchor.x - anchorNow.x),
    y: provisional.y + (anchor.y - anchorNow.y),
  };
}

const OPPOSITE_EDGE: Record<"n" | "e" | "s" | "w", "n" | "e" | "s" | "w"> = {
  n: "s",
  e: "w",
  s: "n",
  w: "e",
};

/**
 * The normalized midpoint of a named edge for a given transform (the anchor for
 * an edge-resize is the OPPOSITE edge's midpoint).
 */
function edgeMidNorm(
  edge: "n" | "e" | "s" | "w",
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect
): Point {
  const [nw, ne, se, sw] = overlayCornersNorm(
    transform,
    naturalWidth,
    naturalHeight,
    rect
  );
  switch (edge) {
    case "n":
      return { x: (nw.x + ne.x) / 2, y: (nw.y + ne.y) / 2 };
    case "e":
      return { x: (ne.x + se.x) / 2, y: (ne.y + se.y) / 2 };
    case "s":
      return { x: (se.x + sw.x) / 2, y: (se.y + sw.y) / 2 };
    case "w":
      return { x: (sw.x + nw.x) / 2, y: (sw.y + nw.y) / 2 };
  }
}

/**
 * EDGE-RESIZE solver: media is aspect-locked, so an edge drag is UNIFORM (it
 * scales the whole overlay, not one axis -- a non-uniform stretch would distort
 * the media). The OPPOSITE edge midpoint is the fixed anchor. We take the local
 * distance from the anchor along the dragged edge's normal as the new size along
 * that axis, convert to a uniform scale, and reposition so the anchor edge stays
 * put. Shift snaps to 5%.
 *
 * N/S edges scale by HEIGHT change (mapped back to width scale via aspect); E/W
 * edges scale by WIDTH change.
 */
export function solveEdgeResize(
  start: GestureStart,
  edge: "n" | "e" | "s" | "w",
  pointerNorm: Point,
  rect: PreviewRect,
  shift: boolean
): OverlayTransform {
  const anchorEdge = OPPOSITE_EDGE[edge];
  const anchor = edgeMidNorm(
    anchorEdge,
    start.transform,
    start.naturalWidth,
    start.naturalHeight,
    rect
  );

  const theta = -start.transform.rotation * DEG_TO_RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const anchorPx = { x: anchor.x * rect.width, y: anchor.y * rect.height };
  const pointerPx = { x: pointerNorm.x * rect.width, y: pointerNorm.y * rect.height };
  const vx = pointerPx.x - anchorPx.x;
  const vy = pointerPx.y - anchorPx.y;
  const localVX = vx * cos - vy * sin; // width axis
  const localVY = vx * sin + vy * cos; // height axis

  const aspect =
    start.naturalHeight > 0 && start.naturalWidth > 0
      ? start.naturalHeight / start.naturalWidth
      : 1;
  const startWidthPx = start.transform.scale * rect.width;
  const startHeightPx = startWidthPx * aspect;

  let nextScale: number;
  if (edge === "e" || edge === "w") {
    const newWidthPx = Math.abs(localVX);
    nextScale =
      startWidthPx > 0
        ? (newWidthPx / startWidthPx) * start.transform.scale
        : start.transform.scale;
  } else {
    const newHeightPx = Math.abs(localVY);
    nextScale =
      startHeightPx > 0
        ? (newHeightPx / startHeightPx) * start.transform.scale
        : start.transform.scale;
  }
  nextScale = clamp(nextScale, MIN_OVERLAY_SCALE, MAX_OVERLAY_SCALE);
  if (shift) nextScale = snapScale(nextScale);

  const provisional: OverlayTransform = { ...start.transform, scale: nextScale };
  const anchorNow = edgeMidNorm(
    anchorEdge,
    provisional,
    start.naturalWidth,
    start.naturalHeight,
    rect
  );
  return {
    ...provisional,
    x: provisional.x + (anchor.x - anchorNow.x),
    y: provisional.y + (anchor.y - anchorNow.y),
  };
}

/**
 * ROTATE solver: the angle from the overlay center to the pointer, in degrees.
 * We take the delta between the current pointer angle and the pointer angle at
 * gesture start, and add it to the start rotation, so grabbing the grip anywhere
 * rotates smoothly from there (no snap-to-pointer jump). Shift snaps to 15deg.
 *
 * Angles are computed in PIXEL space (atan2 of the rect-scaled delta) so the
 * rotation is visually correct in the non-square canvas.
 */
export function solveRotate(
  start: GestureStart,
  pointerNorm: Point,
  rect: PreviewRect,
  shift: boolean
): OverlayTransform {
  const cxPx = start.transform.x * rect.width;
  const cyPx = start.transform.y * rect.height;
  const startAngle =
    Math.atan2(
      start.pointerNorm.y * rect.height - cyPx,
      start.pointerNorm.x * rect.width - cxPx
    ) * RAD_TO_DEG;
  const nowAngle =
    Math.atan2(pointerNorm.y * rect.height - cyPx, pointerNorm.x * rect.width - cxPx) *
    RAD_TO_DEG;
  let rotation = start.transform.rotation + (nowAngle - startAngle);
  // Normalize into (-180, 180] for a stable readout.
  rotation = ((rotation % 360) + 540) % 360 - 180;
  if (shift) rotation = snapRotation(rotation);
  return { ...start.transform, rotation };
}

/** Round a scale to the nearest 5% (SCALE_SNAP_STEP), clamped to the valid range. */
export function snapScale(scale: number): number {
  const snapped = Math.round(scale / SCALE_SNAP_STEP) * SCALE_SNAP_STEP;
  return clamp(snapped, MIN_OVERLAY_SCALE, MAX_OVERLAY_SCALE);
}

/** Round a rotation to the nearest 15deg (ROTATION_SNAP_STEP), kept in (-180, 180]. */
export function snapRotation(rotation: number): number {
  const snapped = Math.round(rotation / ROTATION_SNAP_STEP) * ROTATION_SNAP_STEP;
  return ((snapped % 360) + 540) % 360 - 180;
}

// ===========================================================================
// SNAP ENGINE -- editor-only alignment guides (Konva getGuides + tldraw feel).
// ===========================================================================
// Purely geometric: given the dragged overlay's current (un-snapped) transform
// and a set of normalized target lines, it finds the single best sub-threshold
// snap PER AXIS and returns a nudged transform plus the guide line(s) to draw.
//
// This is EDITOR CHROME ONLY. Neither the returned guides nor any of this math
// ever touches the compositor (lib/repurpose/compositor.ts) or the export
// (lib/repurpose/export-short.ts) -- exactly like the alignment grid, it
// lives above the canvas as pointer-events:none DOM and never bakes into a
// frame. The snapped transform IS persisted (it's the real overlay position);
// the guide lines are the ephemeral, view-only part.
//
// STICKINESS: the caller must re-run solveSnap every frame from the TRUE pointer-
// derived transform (the raw solveMove output), never from the previous frame's
// snapped result. Feeding snapped output back in would make the overlay glue to a
// line and never release. Recomputing from the un-snapped truth each frame is
// what gives the natural "pull in, then break free" feel.
//
// ROTATION: a rotated overlay snaps by its AXIS-ALIGNED BOUNDING BOX (min/max of
// the four rotated corners), so its visual left/right/top/bottom edges line up
// with targets even when the box is tilted; the center still snaps by
// transform.x / transform.y.
// ===========================================================================

/** One guide line to draw: 'v' = vertical (x = coord), 'h' = horizontal (y = coord). */
export interface SnapGuide {
  orientation: "v" | "h";
  /** Normalized 0..1 position of the guide line along its axis. */
  coord: number;
}

/** The candidate target lines to snap to, per axis, in normalized 0..1 space. */
export interface SnapTargets {
  /** Vertical lines (constant X) -- the dragged overlay's X edges snap to these. */
  vertical: number[];
  /** Horizontal lines (constant Y) -- the dragged overlay's Y edges snap to these. */
  horizontal: number[];
}

/** The result of a snap solve: the (possibly nudged) transform + guides to draw. */
export interface SnapResult {
  transform: OverlayTransform;
  guides: SnapGuide[];
}

/** Default snap pull distance, in CSS/screen px, converted per-axis to normalized. */
const DEFAULT_SNAP_THRESHOLD_PX = 6;

/**
 * The overlay's AXIS-ALIGNED bounding box in NORMALIZED output space: the min/max
 * of its four rotated corners (from overlayCornersNorm), plus the center
 * (transform.x, transform.y). For an un-rotated overlay this is just the box; for
 * a rotated one it's the tightest upright box that contains it -- which is what
 * we want snapping to reason about, so the visible left/right/top/bottom edges
 * align with targets regardless of tilt.
 */
export function overlayAABBNorm(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect
): { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number } {
  const corners = overlayCornersNorm(transform, naturalWidth, naturalHeight, rect);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, minY, maxX, maxY, cx: transform.x, cy: transform.y };
}

/** De-dupe near-equal normalized coords (within ~0.5px of the smaller preview axis). */
function dedupeCoords(coords: number[]): number[] {
  const EPS = 0.001; // ~0.5px on a ~500px preview -- close enough to be one line
  const sorted = [...coords].sort((a, b) => a - b);
  const out: number[] = [];
  for (const c of sorted) {
    if (out.length === 0 || Math.abs(c - out[out.length - 1]) > EPS) out.push(c);
  }
  return out;
}

/**
 * Equal-gap candidates for ONE axis. `boxes` are the OTHER overlays' [min,max]
 * extents on this axis; `dHalf` is the dragged box's half-extent on this axis.
 * For every existing pair of neighbors we measure the gap between them, then for
 * each neighbor face we propose a CENTER coordinate for the dragged box placed
 * exactly that gap away (so the dragged overlay clicks in when it mirrors an
 * existing rhythm). Pushed as center lines the dragged box's cx/cy snaps to.
 */
function addEqualGapLines(
  outLines: number[],
  boxes: Array<[number, number]>,
  dHalf: number
): void {
  if (boxes.length < 2) return;
  const sorted = [...boxes].sort((a, b) => a[0] - b[0]);
  // Existing adjacent gaps between successive neighbors.
  const gaps: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const g = sorted[i + 1][0] - sorted[i][1]; // next.min - cur.max
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  for (const g of gaps) {
    // Place dragged box just LEFT of the leftmost neighbor, one gap away:
    // its max = first.min - g  ->  center = first.min - g - dHalf.
    outLines.push(first[0] - g - dHalf);
    // Just RIGHT of the rightmost neighbor: its min = last.max + g ->
    // center = last.max + g + dHalf.
    outLines.push(last[1] + g + dHalf);
  }
}

/**
 * Build the full set of snap target lines for a drag: the frame's own reference
 * lines plus every OTHER overlay's edges/center (overlay-to-overlay alignment).
 *
 *   vertical (X):  frame left/center/right {0, 0.5, 1};  optional rule-of-thirds
 *                  {1/3, 2/3};  each other overlay's AABB minX / cx / maxX.
 *   horizontal (Y): frame top/center/bottom {0, 0.5, 1};  THE SPLIT SEAM
 *                  {splitRatio};  optional thirds {1/3, 2/3};  each other
 *                  overlay's AABB minY / cy / maxY.
 *
 * The split seam is a first-class horizontal target so overlays snap cleanly to
 * the boundary between the screen band and the face cam. Coords are de-duped so a
 * seam that coincides with a frame line doesn't produce a doubled guide.
 */
export function buildSnapTargets(opts: {
  splitRatio: number;
  thirds?: boolean;
  others?: Array<{
    transform: OverlayTransform;
    naturalWidth: number;
    naturalHeight: number;
  }>;
  rect: PreviewRect;
  /**
   * The dragged overlay's own intrinsics. Required to compute EQUAL-GAP snap
   * candidates: those lines depend on the dragged box's size (a gap-match places
   * its FAR edge, so we back out its own extent). Omit to skip equal-gap.
   */
  dragged?: {
    naturalWidth: number;
    naturalHeight: number;
    scale: number;
    rotation: number;
  };
}): SnapTargets {
  const { splitRatio, thirds, others, rect, dragged } = opts;

  const vertical: number[] = [0, 0.5, 1];
  const horizontal: number[] = [0, 0.5, 1, splitRatio];

  if (thirds) {
    vertical.push(1 / 3, 2 / 3);
    horizontal.push(1 / 3, 2 / 3);
  }

  // Overlay-to-overlay: add every OTHER overlay's AABB edges + center on each axis.
  if (others) {
    const vBoxes: Array<[number, number]> = [];
    const hBoxes: Array<[number, number]> = [];
    for (const o of others) {
      const box = overlayAABBNorm(o.transform, o.naturalWidth, o.naturalHeight, rect);
      vertical.push(box.minX, box.cx, box.maxX);
      horizontal.push(box.minY, box.cy, box.maxY);
      vBoxes.push([box.minX, box.maxX]);
      hBoxes.push([box.minY, box.maxY]);
    }

    // EQUAL-GAP: if we know the dragged box's extent, add candidate lines so the
    // dragged overlay snaps when ITS gap to a neighbor equals a gap that already
    // exists between two other neighbors. A candidate is expressed as the target
    // CENTER coordinate for the dragged box, which solveSnap already snaps
    // [minX,cx,maxX] / [minY,cy,maxY] against (cx/cy match).
    if (dragged) {
      const dBox = overlayAABBNorm(
        { x: 0.5, y: 0.5, scale: dragged.scale, rotation: dragged.rotation },
        dragged.naturalWidth,
        dragged.naturalHeight,
        rect
      );
      const dHalfW = (dBox.maxX - dBox.minX) / 2;
      const dHalfH = (dBox.maxY - dBox.minY) / 2;
      addEqualGapLines(vertical, vBoxes, dHalfW);
      addEqualGapLines(horizontal, hBoxes, dHalfH);
    }
  }

  return {
    vertical: dedupeCoords(vertical),
    horizontal: dedupeCoords(horizontal),
  };
}

/**
 * Resolve the best snap for the three edges of one axis against that axis's
 * target lines. Over every (targetLine, draggedEdge) pair whose gap is under the
 * threshold, pick the SMALLEST gap -- that single winner decides the whole nudge.
 *
 * The nudge is `line - edge`: the amount to shift the overlay ALONG this axis so
 * the winning edge lands exactly on the winning line (min/center/max all share
 * one translation, so shifting by the winner's offset moves the whole overlay as
 * a rigid body -- no distortion). Returns the delta to add to the axis position
 * and the coord of the guide line to draw, or null when nothing is in range.
 */
function bestAxisSnap(
  edges: number[],
  lines: number[],
  threshold: number
): { delta: number; line: number } | null {
  let best: { delta: number; line: number; gap: number } | null = null;
  for (const line of lines) {
    for (const edge of edges) {
      const gap = Math.abs(line - edge);
      if (gap < threshold && (best === null || gap < best.gap)) {
        best = { delta: line - edge, line, gap };
      }
    }
  }
  return best ? { delta: best.delta, line: best.line } : null;
}

/**
 * The Konva getGuides core: snap the dragged overlay to the nearest target line
 * on each axis INDEPENDENTLY (both axes can snap in the same frame). The pull
 * distance is a constant SCREEN feel -- `thresholdPx` (default 6) converted to a
 * per-axis normalized threshold via the preview rect, so the stickiness is the
 * same on-screen regardless of how large the preview is drawn.
 *
 * Edges snapped per axis: X = [minX, cx, maxX], Y = [minY, cy, maxY] from the
 * overlay's AABB (rotation-aware). The winning edge's offset is applied as a
 * pure translation to transform.x / transform.y -- scale and rotation are never
 * touched. A guide is emitted for each axis that snapped.
 *
 * NOTE: pass the TRUE (un-snapped) transform every frame -- see the header note
 * on stickiness -- otherwise the overlay glues to lines and never releases.
 */
export function solveSnap(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect,
  targets: SnapTargets,
  opts?: { thresholdPx?: number }
): SnapResult {
  const thresholdPx = opts?.thresholdPx ?? DEFAULT_SNAP_THRESHOLD_PX;
  // Screen-space feel constant: same px pull on either axis => different
  // normalized thresholds because the rect is not square (9:16).
  const thresholdX = rect.width > 0 ? thresholdPx / rect.width : 0;
  const thresholdY = rect.height > 0 ? thresholdPx / rect.height : 0;

  const box = overlayAABBNorm(transform, naturalWidth, naturalHeight, rect);
  const guides: SnapGuide[] = [];
  let x = transform.x;
  let y = transform.y;

  // X axis: left / center / right edges vs the vertical target lines.
  const snapX = bestAxisSnap(
    [box.minX, box.cx, box.maxX],
    targets.vertical,
    thresholdX
  );
  if (snapX) {
    x = transform.x + snapX.delta;
    guides.push({ orientation: "v", coord: snapX.line });
  }

  // Y axis: top / center / bottom edges vs the horizontal target lines (frame,
  // thirds, other overlays, AND the split seam).
  const snapY = bestAxisSnap(
    [box.minY, box.cy, box.maxY],
    targets.horizontal,
    thresholdY
  );
  if (snapY) {
    y = transform.y + snapY.delta;
    guides.push({ orientation: "h", coord: snapY.line });
  }

  return { transform: { ...transform, x, y }, guides };
}

/**
 * HARD top-half keep-out: after any move/resize, guarantee the overlay's bottom
 * edge never crosses the split seam. If the overlay's AABB maxY exceeds
 * splitRatio, translate the whole overlay UP by exactly the overshoot so its
 * bottom lands on the seam. Only ever TRANSLATES -- scale and rotation are
 * preserved, so the media is never squashed to fit.
 *
 * If the overlay is taller than the entire top band, clamping its bottom to the
 * seam will push its top edge above y=0. That top overflow is intentional and
 * allowed (it's the ghosted-overflow case renders); only the bottom is a
 * hard boundary here. Pure -- returns a corrected transform, mutates nothing.
 */
export function clampOverlayToTopHalf(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect,
  splitRatio: number
): OverlayTransform {
  const box = overlayAABBNorm(transform, naturalWidth, naturalHeight, rect);
  if (box.maxY > splitRatio) {
    const overshoot = box.maxY - splitRatio;
    return { ...transform, y: transform.y - overshoot };
  }
  return transform;
}

// ===========================================================================
// MULTI-SELECT ALIGN / DISTRIBUTE (pure geometry over overlay AABBs).
// ===========================================================================
// Given >= 2 overlays' transforms + intrinsics, compute a NEW transform per
// overlay that aligns them to a shared edge/center, or distributes them so the
// gaps between neighbors are equal. Everything is a pure translation of
// transform.x / transform.y (scale + rotation are never touched), computed from
// each overlay's rotation-aware AABB (overlayAABBNorm) so the VISUAL edges line
// up even when a box is tilted. Editor-only, like the snap engine -- it produces
// positions the caller persists via updateOverlayTransform; it never touches the
// compositor/export. The caller is responsible for the top-half clamp AFTER
// (clampOverlayToTopHalf), so an aligned/distributed overlay can't cross the seam.
// ===========================================================================

/** Which edge/center to align the selection's AABBs to. */
export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
/** Which axis to distribute along ("h" = spread across X, "v" = down Y). */
export type DistributeAxis = "h" | "v";

/** One overlay's inputs for an align/distribute solve. */
export interface AlignItem {
  id: string;
  transform: OverlayTransform;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * ALIGN: translate each item so the chosen edge/center of its AABB lands on the
 * shared reference coordinate. The reference is taken from the WHOLE selection's
 * combined bounds: left/top = min edge, right/bottom = max edge, h/v-center =
 * center of the combined bounds. Only the relevant axis (x for left/hcenter/
 * right, y for top/vcenter/bottom) is moved; the other is untouched. Returns a
 * map id -> new transform for ONLY the items that actually move (a pure delta).
 */
export function alignOverlays(
  items: AlignItem[],
  edge: AlignEdge,
  rect: PreviewRect
): Map<string, OverlayTransform> {
  const out = new Map<string, OverlayTransform>();
  if (items.length < 2) return out;

  const boxes = items.map((it) => ({
    it,
    box: overlayAABBNorm(it.transform, it.naturalWidth, it.naturalHeight, rect),
  }));

  // Combined selection bounds on each axis.
  const minX = Math.min(...boxes.map((b) => b.box.minX));
  const maxX = Math.max(...boxes.map((b) => b.box.maxX));
  const minY = Math.min(...boxes.map((b) => b.box.minY));
  const maxY = Math.max(...boxes.map((b) => b.box.maxY));

  for (const { it, box } of boxes) {
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = minX - box.minX;
        break;
      case "right":
        dx = maxX - box.maxX;
        break;
      case "hcenter":
        dx = (minX + maxX) / 2 - (box.minX + box.maxX) / 2;
        break;
      case "top":
        dy = minY - box.minY;
        break;
      case "bottom":
        dy = maxY - box.maxY;
        break;
      case "vcenter":
        dy = (minY + maxY) / 2 - (box.minY + box.maxY) / 2;
        break;
    }
    if (dx !== 0 || dy !== 0) {
      out.set(it.id, {
        ...it.transform,
        x: it.transform.x + dx,
        y: it.transform.y + dy,
      });
    }
  }
  return out;
}

/**
 * DISTRIBUTE: hold the two OUTERMOST items (by AABB min-edge along the axis)
 * fixed and reposition every interior item so the GAPS between successive AABBs
 * are equal. Needs >= 3 items to do anything (2 items have no interior gap to
 * equalize). We sort by the item's min-edge on the axis, sum the interior item
 * sizes, spread the leftover span as N+1 equal gaps, and lay the interiors out
 * left-to-right (or top-to-bottom). Only the axis coordinate moves; returns a
 * map id -> new transform for the items that move. Pure -- caller clamps after.
 */
export function distributeOverlays(
  items: AlignItem[],
  axis: DistributeAxis,
  rect: PreviewRect
): Map<string, OverlayTransform> {
  const out = new Map<string, OverlayTransform>();
  if (items.length < 3) return out; // nothing to equalize with < 3

  const boxes = items.map((it) => {
    const box = overlayAABBNorm(it.transform, it.naturalWidth, it.naturalHeight, rect);
    const min = axis === "h" ? box.minX : box.minY;
    const max = axis === "h" ? box.maxX : box.maxY;
    return { it, min, max, size: max - min };
  });

  // Sort by leading edge along the axis; the ends stay fixed.
  boxes.sort((a, b) => a.min - b.min);
  const first = boxes[0];
  const last = boxes[boxes.length - 1];

  // Total free span between the outer items' inner faces, minus the interior
  // items' own sizes, split into (interiorCount + 1) equal gaps.
  const span = last.min - first.max; // gap span from first's right face to last's left face
  const interior = boxes.slice(1, -1);
  const interiorSizeSum = interior.reduce((s, b) => s + b.size, 0);
  const gap = (span - interiorSizeSum) / (interior.length + 1);

  // Walk the interior items left->right, each starting one `gap` after the prior
  // face. cursor = the coordinate the NEXT interior item's leading edge lands on.
  let cursor = first.max + gap;
  for (const b of interior) {
    const targetMin = cursor;
    const delta = targetMin - b.min; // pure translation of this item on the axis
    if (delta !== 0) {
      out.set(b.it.id, {
        ...b.it.transform,
        x: axis === "h" ? b.it.transform.x + delta : b.it.transform.x,
        y: axis === "v" ? b.it.transform.y + delta : b.it.transform.y,
      });
    }
    cursor = targetMin + b.size + gap;
  }
  return out;
}

// ===========================================================================
// MAGNETIC PRE-SNAP -- the "wants to click in" attraction before the detent.
// ===========================================================================
// solveSnap is a hard DETENT: inside the threshold the edge jumps exactly onto
// the line. On its own that reads as a binary click. Canva / Figma feel
// MAGNETIC because just OUTSIDE the detent the object already drifts a fraction
// toward the line -- a soft pull that grows as you approach, then the detent
// grabs. This is that soft pull, applied to the TRUE (un-snapped) transform
// BEFORE solveSnap runs. Inside the detent band it is a no-op (solveSnap owns
// that band); in the ATTRACT band (detent .. PULL_RANGE x detent) it eases the
// axis a small fraction toward the nearest line so the object leans in.
//
// Like everything here it is PURE and EDITOR-ONLY: it nudges the position the
// caller will persist; it never touches the compositor or export. And, like
// solveSnap, the caller MUST feed it the un-snapped truth every frame -- the
// pull is recomputed from scratch, never fed its own output, so releasing past
// the range lets the object break free cleanly.
// ===========================================================================

/** How far OUT (as a multiple of the detent threshold) the soft pull reaches. */
const MAGNET_PULL_RANGE = 2.4;
/**
 * Peak fraction of the remaining gap pulled per frame at the detent edge. Small
 * so it reads as a lean, not a yank; it also fades to 0 at the outer range so
 * the object is never dragged from far away. The detent (solveSnap) still does
 * the final exact landing, so this never needs to fully close the gap.
 */
const MAGNET_PULL_STRENGTH = 0.35;

/**
 * The strongest sub-range pull for one axis: over every (line, edge) pair, find
 * the one whose gap is in the ATTRACT band (>= detent threshold, < PULL_RANGE x
 * threshold) and closest to the line, then return a fraction of its signed gap.
 * The fraction ramps from PULL_STRENGTH at the inner edge (just outside the
 * detent) down to 0 at the outer edge, so approach accelerates smoothly into the
 * detent and distant lines exert nothing. Returns 0 when nothing is in the band
 * (including when an edge is already inside the detent -- solveSnap owns that).
 */
function bestAxisMagnet(
  edges: number[],
  lines: number[],
  threshold: number
): number {
  const outer = threshold * MAGNET_PULL_RANGE;
  let best: { delta: number; gap: number } | null = null;
  for (const line of lines) {
    for (const edge of edges) {
      const signed = line - edge;
      const gap = Math.abs(signed);
      // Only the ATTRACT band: inside `threshold` is the detent's job.
      if (gap >= threshold && gap < outer && (best === null || gap < best.gap)) {
        best = { delta: signed, gap };
      }
    }
  }
  if (!best) return 0;
  // Falloff 1 -> 0 across the attract band (inner -> outer), eased (smoothstep)
  // so the lean starts gentle and firms up as the detent nears.
  const t = 1 - (best.gap - threshold) / (outer - threshold); // 1 at inner, 0 at outer
  const eased = t * t * (3 - 2 * t);
  return best.delta * MAGNET_PULL_STRENGTH * eased;
}

/**
 * MAGNETIC PULL: given the un-snapped transform and the same targets solveSnap
 * uses, return a transform nudged a small fraction toward the nearest line on
 * each axis that is in the attract band (just outside the detent). Threshold is
 * the SAME screen-px feel constant as solveSnap, so the pull band scales with
 * the detent. Only ever TRANSLATES x / y -- scale and rotation are untouched --
 * and both axes attract independently. Feed the TRUE pointer-derived transform
 * (solveMove output) every frame; the detent (solveSnap) runs AFTER this.
 */
export function applyMagneticPull(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect,
  targets: SnapTargets,
  opts?: { thresholdPx?: number }
): OverlayTransform {
  const thresholdPx = opts?.thresholdPx ?? DEFAULT_SNAP_THRESHOLD_PX;
  const thresholdX = rect.width > 0 ? thresholdPx / rect.width : 0;
  const thresholdY = rect.height > 0 ? thresholdPx / rect.height : 0;
  const box = overlayAABBNorm(transform, naturalWidth, naturalHeight, rect);
  const pullX = bestAxisMagnet([box.minX, box.cx, box.maxX], targets.vertical, thresholdX);
  const pullY = bestAxisMagnet([box.minY, box.cy, box.maxY], targets.horizontal, thresholdY);
  if (pullX === 0 && pullY === 0) return transform;
  return { ...transform, x: transform.x + pullX, y: transform.y + pullY };
}
