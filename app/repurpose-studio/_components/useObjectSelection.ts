"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useObjectSelection (canvas pointer state machine)
// ===========================================================================
// The single pointer-down ROUTER + drag state machine for canvas direct-
// manipulation of overlays, plus the fallback that hands a base-region hit back
// to the caller's existing reframe path. Pure interaction logic -- it reads the
// store's overlays / selection and calls updateOverlayTransform; it does NOT
// draw anything (the DOM chrome lives in SelectionOverlay.tsx, drawn OUTSIDE
// the canvas so the export stays clean).
//
// One consolidated interaction layer sits over the preview. On pointer-down:
//   1. Hit-test the TOPMOST overlay active at the playhead (z desc, filtered to
//      the window [start,end)). Hit -> selectOverlay + begin a MOVE drag.
//   2. Miss every overlay -> return which BASE region (screen/face) the point
//      fell in so the caller can (a) select that clip and (b) reuse its existing
//      makeRegionPointerDown reframe drag. No overlay chrome for the base.
//   3. Genuinely nothing -> deselect.
//
// A handle drag (resize/rotate) is started by the chrome via beginHandleGesture:
// the chrome's 8 resize handles + rotate grip forward their pointer-down here
// with the handle id, and this hook runs the matching solver each pointermove.
//
// FROZEN START SNAPSHOT: every gesture captures the overlay transform + pointer
// position ONCE at pointer-down (GestureStart) and derives each frame from that
// snapshot, so a gesture never compounds. updateOverlayTransform coalesces the
// whole gesture into ONE undo step via its `ovxform:${id}` key.
//
// SNAP + TOP-HALF CLAMP: a MOVE gesture runs its raw (un-snapped)
// solveMove output through a MAGNETIC PULL then solveSnap (alignment guides)
// unless Alt is held, THEN through clampOverlayToTopHalf. Ordering is exactly:
//   solveMove -> (magnetic pull -> snap detent, unless Alt) -> clamp (ALWAYS).
// The clamp is a HARD keep-out (overlay bottom can never cross the split seam),
// so it runs even when Alt defeats the snap; only the magnetic snap is modifier-
// defeatable. Resize gestures skip snapping (v1) but STILL clamp, so growing the
// bottom past the seam is corrected. Because snap/clamp always operate on
// solveMove's frozen-derived output (never last frame's snapped result), the
// gesture never compounds and the "pull in / break free" stickiness stays
// natural. The live guide lines are pushed to the store (activeSnapGuides) for
// PreviewCanvas to draw as pointer-events:none DOM -- they NEVER bake into the
// export, same discipline as the grid -- and are cleared to [] on
// pointer-up / cancel.
//
// FEEL LAYER: the MOVE gesture does NOT write the solved position
// straight to the store. Each pointermove computes the exact TARGET (solveMove
// -> magnetic pull -> snap detent -> clamp) and parks it in moveTargetRef; a tiny
// rAF FOLLOWER critically-eases the store's transform toward that target
// (~0.55/frame, position only) so a fast flick reads as a smooth glide instead
// of a hard teleport, while the target stays exact. On pointer-up the follower is
// FLUSHED to the exact target so the committed position is pixel-precise -- no
// residual smoothing offset (Manthan values precise placement). There is
// deliberately NO release inertia: a placement tool must land where you let go.
// The magnetic pull is a PRE-snap attraction (leans toward a line just outside
// the detent); the detent is the hard click; both recompute from the true
// pointer each frame so nothing glues. Resize / rotate bypass the follower and
// write raw (crisp). A transient `overlayDragging` store flag drives the chrome
// LIFT + grab cursor. The whole gesture is still ONE undo step
// (updateOverlayTransform coalesces via `ovxform:${id}`): every eased frame + the
// final flush merge into it.
// ===========================================================================

import { useCallback, useEffect, useRef } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  normFromClient,
  hitTestOverlay,
  solveMove,
  solveCornerResize,
  solveEdgeResize,
  solveRotate,
  buildSnapTargets,
  applyMagneticPull,
  solveSnap,
  clampOverlayToTopHalf,
  type GestureStart,
  type HandleId,
  type PreviewRect,
  type Point,
} from "@/lib/repurpose/overlay-geometry";
import type { Overlay, OverlayTransform } from "@/lib/repurpose/types";

/** A little grab tolerance (CSS px) so a thin overlay is still easy to click. */
const HIT_PAD_PX = 6;

// --- Smoothing follower tuning -------------------------
// Per-frame lerp fraction the RENDERED position moves toward the solved TARGET.
// High enough that latency is imperceptible (~2-3 frames to visually settle),
// low enough to smooth a fast flick into a glide. Position (x/y) only -- scale
// and rotation are never eased (they come from resize/rotate, which write raw).
const FOLLOW_LERP = 0.55;
// Below this normalized gap on BOTH axes the follower has effectively arrived,
// so it pins exactly and stops re-writing the store -- kills a forever-tiny
// asymptotic crawl and avoids churning a render once the media caught up.
const FOLLOW_ARRIVE_EPS = 0.0004;

/** What a preview pointer-down resolved to, so the caller can react. */
export type PointerRoute =
  | { kind: "overlay"; id: string }
  | { kind: "base"; region: "screen" | "face" }
  | { kind: "empty" };

/** The active drag, if any. `move` and the 8 handle ids share one machine. */
interface ActiveGesture {
  overlayId: string;
  handle: HandleId | "move";
  start: GestureStart;
  pointerId: number;
}

export interface UseObjectSelectionArgs {
  /** Reads the preview canvas's current on-screen rect (CSS px). Null if unmounted. */
  getRect: () => PreviewRect | null;
}

export interface UseObjectSelection {
  /**
   * Route a raw pointer-down over the preview interaction layer. Hit-tests the
   * topmost active overlay; on a hit it selects it and BEGINS a move drag
   * (returns {kind:"overlay"}). On a miss it returns which base region was hit
   * (or "empty") WITHOUT starting anything, so the caller runs its own reframe /
   * deselect. Call e.preventDefault()/stopPropagation() in the caller as needed.
   */
  routePointerDown: (e: React.PointerEvent) => PointerRoute;
  /**
   * Begin a resize/rotate gesture from a chrome handle. The chrome forwards the
   * handle's pointer-down here with the handle id; this captures the frozen
   * snapshot and drives the matching solver until pointer-up.
   */
  beginHandleGesture: (handle: HandleId, e: React.PointerEvent) => void;
}

export function useObjectSelection(
  args: UseObjectSelectionArgs
): UseObjectSelection {
  const { getRect } = args;
  const selectOverlay = useRepurposeStore((s) => s.selectOverlay);
  const updateOverlayTransform = useRepurposeStore((s) => s.updateOverlayTransform);
  const setActiveSnapGuides = useRepurposeStore((s) => s.setActiveSnapGuides);
  const setOverlayDragging = useRepurposeStore((s) => s.setOverlayDragging);
  const duplicateOverlay = useRepurposeStore((s) => s.duplicateOverlay);
  const toggleOverlaySelected = useRepurposeStore((s) => s.toggleOverlaySelected);

  // The live gesture. A ref (not state) so the window pointermove handler reads
  // the current snapshot without re-subscribing; a gesture is fully transient.
  const gestureRef = useRef<ActiveGesture | null>(null);
  // Held window listeners for the current gesture, cleared on pointer-up.
  const cleanupRef = useRef<(() => void) | null>(null);

  // --- MOVE smoothing follower ----------------------------------------------
  // moveTargetRef: the exact solved TARGET (post snap + clamp) the latest
  // pointermove computed. moveRenderRef: the eased position currently written to
  // the store. followRafRef: the follower's rAF handle (null when idle). The
  // follower critically-lerps render -> target each frame and commits render via
  // updateOverlayTransform (one coalesced undo step). Refs, not state -- the
  // follower must run off the store without re-rendering this hook.
  const moveTargetRef = useRef<OverlayTransform | null>(null);
  const moveRenderRef = useRef<{ x: number; y: number } | null>(null);
  const followRafRef = useRef<number | null>(null);

  // Stop the follower loop (does NOT flush -- callers that need the exact final
  // position flush first, then stop). Idempotent.
  const stopFollower = useCallback(() => {
    if (followRafRef.current !== null) {
      cancelAnimationFrame(followRafRef.current);
      followRafRef.current = null;
    }
  }, []);

  // The follower tick: ease the rendered x/y a FOLLOW_LERP fraction toward the
  // target, write it to the store (coalesced), and keep going until it has
  // arrived (within FOLLOW_ARRIVE_EPS on both axes) -- then idle, leaving the
  // media parked exactly on target. Scale/rotation ride the target verbatim (a
  // move never changes them, but if a snap/clamp did we pass them through).
  const followTick = useCallback(() => {
    const g = gestureRef.current;
    const target = moveTargetRef.current;
    const render = moveRenderRef.current;
    // Bail (and stop) if the move gesture ended or state is missing.
    if (!g || g.handle !== "move" || !target || !render) {
      followRafRef.current = null;
      return;
    }
    const nx = render.x + (target.x - render.x) * FOLLOW_LERP;
    const ny = render.y + (target.y - render.y) * FOLLOW_LERP;
    const arrived =
      Math.abs(target.x - nx) < FOLLOW_ARRIVE_EPS &&
      Math.abs(target.y - ny) < FOLLOW_ARRIVE_EPS;
    const x = arrived ? target.x : nx;
    const y = arrived ? target.y : ny;
    moveRenderRef.current = { x, y };
    updateOverlayTransform(g.overlayId, { ...target, x, y });
    // Keep ticking while still catching up; idle once arrived (a new pointermove
    // moves the target and restarts the loop). No inertia -- we never overshoot.
    followRafRef.current = arrived ? null : requestAnimationFrame(followTick);
  }, [updateOverlayTransform]);

  // Ensure the follower loop is running (no-op if already scheduled).
  const ensureFollower = useCallback(() => {
    if (followRafRef.current === null) {
      followRafRef.current = requestAnimationFrame(followTick);
    }
  }, [followTick]);

  // Tear down any in-flight gesture + listeners + follower on unmount, and drop
  // any stale snap guides / drag flag (read via getState so no changing deps).
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      gestureRef.current = null;
      if (followRafRef.current !== null) {
        cancelAnimationFrame(followRafRef.current);
        followRafRef.current = null;
      }
      moveTargetRef.current = null;
      moveRenderRef.current = null;
      const st = useRepurposeStore.getState();
      st.setActiveSnapGuides([]);
      st.setOverlayDragging(false);
    };
  }, []);

  const runGesture = useCallback(
    (clientX: number, clientY: number, shift: boolean, alt: boolean) => {
      const g = gestureRef.current;
      const rect = getRect();
      if (!g || !rect) return;
      const pointerNorm: Point = normFromClient({ x: clientX, y: clientY }, rect);

      // splitRatio is read fresh (it's the hard top-half boundary + a snap
      // target) so a live split-handle drag can't leave this using a stale seam.
      const splitRatio = useRepurposeStore.getState().splitRatio;

      let next;
      switch (g.handle) {
        case "move": {
          // 1) RAW un-snapped move from the frozen start (never compounds).
          const raw = solveMove(g.start, pointerNorm, shift);
          // 2) Magnetic snap -- defeated by holding Alt (Manthan's chosen key).
          //    Recompute every frame from `raw` (the true position), NEVER from
          //    last frame's snapped output, so the overlay pulls in then breaks
          //    free naturally instead of gluing to a line.
          let snapped = raw;
          if (!alt) {
            const { overlays } = useRepurposeStore.getState();
            const targets = buildSnapTargets({
              splitRatio,
              thirds: true,
              // Every OTHER overlay (exclude the dragged one) contributes its
              // AABB edges/center as alignment targets.
              others: overlays
                .filter((o) => o.id !== g.overlayId)
                .map((o) => ({
                  transform: o.transform,
                  naturalWidth: o.naturalWidth,
                  naturalHeight: o.naturalHeight,
                })),
              rect,
              // EQUAL-GAP snap: pass the dragged box's intrinsics so the target
              // builder can add "matches an existing neighbor gap" candidate lines
              // (Figma/Canva equal-spacing feel). Purely additive to `others`.
              dragged: {
                naturalWidth: g.start.naturalWidth,
                naturalHeight: g.start.naturalHeight,
                scale: raw.scale,
                rotation: raw.rotation,
              },
            });
            // 2a) MAGNETIC PRE-SNAP: a soft lean toward a line just OUTSIDE the
            //     detent, so the media "wants" to click in (Canva/Figma feel).
            //     Applied to the TRUE position before the detent; recomputed from
            //     raw each frame, so releasing past the band breaks free cleanly.
            const pulled = applyMagneticPull(
              raw,
              g.start.naturalWidth,
              g.start.naturalHeight,
              rect,
              targets
            );
            // 2b) DETENT: the hard snap. Fed the pulled position so an edge the
            //     pull carried inside the threshold lands exactly on the line.
            const result = solveSnap(
              pulled,
              g.start.naturalWidth,
              g.start.naturalHeight,
              rect,
              targets
            );
            snapped = result.transform;
            // Publish the live guide lines for PreviewCanvas (DOM-only, never
            // exported). Alt-held / no-snap frames clear them (empty array).
            setActiveSnapGuides(result.guides);
          } else {
            // Alt held: no magnetic snap this frame, so no guides to draw.
            setActiveSnapGuides([]);
          }
          // 3) HARD top-half keep-out -- ALWAYS, even when Alt disabled the snap.
          //    Order is solveMove -> (pull -> snap unless Alt) -> clamp (always).
          const moveTarget = clampOverlayToTopHalf(
            snapped,
            g.start.naturalWidth,
            g.start.naturalHeight,
            rect,
            splitRatio
          );
          // 4) FEEL: don't write moveTarget straight -- park it and let the rAF
          //    follower ease the store toward it (glide, not teleport). Seed the
          //    rendered position from the frozen start on the first frame so the
          //    glide begins from where the media actually is. Pointer-up flushes
          //    exactly to moveTarget so placement is precise.
          moveTargetRef.current = moveTarget;
          if (moveRenderRef.current === null) {
            moveRenderRef.current = { x: g.start.transform.x, y: g.start.transform.y };
          }
          ensureFollower();
          return; // the follower owns the store write for moves
        }
        case "nw":
        case "ne":
        case "se":
        case "sw":
          // Resize skips snapping in v1 but still clamps below.
          next = solveCornerResize(g.start, g.handle, pointerNorm, rect, shift);
          next = clampOverlayToTopHalf(
            next,
            g.start.naturalWidth,
            g.start.naturalHeight,
            rect,
            splitRatio
          );
          break;
        case "n":
        case "e":
        case "s":
        case "w":
          next = solveEdgeResize(g.start, g.handle, pointerNorm, rect, shift);
          next = clampOverlayToTopHalf(
            next,
            g.start.naturalWidth,
            g.start.naturalHeight,
            rect,
            splitRatio
          );
          break;
        case "rotate":
          next = solveRotate(g.start, pointerNorm, rect, shift);
          break;
        default:
          return;
      }
      // updateOverlayTransform coalesces the whole gesture (ovxform:${id}) into
      // one undo step; passing the full transform is fine (patch merges it).
      // (MOVE returned early above -- its store write is the follower's job.)
      updateOverlayTransform(g.overlayId, next);
    },
    [getRect, updateOverlayTransform, setActiveSnapGuides, ensureFollower]
  );

  // Wire the window-level move/up listeners for an in-flight gesture. Shared by
  // both the move gesture (from routePointerDown) and the handle gestures.
  const attachGestureListeners = useCallback(
    (pointerId: number) => {
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // Alt (ev.altKey) DISABLES the magnetic snap for this move (Manthan's
        // chosen modifier); the top-half clamp still applies. Shift = axis-lock.
        runGesture(ev.clientX, ev.clientY, ev.shiftKey, ev.altKey);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // FEEL: flush the follower to the EXACT target so the committed position
        // is pixel-precise (no residual smoothing offset), then stop it. A move
        // gesture writes through the follower; a handle gesture never armed it, so
        // this is a no-op there.
        const g = gestureRef.current;
        const target = moveTargetRef.current;
        if (g && g.handle === "move" && target) {
          updateOverlayTransform(g.overlayId, target);
        }
        stopFollower();
        moveTargetRef.current = null;
        moveRenderRef.current = null;
        // Gesture over: drop the ephemeral snap guides so no stale line lingers,
        // and clear the live-drag flag (identity-guarded, a no-op for a resize).
        setActiveSnapGuides([]);
        setOverlayDragging(false);
        cleanupRef.current?.();
        cleanupRef.current = null;
        gestureRef.current = null;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
    },
    [runGesture, setActiveSnapGuides, setOverlayDragging, stopFollower, updateOverlayTransform]
  );

  const routePointerDown = useCallback(
    (e: React.PointerEvent): PointerRoute => {
      const rect = getRect();
      if (!rect) return { kind: "empty" };
      const { overlays, playhead, splitRatio, selectedOverlayId } =
        useRepurposeStore.getState();
      const norm = normFromClient({ x: e.clientX, y: e.clientY }, rect);

      // 1) Topmost ACTIVE overlay under the pointer.
      // Prefer the CURRENTLY SELECTED overlay if the pointer is still inside it
      // (so a click on its own body never falls through to a lower overlay),
      // then fall back to the topmost active overlay generally.
      const active = overlays
        .filter((o) => playhead >= o.timelineStart && playhead < o.timelineEnd)
        .sort((a, b) => b.zIndex - a.zIndex); // z DESC -- topmost first
      let hit: Overlay | null = null;
      const sel = active.find((o) => o.id === selectedOverlayId) ?? null;
      if (
        sel &&
        hitTestOverlay(norm, sel.transform, sel.naturalWidth, sel.naturalHeight, rect, HIT_PAD_PX)
      ) {
        hit = sel;
      } else {
        for (const o of active) {
          if (
            hitTestOverlay(norm, o.transform, o.naturalWidth, o.naturalHeight, rect, HIT_PAD_PX)
          ) {
            hit = o;
            break;
          }
        }
      }

      if (hit) {
        // SHIFT-CLICK = pure multi-select TOGGLE: add/remove this overlay from the
        // selection and DO NOT begin a move drag (a shift-click is a selection
        // gesture, not a drag). A move on a multi-selection is a v2 follow-up.
        if (e.shiftKey) {
          toggleOverlaySelected(hit.id);
          return { kind: "overlay", id: hit.id };
        }

        // CLONE-ON-DRAG (native pro feel): Cmd (macOS) / Ctrl (Win/Linux) held at
        // pointer-down duplicates the overlay in place, then drags the COPY away
        // while the original stays put. We use Cmd/Ctrl -- NOT Alt -- because Alt
        // is already Manthan's "disable snap" modifier for a move (see runGesture),
        // so overloading Alt for clone would collide. Cmd/Ctrl is unbound in the
        // pointer path, matches Figma/Sketch's modifier-drag-to-duplicate, and the
        // clone is a real overlay so snap/clamp/the follower all work unchanged.
        let dragOverlay: Overlay = hit;
        if (e.metaKey || e.ctrlKey) {
          const copyId = duplicateOverlay(hit.id); // commits history + selects copy
          if (copyId) {
            const copy =
              useRepurposeStore.getState().overlays.find((o) => o.id === copyId) ?? null;
            // Drag the COPY. The frozen start below uses the ORIGINAL's transform
            // so the clone begins exactly under the hit overlay and only moves as
            // the pointer does. duplicateOverlay already selected copyId, so we
            // skip the selectOverlay call below.
            if (copy) dragOverlay = copy;
          }
        } else {
          selectOverlay(hit.id);
        }

        // Begin a MOVE drag from a frozen snapshot. For a clone we seed the start
        // transform from the ORIGINAL hit (hit.transform), so the copy sits under
        // the pointer at grab time and the drag delta carries it off cleanly --
        // instead of jumping to the store's cosmetic +0.04 offset.
        gestureRef.current = {
          overlayId: dragOverlay.id,
          handle: "move",
          start: {
            transform: { ...hit.transform },
            naturalWidth: hit.naturalWidth,
            naturalHeight: hit.naturalHeight,
            pointerNorm: norm,
          },
          pointerId: e.pointerId,
        };
        // Flag the drag so the chrome LIFTS + the cursor reads "grabbing" (the
        // tactile feel layer). Cleared on pointer-up / cancel / unmount.
        setOverlayDragging(true);
        attachGestureListeners(e.pointerId);
        return { kind: "overlay", id: dragOverlay.id };
      }

      // 2) Missed every overlay -> which base region did we land in?
      const region: "screen" | "face" = norm.y < splitRatio ? "screen" : "face";
      // We do NOT begin a gesture here -- the caller reuses its own region
      // reframe path (makeRegionPointerDown). Report the region + let it decide.
      return { kind: "base", region };
    },
    [
      getRect,
      selectOverlay,
      toggleOverlaySelected,
      duplicateOverlay,
      attachGestureListeners,
      setOverlayDragging,
    ]
  );

  const beginHandleGesture = useCallback(
    (handle: HandleId, e: React.PointerEvent) => {
      const rect = getRect();
      if (!rect) return;
      const { overlays, selectedOverlayId } = useRepurposeStore.getState();
      const ov = overlays.find((o) => o.id === selectedOverlayId);
      if (!ov) return;
      const norm = normFromClient({ x: e.clientX, y: e.clientY }, rect);
      gestureRef.current = {
        overlayId: ov.id,
        handle,
        start: {
          transform: { ...ov.transform },
          naturalWidth: ov.naturalWidth,
          naturalHeight: ov.naturalHeight,
          pointerNorm: norm,
        },
        pointerId: e.pointerId,
      };
      // A resize/rotate is also a live gesture -- lift the chrome the same way.
      setOverlayDragging(true);
      attachGestureListeners(e.pointerId);
    },
    [getRect, attachGestureListeners, setOverlayDragging]
  );

  return { routePointerDown, beginHandleGesture };
}
