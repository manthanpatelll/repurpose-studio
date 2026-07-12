// ===========================================================================
// REPURPOSE STUDIO -- double-buffered standby pre-seek for the preview
// ===========================================================================
// The preview paints hidden <video> elements onto a canvas. The sources stream
// over byte-range requests, so a hard seek at a DISCONTINUOUS cut (trimmed
// retake / reorder) stalls playback ~1s (seek -> range fetch -> rebuffer ->
// resume) while the last frame freezes on screen. Fix: a second, STANDBY pair
// of <video> elements sits PAUSED, pre-seeked to the NEXT discontinuous cut's
// source in-point while the active pair plays. At the boundary the cut becomes
// an element swap (standby -> active) instead of a seek. When the standby is
// not ready in time, the caller falls back to the old hard-seek path -- the
// pre-seek is purely an optimization, never a correctness dependency.
// This module is the pure/DOM helper layer: cut lookup + serialized seeking.
// ===========================================================================

import type { Clip } from "./types";

/**
 * A cut is "contiguous" when the next kept clip resumes the SAME source at
 * (essentially) the same source time the outgoing clip ends -- no retake was
 * trimmed out between them and nothing was reordered. The source videos are
 * ALREADY decoding the exact frames the incoming clip wants, so no seek is
 * needed (and the standby pair has nothing to pre-position for). One frame of
 * slack absorbs float error in back-to-back srcEnd/srcStart values.
 *
 * Single source of truth -- PreviewCanvas imports this (it used to own its own
 * copy) so the play-through skip and the pre-seek target agree byte-for-byte
 * on which cuts count as discontinuous.
 */
export const CONTIGUOUS_CUT_EPSILON = 1 / 24;

/**
 * The next REAL (discontinuous) cut ahead of the playhead -- what the standby
 * pair should pre-position for.
 *
 *  - `boundaryTimeline`: OUTPUT-timeline second the cut lands on (the outgoing
 *    clip's `timelineEnd`). The swap fires when the playhead crosses this.
 *  - `seekSrc`: RAW SOURCE second the incoming clip starts at (its `srcStart`).
 *    The standby element sits paused at exactly this time.
 */
export interface UpcomingCut {
  boundaryTimeline: number;
  seekSrc: number;
}

/**
 * Find the first `count` discontinuous cuts strictly ahead of output time `t`,
 * in timeline order. Empty when everything ahead is contiguous (or nothing is
 * ahead at all). With a standby POOL each standby slot parks at one
 * of these: slot k pre-seeks cuts[k], so a rapid double-cut (two real cuts
 * <1s apart) is TWO warm element swaps instead of swap + ~1s hard-seek.
 *
 * Walks kept clips in array order and considers each ADJACENT KEPT pair
 * (a, b) -- non-kept clips are skipped entirely, so `b` may sit several array
 * slots after `a`. A pair is a candidate when `a.timelineEnd > t` STRICTLY:
 * a boundary exactly at `t` already belongs to the incoming clip (the
 * half-open [start, end) contract in ./time-map.ts), so that cut is behind
 * us, not upcoming. Candidates whose source times actually jump
 * (`|b.srcStart - a.srcEnd| > epsilon` -- a trimmed retake or a reorder) are
 * collected; contiguous candidates are skipped because they need no seek and
 * therefore no standby.
 *
 * PURE, no DOM -- callers run it per playhead tick, so it allocates only the
 * small result array (at most `count` entries).
 */
export function nextDiscontinuousCutsAfter(
  clips: readonly Clip[],
  t: number,
  count: number,
  epsilon: number = CONTIGUOUS_CUT_EPSILON
): UpcomingCut[] {
  const out: UpcomingCut[] = [];
  if (count <= 0) return out;
  let prev: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    if (prev !== null && prev.timelineEnd > t) {
      // (prev, clip) is an adjacent kept pair whose boundary is still ahead.
      if (Math.abs(clip.srcStart - prev.srcEnd) > epsilon) {
        out.push({ boundaryTimeline: prev.timelineEnd, seekSrc: clip.srcStart });
        if (out.length >= count) return out;
      }
      // Contiguous cut: the source keeps rolling through it, no seek needed.
      // Keep walking -- the NEXT boundary may still be discontinuous.
    }
    prev = clip;
  }
  return out;
}

/** The single next discontinuous cut -- `nextDiscontinuousCutsAfter(..., 1)`. */
export function nextDiscontinuousCutAfter(
  clips: readonly Clip[],
  t: number,
  epsilon: number = CONTIGUOUS_CUT_EPSILON
): UpcomingCut | null {
  return nextDiscontinuousCutsAfter(clips, t, 1, epsilon)[0] ?? null;
}

/**
 * How close `currentTime` must sit to the requested target before we consider
 * the element "already there" / "the wanted target moved". One 60fps frame --
 * tighter than the seek itself needs, loose enough to absorb the float noise
 * browsers introduce when they settle currentTime onto a decodable frame.
 */
const SEEK_SETTLE_EPSILON = 1 / 60;

/**
 * Serialized seek manager for ONE standby <video> slot.
 *
 * WHY SERIALIZED: setting `currentTime` while a previous seek is still in
 * flight coalesces unpredictably across browsers (the pending seek may be
 * dropped, replayed, or land on a stale frame). So this class issues at most
 * ONE seek at a time: while a seek is in flight, new `target()` calls only
 * update the wanted target, and the 'seeked' handler chases it afterwards.
 *
 * WHY `getEl` IS A FUNCTION: which element IS the standby flips at every swap
 * (the active and standby pairs exchange roles), so the element is resolved
 * fresh on every operation. When the resolved element differs from the one
 * this seeker last touched, it rebinds: listener off the old element, in-flight
 * state reset, listener onto the new element.
 */
export class StandbySeeker {
  /** Resolves the CURRENT standby element (flips at every swap). */
  private readonly getEl: () => HTMLVideoElement | null;
  /** The element the 'seeked' listener is currently attached to, if any. */
  private boundEl: HTMLVideoElement | null = null;
  /** The exact handler reference bound to `boundEl` (for removeEventListener). */
  private boundHandler: (() => void) | null = null;
  /** True while a `currentTime` assignment is awaiting its 'seeked' event. */
  private seekInFlight = false;
  /** Latest requested source time; the 'seeked' handler chases this. */
  private wantedSrc: number | null = null;

  constructor(getEl: () => HTMLVideoElement | null) {
    this.getEl = getEl;
  }

  /**
   * Ask the standby element to sit paused at source second `src`. Safe to call
   * every frame with the same value -- redundant calls are cheap no-ops.
   *
   * Handles every awkward element state:
   *  - no element yet (pre-mount): remember the target, a later call retries;
   *  - element changed since last touch (post-swap): rebind listener + reset;
   *  - no metadata (`readyState === 0`): remember the target, do NOT assign
   *    `currentTime` (throws/ignored on a metadata-less element);
   *  - seek already in flight: just update the wanted target (serialization);
   *  - already parked at `src`: store and return, no redundant seek.
   */
  target(src: number): void {
    this.wantedSrc = src;
    const el = this.getEl();
    if (!el) return; // element not mounted yet -- a later call retries.

    // Post-swap rebind: the standby slot now resolves to a DIFFERENT element.
    // Any in-flight state belonged to the old element, so it is meaningless
    // now -- detach from the old, reset, attach to the new, then proceed.
    if (el !== this.boundEl) {
      this.unbind();
      this.seekInFlight = false;
      this.boundHandler = () => this.onSeeked();
      el.addEventListener("seeked", this.boundHandler);
      this.boundEl = el;
    }

    // No metadata yet: currentTime cannot be set meaningfully (the browser
    // ignores or clamps it before loadedmetadata). The target is remembered;
    // the caller's next tick retries once metadata lands.
    if (el.readyState === 0) return;

    // A seek is already in flight -- do NOT issue another (overlapping seeks
    // coalesce unpredictably; this serialization is the whole point). The
    // 'seeked' handler compares against `wantedSrc` and chases if it moved.
    if (this.seekInFlight) return;

    // Already parked close enough: nothing to do.
    if (Math.abs(el.currentTime - src) <= SEEK_SETTLE_EPSILON) return;

    this.seekInFlight = true;
    el.currentTime = src;
  }

  /**
   * True only when the standby is genuinely swap-ready at source second `src`:
   * the resolved element exists AND is the one this seeker last bound (an
   * element we never touched proves nothing), no seek is in flight, the
   * element can actually ADVANCE from here (`readyState >= 3`, HAVE_FUTURE_DATA
   * -- readyState 2 can paint one frame but would stall the instant playback
   * resumes, which defeats the whole swap), and `currentTime` sits within
   * `tolerance` of `src`. The default tolerance (0.15s) is deliberately looser
   * than the seek epsilon: a few frames of slack at the in-point is invisible
   * at a cut, while a false "not ready" forces the ~1s hard-seek fallback.
   */
  readyAt(src: number, tolerance: number = 0.15): boolean {
    const el = this.getEl();
    if (!el || el !== this.boundEl) return false;
    if (this.seekInFlight) return false;
    if (el.readyState < 3) return false;
    return Math.abs(el.currentTime - src) <= tolerance;
  }

  /**
   * Detach from the bound element and forget everything. For unmount or a
   * source-file change (the old element's pending 'seeked' must never mutate
   * state for a video that no longer exists).
   */
  reset(): void {
    this.unbind();
    this.seekInFlight = false;
    this.wantedSrc = null;
  }

  /** Remove the 'seeked' listener from the currently bound element, if any. */
  private unbind(): void {
    if (this.boundEl && this.boundHandler) {
      this.boundEl.removeEventListener("seeked", this.boundHandler);
    }
    this.boundEl = null;
    this.boundHandler = null;
  }

  /**
   * 'seeked' fired on the bound element: the in-flight seek landed. If the
   * wanted target moved while we were seeking, immediately chase it with a
   * fresh (still serialized -- exactly one in flight) seek; otherwise we are
   * parked and `readyAt` can start returning true once buffering catches up.
   */
  private onSeeked(): void {
    this.seekInFlight = false;
    const el = this.boundEl;
    if (!el || this.wantedSrc === null) return;
    if (Math.abs(this.wantedSrc - el.currentTime) > SEEK_SETTLE_EPSILON) {
      this.seekInFlight = true;
      el.currentTime = this.wantedSrc;
    }
  }
}
