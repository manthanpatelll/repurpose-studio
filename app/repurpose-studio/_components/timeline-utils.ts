// ===========================================================================
// REPURPOSE STUDIO -- Timeline math helpers
// ===========================================================================
// Pure functions shared by Timeline.tsx and its sub-components. Kept out of
// the component file so drag-math can be unit-tested in isolation later.
// ===========================================================================

export const MIN_PPS = 20; // pixels per second, fully zoomed out
export const MAX_PPS = 400; // pixels per second, fully zoomed in
export const DEFAULT_PPS = 90;
export const ZOOM_STEP = 1.25;

export const TRACK_HEIGHT = 56;
export const TRACK_GAP = 6;
export const RULER_HEIGHT = 28;
export const SNAP_PX = 8; // snap threshold in screen pixels, independent of zoom

// One overlay sub-lane's height. The Overlay row grows DYNAMICALLY: its height is
// laneCount * OVERLAY_LANE_HEIGHT, where laneCount is the max number of overlays
// that are visible at the same instant (greedy calendar packing, no fixed cap).
// A single non-overlapping overlay row is one lane tall; N mutually-overlapping
// overlays stack into N lanes and the row simply gets taller (the timeline body
// scrolls vertically when it does). Smaller than a full TRACK_HEIGHT because an
// overlay lane is a thin media strip, not a waveform-bearing scene track.
export const OVERLAY_LANE_HEIGHT = 30;
export const OVERLAY_LANE_GAP = 3;

/** Format seconds as mm:ss (or mm:ss.d when sub-second precision matters). */
export function formatTimecode(seconds: number, withTenths = false): string {
  const clamped = Math.max(0, seconds);
  if (withTenths) {
    // Round to tenths ONCE, then derive mins+secs from that rounded total, so
    // the minute rolls over consistently. Deriving mins from the raw value and
    // formatting secs with toFixed(1) separately rounds secs independently: a
    // duration like 59.97s gave mins=0 but secs.toFixed(1)="60.0" -> "0:60.0"
    // instead of "1:00.0" (any value in [N*60+59.95, (N+1)*60) mis-rendered).
    const totalTenths = Math.round(clamped * 10);
    const mins = Math.floor(totalTenths / 600);
    const secs = (totalTenths - mins * 600) / 10;
    return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
  }
  const totalSecs = Math.floor(clamped);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs - mins * 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Choose a readable ruler tick interval (seconds) for the current zoom. */
export function pickTickInterval(pixelsPerSecond: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const minPxPerTick = 64;
  for (const interval of candidates) {
    if (interval * pixelsPerSecond >= minPxPerTick) return interval;
  }
  return candidates[candidates.length - 1];
}

export function timeToPx(t: number, pixelsPerSecond: number): number {
  return t * pixelsPerSecond;
}

export function pxToTime(px: number, pixelsPerSecond: number): number {
  return px / pixelsPerSecond;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Snap a candidate time to the nearest of a list of target times if it's
 * within `thresholdSeconds`. Returns the snapped time and whether a snap
 * occurred (so callers can show a snap guide line).
 */
export function snapTime(
  candidate: number,
  targets: number[],
  thresholdSeconds: number
): { time: number; snapped: boolean; snapTarget: number | null } {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const target of targets) {
    const dist = Math.abs(candidate - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  if (best !== null && bestDist <= thresholdSeconds) {
    return { time: best, snapped: true, snapTarget: best };
  }
  return { time: candidate, snapped: false, snapTarget: null };
}

/** A time-window item to be lane-packed (any object carrying a start/end). */
export interface LaneSpan {
  start: number;
  end: number;
}

/**
 * Greedy calendar-style lane packing for overlapping time windows. Assigns each
 * span the LOWEST lane index (0-based) whose last span ends at or before this
 * span's start, so mutually-overlapping spans fan out into separate lanes and
 * non-overlapping ones reuse lane 0. Returns a parallel array of lane indices
 * (same order as the input) plus the total laneCount used.
 *
 * The row height is then `laneCount * OVERLAY_LANE_HEIGHT` -- DYNAMIC and
 * unbounded: three overlays alive at once -> three lanes, and the Overlay row
 * simply grows (the timeline body scrolls vertically past a point). Ordering is
 * by ascending start so lower-start spans claim the top lanes first; a stable
 * secondary sort on the original index keeps ties deterministic. The z-order is
 * NOT what drives lanes (overlaps do) -- each block still shows its true z via a
 * badge, and higher-z spans are nudged toward the UPPER lanes by pre-sorting
 * ties so a later-drawn (higher-z) block that STARTS at the same time sits above.
 */
export function packLanes<T extends LaneSpan & { zIndex?: number }>(
  spans: T[]
): { lanes: number[]; laneCount: number } {
  const n = spans.length;
  const lanes = new Array<number>(n).fill(0);
  if (n === 0) return { lanes, laneCount: 0 };

  // Process in start order; break ties so a HIGHER z is placed first (claims the
  // upper lane) among spans that begin together. Keep original indices to write
  // results back in input order.
  const order = spans
    .map((s, i) => ({ i, start: s.start, end: s.end, z: s.zIndex ?? 0 }))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : b.z - a.z));

  // laneEnds[k] = the end time of the last span assigned to lane k.
  const laneEnds: number[] = [];
  for (const item of order) {
    let placed = -1;
    for (let k = 0; k < laneEnds.length; k++) {
      // A tiny epsilon so blocks that merely touch (end === next start) share a
      // lane instead of forcing a new one.
      if (item.start >= laneEnds[k] - 1e-6) {
        placed = k;
        break;
      }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[placed] = item.end;
    }
    lanes[item.i] = placed;
  }

  return { lanes, laneCount: laneEnds.length };
}
