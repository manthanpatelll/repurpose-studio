// ===========================================================================
// REPURPOSE STUDIO -- output <-> source time mapping (single source of truth)
// ===========================================================================
// The output timeline (assembled short) and the raw source file live in two
// different time spaces. Three consumers must agree on the mapping between
// them, byte-for-byte, or edits desync:
//   - PreviewCanvas: seeks the source <video>s to the frame-locked source time
//     for the current output playhead.
//   - export-short: the frame-walk maps each output frame's time to a source
//     time to seek + composite.
//   - store: when clips ripple (delete/trim/reorder/restore/keeper-flip),
//     pan/zoom keyframes anchored in OUTPUT space must be remapped so a zoom
//     keeps firing over the SAME footage moment (round-trip output -> source
//     -> output through the old and new layouts).
//
// This module owns that mapping so all three stay identical. Importing it from
// the store, the preview, and the exporter removes the drift risk of three
// hand-copied `timelineToSourceTime` functions.
//
// HALF-OPEN BOUNDARY CONTRACT (fixes the one-frame flash at every cut):
//   A kept clip owns output times in the half-open interval
//   [timelineStart, timelineEnd). A frame whose time lands EXACTLY on a cut
//   boundary therefore belongs to the INCOMING clip, never the outgoing clip's
//   tail. Both the live preview and the export frame-walk sample frame START
//   times (t = i / fps), so a boundary-aligned frame resolves to the first
//   frame of the next clip -- no stale outgoing frame flashes for one frame.
//   The sole exception is the very end of the timeline: the final frame's time
//   can equal the last kept clip's `timelineEnd`, which no half-open interval
//   contains, so we clamp times at/after the end to the last clip's out point.
// ===========================================================================

import type { Clip, ClipPunch, ClipTransition, FaceFraming } from "./types";
import type { PanZoomTransform } from "./compositor";
import { easings } from "../engine/easing";

/** Neutral framing -- a scene frames its region as shot when it carries no override. */
const IDENTITY_FRAMING: FaceFraming = { x: 0, y: 0, scale: 1 };

/**
 * Split-ratio bounds -- the fraction of frame height the SCREEN (top) half can
 * take. Mirrors the store's setSplitRatio clamp (0.4-0.6) so a per-clip split
 * resolved here can never exceed what the handle drag allows.
 */
const SPLIT_MIN = 0.4;
const SPLIT_MAX = 0.6;

function clampSplit(v: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v));
}

/** A clip's own split ratio if it set one, else the editor's global default. */
function resolvedClipSplit(clip: Clip | null, globalSplit: number): number {
  if (clip && typeof clip.splitRatio === "number") return clampSplit(clip.splitRatio);
  return globalSplit;
}

/**
 * Map an OUTPUT-timeline time (seconds, `Clip.timelineStart`/`timelineEnd`
 * space -- what the playhead and keyframe `t` live in) to a RAW SOURCE time
 * (seconds, what a `<video>`'s `currentTime` needs).
 *
 * Screen and face are frame-locked to a single raw timebase (take-matcher cuts
 * both from one `Clip.srcStart`/`srcEnd`), so one source time drives both.
 *
 * Boundary handling is HALF-OPEN `[timelineStart, timelineEnd)` -- see the
 * module header. Returns `null` when no kept clip covers `timelineT` (empty
 * timeline, or the playhead sits in a collapsed/deleted region) so callers can
 * hold the last good frame instead of seeking to a wrong source position. The
 * one closed case is the end of the timeline: a time at/after the last kept
 * clip's `timelineEnd` clamps to that clip's `srcEnd` (final frame).
 */
export function timelineToSourceTime(
  clips: readonly Clip[],
  timelineT: number
): number | null {
  let lastKept: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    lastKept = clip;
    // Half-open [start, end): a boundary-aligned frame belongs to the NEXT
    // clip, so the outgoing clip's tail never flashes for one frame.
    if (timelineT >= clip.timelineStart && timelineT < clip.timelineEnd) {
      return clip.srcStart + (timelineT - clip.timelineStart);
    }
  }
  // At or past the last kept clip's end (the closed right edge of the whole
  // timeline, or float rounding on the final frame): clamp to its out point so
  // the last frame renders instead of returning null.
  if (lastKept && timelineT >= lastKept.timelineEnd) return lastKept.srcEnd;
  return null;
}

/**
 * Map a RAW SOURCE time back to an OUTPUT-timeline time -- the inverse of
 * {@link timelineToSourceTime}. Used when clips ripple: a keyframe anchored at
 * output time `t_out` corresponds to source time
 * `s = timelineToSourceTime(oldClips, t_out)`; after the ripple its new output
 * time is `sourceToTimelineTime(newClips, s)`.
 *
 * A given source time can appear in more than one kept clip (an occurrence and
 * its retake alias overlap, or duplicated footage), so this returns the FIRST
 * kept clip (in timeline order) whose source span contains `sourceT` -- the
 * earliest place that footage now lands in the assembled short, matching how
 * playback would reach it first. Boundary is half-open `[srcStart, srcEnd)` for
 * symmetry with the forward map, and containment always wins: the closed-edge
 * clamp for a source time exactly on a clip's `srcEnd` runs only AFTER the loop
 * (against the last kept clip), so it never pre-empts a later clip that actually
 * contains `sourceT`. That post-loop clamp mirrors the forward map's
 * end-of-timeline clamp and resolves to the last kept clip's `timelineEnd`.
 *
 * Returns `null` when no kept clip's source span contains `sourceT` (the
 * footage that keyframe sat on was trimmed away entirely). Callers decide the
 * fallback (drop the now-orphaned keyframe, or clamp it to the timeline).
 */
export function sourceToTimelineTime(
  clips: readonly Clip[],
  sourceT: number
): number | null {
  let lastKept: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    const srcDuration = clip.srcEnd - clip.srcStart;
    if (srcDuration <= 0) continue;
    lastKept = clip;
    // Half-open [srcStart, srcEnd): containment ALWAYS wins. A clip that truly
    // contains sourceT must never be pre-empted by an earlier clip whose srcEnd
    // merely equals sourceT -- that closed-edge case is handled after the loop
    // so it only fires when no clip contained the time.
    if (sourceT >= clip.srcStart && sourceT < clip.srcEnd) {
      return clip.timelineStart + (sourceT - clip.srcStart);
    }
  }
  // Closed right edge: a source time exactly on the last kept clip's out point
  // maps to its output out point (mirrors the forward map's post-loop
  // end-of-timeline clamp). Fires only when no clip contained sourceT.
  if (lastKept && sourceT === lastKept.srcEnd) return lastKept.timelineEnd;
  return null;
}

/**
 * Given an OUTPUT-timeline time, return the active clip's incoming transition
 * and how far through its window we are, or `null` if no transition is playing.
 *
 * The transition window is INCOMING-only: it runs from the clip's `timelineStart`
 * for `transitionIn.durationSec` (clamped to the clip's own length so a very
 * short clip can't run a window longer than itself). `progress` is 0 at the cut
 * and 1 when the window ends. Only kept clips with a non-"none" `transitionIn`
 * that is NOT the very first clip (timelineStart > 0) count -- the reel's opening
 * frame has nothing to transition from.
 *
 * PURE and shared by the preview render loop AND the export frame-walk, so both
 * feed the identical `timelineT` and get identical `progress` -- the same
 * discipline that keeps `screenFramingAt`/`timelineToSourceTime` frame-identical
 * across preview and export.
 */
export function transitionProgressAt(
  clips: readonly Clip[],
  timelineT: number
): { transition: ClipTransition; progress: number } | null {
  for (const clip of clips) {
    if (!clip.kept) continue;
    if (timelineT < clip.timelineStart || timelineT >= clip.timelineEnd) continue;
    // Found the active clip.
    const tr = clip.transitionIn;
    if (!tr || tr.type === "none" || clip.timelineStart <= 0.001) return null;
    const progress = transitionWindowProgress(clip, timelineT);
    if (progress < 0) return null; // no window / past the window -> normal frame
    return { transition: tr, progress };
  }
  return null;
}

/**
 * The ONE piece of transition-window math, shared by `transitionProgressAt`,
 * `splitRatioAt`, and `framingAt` so the window/progress is computed identically
 * in every place (they used to each inline the same three lines, which had to be
 * kept "in lockstep" by hand). Given the active clip and an OUTPUT-timeline time,
 * returns the LINEAR progress [0,1) through the clip's incoming Smart-transition
 * window, or `-1` when there is no live window (no/`"none"` transition, opening
 * clip, zero-length window, or the playhead is already past the window).
 *
 * Returns a raw `number` (never an object) so the per-frame render/export callers
 * pay ZERO allocation for it -- they read the number and blend inline. The caller
 * is responsible for the easing curve + the "from === target -> skip" no-op check
 * (those differ per region: split clamps to the band, framing clamps pan/scale),
 * so this helper stays purely about "how far into the window are we".
 *
 * Guards match the old inline copies exactly: `timelineStart > 0.001` (opening
 * frame has nothing to ease from), window = `min(durationSec, clipLen)` clamped
 * to the clip's own length, and `into < window` (strictly inside the window).
 * Does NOT re-check `!tr`/`type === "none"` -- callers gate on that before
 * calling (transitionProgressAt returns null; the easing callers guard in their
 * `if (prevKept && tr && tr.type !== "none" ...)`).
 */
function transitionWindowProgress(clip: Clip, timelineT: number): number {
  const tr = clip.transitionIn;
  if (!tr || clip.timelineStart <= 0.001) return -1;
  const clipLen = clip.timelineEnd - clip.timelineStart;
  const window = Math.min(tr.durationSec, clipLen);
  if (window <= 0) return -1;
  const into = timelineT - clip.timelineStart;
  if (into >= window) return -1; // past the window -> settled
  return Math.max(0, Math.min(1, into / window));
}

/**
 * Resolve the ACTIVE split ratio at an OUTPUT-timeline time, honoring per-clip
 * splits and EASING the change across a cut so the seam glides instead of
 * jumping. This is the single source of truth for "how tall is the screen half
 * right now": the preview loop, the export frame-walk, AND the pinned-caption
 * baseline all call it with the same `timelineT` + global default, so the split
 * they draw is byte-identical -- the same discipline that keeps
 * `screenFramingAt` / `timelineToSourceTime` frame-locked across preview and
 * export.
 *
 * Resolution:
 *   - Find the kept clip whose half-open [timelineStart, timelineEnd) contains
 *     `timelineT` (same containment as timelineToSourceTime). Its split is its
 *     own `clip.splitRatio` if set, else `globalSplit`.
 *   - INSIDE that clip's incoming Smart-transition window (the SAME window
 *     `transitionProgressAt` reports), ease from the PREVIOUS kept clip's
 *     resolved split to this clip's resolved split. The curve matches the
 *     transition's own easing (`natural` = ease-in-out-cubic, `bounce` =
 *     ease-out-back), so the seam moves in lockstep with the zoom/slide motion.
 *   - Outside any window (or the first clip, or a hard "none" cut), it's just
 *     the active clip's resolved split -- a clean per-scene value.
 *
 * Falls back to `globalSplit` when no kept clip covers `timelineT` (empty
 * timeline / a collapsed region), so the handle still has a sane value to show.
 */
export function splitRatioAt(
  clips: readonly Clip[],
  timelineT: number,
  globalSplit: number
): number {
  let prevKept: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    if (timelineT >= clip.timelineStart && timelineT < clip.timelineEnd) {
      const target = resolvedClipSplit(clip, globalSplit);
      // Ease from the previous clip's split across this clip's transition window.
      const tr = clip.transitionIn;
      if (prevKept && tr && tr.type !== "none") {
        const raw = transitionWindowProgress(clip, timelineT);
        if (raw >= 0) {
          const from = resolvedClipSplit(prevKept, globalSplit);
          if (from !== target) {
            const eased =
              tr.easing === "bounce"
                ? easings.easeOutBack(raw)
                : easings.easeInOutCubic(raw);
            // Clamp the interpolated seam back into the 0.4-0.6 band: easeOutBack
            // ("bounce") overshoots to ~1.10, which would push the split ~0.02
            // past the band, and the compositor only re-clamps to [0,1] (it trusts
            // callers to honor 0.4-0.6). Clamping here keeps the seam in-band while
            // the transition motion (zoom/slide) still gets its bounce.
            return clampSplit(from + (target - from) * eased);
          }
        }
      }
      return target;
    }
    prevKept = clip;
  }
  // Past the end (or nothing kept): hold the last kept clip's split, else global.
  if (prevKept) return resolvedClipSplit(prevKept, globalSplit);
  return globalSplit;
}

/** A clip's own face framing if it set one, else neutral (framed as shot). */
function resolvedClipFaceFraming(clip: Clip | null): FaceFraming {
  return clip?.faceFraming ?? IDENTITY_FRAMING;
}

/** A clip's own screen framing if it set one, else neutral (framed as shot). */
function resolvedClipScreenFraming(clip: Clip | null): FaceFraming {
  return clip?.screenFraming ?? IDENTITY_FRAMING;
}

/**
 * Shared resolver for a per-scene pan/zoom FRAMING that eases across the cut --
 * the vector twin of {@link splitRatioAt}. Both the face and screen regions use
 * it (via the two thin wrappers below), differing only in which per-clip field
 * they read. Each scene carries ONE static framing (`clip.faceFraming` /
 * `clip.screenFraming`); a scene with no override frames its region as shot
 * (identity). At the cut INTO a scene the Smart transition EASES from the
 * previous scene's resolved framing to this one's whenever the two differ --
 * same window + curve as the split seam and the zoom/slide motion, so all move
 * in lockstep. Identical framings on both sides read as an instant cut (the
 * ease is a no-op), so untouched auto-cuts don't gain motion.
 *
 * Single source of truth: the preview loop, the export frame-walk, and the
 * preview's drag-origin reader all call it with the same `timelineT`, so the
 * crop is byte-identical between "what you see" and "what you export". Bounce
 * overshoot is clamped back into the pan range ([-1, 1]) and scale >= 1 so an
 * eased frame can never letterbox.
 */
function framingAt(
  clips: readonly Clip[],
  timelineT: number,
  resolve: (clip: Clip | null) => FaceFraming
): PanZoomTransform {
  let prevKept: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    if (timelineT >= clip.timelineStart && timelineT < clip.timelineEnd) {
      const target = resolve(clip);
      // Ease from the previous clip's framing across this clip's transition
      // window (mirrors splitRatioAt exactly).
      const tr = clip.transitionIn;
      if (prevKept && tr && tr.type !== "none") {
        const raw = transitionWindowProgress(clip, timelineT);
        if (raw >= 0) {
          const from = resolve(prevKept);
          // Identical framings on both sides -> nothing to ease; skip straight
          // to the settled framing (this is what keeps an untouched cut instant).
          if (
            from.x !== target.x ||
            from.y !== target.y ||
            from.scale !== target.scale
          ) {
            const eased =
              tr.easing === "bounce"
                ? easings.easeOutBack(raw)
                : easings.easeInOutCubic(raw);
            return {
              x: Math.max(-1, Math.min(1, from.x + (target.x - from.x) * eased)),
              y: Math.max(-1, Math.min(1, from.y + (target.y - from.y) * eased)),
              scale: Math.max(1, from.scale + (target.scale - from.scale) * eased),
            };
          }
        }
      }
      return { x: target.x, y: target.y, scale: target.scale };
    }
    prevKept = clip;
  }
  // Past the end (or nothing kept): hold the last kept clip's framing, else identity.
  const f = resolve(prevKept);
  return { x: f.x, y: f.y, scale: f.scale };
}

/**
 * Resolve the ACTIVE face-cam framing at an OUTPUT-timeline time -- the face
 * counterpart to {@link splitRatioAt}. Every scene carries its own static face
 * framing (`clip.faceFraming`, identity when absent); the cut eases between
 * adjacent scenes' framings whenever they differ. See {@link framingAt}.
 */
export function faceFramingAt(
  clips: readonly Clip[],
  timelineT: number
): PanZoomTransform {
  return framingAt(clips, timelineT, resolvedClipFaceFraming);
}

/**
 * Resolve the ACTIVE screen framing at an OUTPUT-timeline time -- the screen
 * twin of {@link faceFramingAt}, reading `clip.screenFraming`. This REPLACES the
 * old per-scene keyframe sampling: one static framing per scene, eased across
 * cuts, no diamonds. See {@link framingAt}.
 */
export function screenFramingAt(
  clips: readonly Clip[],
  timelineT: number
): PanZoomTransform {
  return framingAt(clips, timelineT, resolvedClipScreenFraming);
}

// ---------------------------------------------------------------------------
// ZOOM PUNCH-IN -- transient mid-clip scale envelope (a render-time decorator).
// ---------------------------------------------------------------------------

/**
 * Fixed rise/fall ramp for a punch, in SOURCE seconds. The punch stays a
 * one-click move -- only `atSrc`/`amount`/`holdSec` are stored; how fast it
 * snaps in and settles out is a constant tuned once here. 0.35s each reads as a
 * crisp, premium push (not a linear pop, not a slow drift). The full envelope
 * spans [atSrc - RISE, atSrc + hold + FALL].
 */
const PUNCH_RISE_SEC = 0.35;
const PUNCH_FALL_SEC = 0.35;

/**
 * Evaluate a single punch envelope at a SOURCE time, returning the EXTRA-scale
 * MULTIPLIER to fold onto the base framing scale (1 = no boost, the settled
 * value outside the envelope). Shape: ease IN from (atSrc - RISE) to full at
 * `atSrc`, HOLD `1 + amount` for `holdSec`, ease OUT over FALL back to 1.
 *
 * Rise curve honors `ease` ("bounce" = ease-out-back spring pop; "natural" =
 * ease-in-out cubic); the fall is always ease-in-out cubic so the settle never
 * overshoots the base framing (an overshoot on the way OUT would read as a
 * double-bounce). A non-positive `amount` is a no-op (returns 1).
 */
function punchEnvelope(punch: ClipPunch, sourceT: number): number {
  const amount = punch.amount;
  if (!(amount > 0)) return 1;
  const hold = Math.max(0, punch.holdSec);
  const start = punch.atSrc - PUNCH_RISE_SEC; // ease-in begins
  const peakEnd = punch.atSrc + hold; // hold ends, ease-out begins
  const end = peakEnd + PUNCH_FALL_SEC; // fully settled

  if (sourceT <= start || sourceT >= end) return 1; // outside the envelope
  if (sourceT >= punch.atSrc && sourceT <= peakEnd) return 1 + amount; // holding

  if (sourceT < punch.atSrc) {
    // Rising: 0 -> 1 over [start, atSrc], curved by the punch's own ease.
    const raw = (sourceT - start) / PUNCH_RISE_SEC;
    const eased =
      punch.ease === "bounce"
        ? easings.easeOutBack(raw)
        : easings.easeInOutCubic(raw);
    return 1 + amount * eased;
  }
  // Falling: 1 -> 0 over [peakEnd, end], always natural (no overshoot on settle).
  const raw = (sourceT - peakEnd) / PUNCH_FALL_SEC;
  const eased = easings.easeInOutCubic(Math.max(0, Math.min(1, raw)));
  return 1 + amount * (1 - eased);
}

/**
 * Resolve the ACTIVE zoom-punch scale multiplier for a region at an OUTPUT-
 * timeline time. The single source of truth for "how much extra zoom is the
 * punch adding right now": the preview loop AND the export frame-walk both call
 * it with the same `timelineT` + region and multiply the result onto the base
 * framing scale they already built (`screenFramingAt` / `faceFramingAt`), so the
 * punch is byte-identical between preview and export -- the same discipline that
 * keeps `screenFramingAt` frame-locked across the two.
 *
 * The punch is anchored in SOURCE time (`ClipPunch.atSrc`), so we find the kept
 * clip whose half-open [timelineStart, timelineEnd) owns `timelineT` (same
 * containment as timelineToSourceTime), map to that clip's source time, and
 * evaluate ITS `screenPunch` / `facePunch`. Confining the lookup to the active
 * clip means a punch never bleeds across a cut -- it lives entirely inside the
 * scene that owns it. Returns 1 (no boost) when no kept clip covers `timelineT`
 * or that clip carries no punch for this region.
 */
export function punchScaleAt(
  clips: readonly Clip[],
  timelineT: number,
  region: "screen" | "face"
): number {
  for (const clip of clips) {
    if (!clip.kept) continue;
    if (timelineT < clip.timelineStart || timelineT >= clip.timelineEnd) continue;
    const punch = region === "screen" ? clip.screenPunch : clip.facePunch;
    if (!punch) return 1;
    const sourceT = clip.srcStart + (timelineT - clip.timelineStart);
    return punchEnvelope(punch, sourceT);
  }
  return 1;
}
