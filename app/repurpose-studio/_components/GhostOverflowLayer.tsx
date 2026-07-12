"use client";

// ===========================================================================
// REPURPOSE STUDIO -- GhostOverflowLayer
// ===========================================================================
// Descript-style "the part outside the frame is still visible, dimmed" behavior.
// The composited <canvas> clips every overlay to the 9:16 frame, so an overlay
// dragged partway off-frame (or zoomed larger than the frame) is invisible --
// and un-grabbable -- outside the box. This layer renders a SECOND, ghost copy
// of each active overlay's media that IS allowed to bleed past the frame, at
// reduced opacity, so Manthan can always see + grab it to reposition.
//
// HOW "full opacity inside, dim outside" is achieved WITHOUT a compositor change:
// this layer sits BEHIND the canvas (z-0; the canvas is z-[1] and opaque). The
// ghost is positioned with the EXACT same normalized -> screen mapping the
// compositor uses, so it lines up pixel-for-pixel with the real on-canvas render.
// The portion of the ghost that falls INSIDE the frame is completely covered by
// the opaque canvas; only the portion that spills OUTSIDE the frame shows, and it
// shows at the ghost's ~35% opacity. Inside stays crisp + full-fidelity (it's the
// real canvas render); outside reads as a dim preview. Nothing here is ever drawn
// into the canvas or the export -- pure editor chrome, like the grid.
//
// LIGHTWEIGHT: a ghost is mounted for an overlay ONLY when its axis-aligned bounds
// actually extend outside the frame (otherwise the canvas fully covers it and
// there is nothing to show). Overlays fully inside the frame -- the common case --
// cost nothing. The layer is pointer-events:none; grabbing an off-frame overlay
// still goes through the interaction layer / selection handles, which reach the
// true (possibly off-frame) edges.
// ===========================================================================

import { useEffect, useRef, useState } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { overlayCornersNorm, type PreviewRect } from "@/lib/repurpose/overlay-geometry";
import type { Overlay } from "@/lib/repurpose/types";

/** Opacity of the ghosted off-frame bleed -- dim enough to read as "outside". */
const GHOST_OPACITY = 0.35;

/** One ghost's resolved on-screen box (rect-local CSS px) + its media source. */
interface GhostBox {
  id: string;
  kind: "image" | "video";
  src: string;
  /** For video: the source-file time to show (srcStart + playhead offset). */
  srcTime: number;
  /** Center in rect-local CSS px. */
  cx: number;
  cy: number;
  /** Un-rotated width / height in CSS px. */
  w: number;
  h: number;
  /** Rotation in degrees. */
  rotation: number;
}

/**
 * Does this overlay's axis-aligned bounding box extend OUTSIDE the [0,1] frame on
 * any side? If it's fully inside, the opaque canvas covers it entirely and there
 * is no bleed to draw -- so we skip mounting a ghost for it. Uses the rotation-
 * aware corners so a tilted overlay is judged by its true visible extent.
 */
function bleedsOffFrame(
  ov: Overlay,
  rect: PreviewRect
): boolean {
  const corners = overlayCornersNorm(
    ov.transform,
    ov.naturalWidth,
    ov.naturalHeight,
    rect
  );
  for (const c of corners) {
    if (c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1) return true;
  }
  return false;
}

/**
 * Resolve an overlay's transform into a rect-local pixel box, using the SAME math
 * as SelectionOverlay.resolveBox and the compositor (center at x*W / y*H, width =
 * scale*W, height derived from the intrinsic aspect, rotation in degrees). This is
 * what makes the ghost line up pixel-for-pixel with the on-canvas render.
 */
function resolveGhost(ov: Overlay, rect: PreviewRect): GhostBox {
  const aspect =
    ov.naturalHeight > 0 && ov.naturalWidth > 0
      ? ov.naturalHeight / ov.naturalWidth
      : 1;
  const wPx = ov.transform.scale * rect.width;
  const hPx = wPx * aspect;
  return {
    id: ov.id,
    kind: ov.kind,
    src: ov.src,
    srcTime: ov.srcStart,
    cx: ov.transform.x * rect.width,
    cy: ov.transform.y * rect.height,
    w: wPx,
    h: hPx,
    rotation: ov.transform.rotation,
  };
}

export function GhostOverflowLayer({
  getRect,
}: {
  /** Reads the preview canvas's live on-screen rect (CSS px). Null if unmounted. */
  getRect: () => PreviewRect | null;
}) {
  // Mirror the set of ghost boxes to draw into state via a rAF loop (reading the
  // same store the compositor reads), so the ghosts follow the media as a gesture
  // updates the transform -- frame-for-frame, exactly like SelectionOverlay. We
  // only setState when the resolved boxes actually change (identity guard below)
  // so an idle frame never churns a render.
  const [boxes, setBoxes] = useState<GhostBox[]>([]);
  const boxesRef = useRef<GhostBox[]>([]);
  const rafRef = useRef<number | null>(null);
  // A pool of ghost <video> elements keyed by overlay id, so we can seek each to
  // the current source frame without re-mounting it every frame.
  const videoRef = useRef<Map<string, HTMLVideoElement>>(new Map());

  useEffect(() => {
    const tick = () => {
      const rect = getRect();
      const { overlays, playhead } = useRepurposeStore.getState();
      const next: GhostBox[] = [];
      if (rect) {
        for (const ov of overlays) {
          // Same window filter the compositor uses -- only overlays active at the
          // current playhead can bleed.
          if (playhead < ov.timelineStart || playhead >= ov.timelineEnd) continue;
          if (ov.naturalWidth <= 0 || ov.naturalHeight <= 0) continue;
          // Only overlays that actually extend past the frame need a ghost.
          if (!bleedsOffFrame(ov, rect)) continue;
          const g = resolveGhost(ov, rect);
          // Video: the source frame to show at this output time.
          if (ov.kind === "video") {
            g.srcTime = ov.srcStart + (playhead - ov.timelineStart);
          }
          next.push(g);
        }
      }

      // Identity guard: skip setState when nothing meaningfully moved (avoids a
      // per-frame re-render while nothing is being dragged / bleeding).
      const prev = boxesRef.current;
      let changed = prev.length !== next.length;
      if (!changed) {
        for (let i = 0; i < next.length; i++) {
          const a = prev[i];
          const b = next[i];
          if (
            a.id !== b.id ||
            a.src !== b.src ||
            Math.abs(a.cx - b.cx) > 0.25 ||
            Math.abs(a.cy - b.cy) > 0.25 ||
            Math.abs(a.w - b.w) > 0.25 ||
            Math.abs(a.h - b.h) > 0.25 ||
            Math.abs(a.rotation - b.rotation) > 0.05
          ) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        boxesRef.current = next;
        setBoxes(next);
      }

      // Seek each ghost <video> to its current source frame (cheap: a paused
      // video decoding a single seeked frame -- never played, so it doesn't fight
      // the compositor's own pooled decoder or the master clock).
      for (const g of next) {
        if (g.kind !== "video") continue;
        const v = videoRef.current.get(g.id);
        if (v && v.readyState >= 1 && Math.abs(v.currentTime - g.srcTime) > 1 / 30) {
          v.currentTime = g.srcTime;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [getRect]);

  if (boxes.length === 0) return null;

  return (
    // z-0: BEHIND the canvas (z-[1]). pointer-events:none so grabbing an off-frame
    // overlay goes through the interaction layer / selection handles, not here.
    // inset-0 with overflow-visible-by-inheritance (the container is overflow
    // -visible) lets the media bleed past the frame edges. Each ghost is absolutely
    // positioned + rotated to match the canvas render exactly.
    <div
      className="pointer-events-none absolute inset-0 z-0"
      style={{ opacity: GHOST_OPACITY }}
    >
      {boxes.map((g) => (
        <div
          key={g.id}
          className="absolute left-0 top-0"
          style={{
            width: g.w,
            height: g.h,
            // Translate the box's top-left to (center - half), then rotate about
            // its center -- identical to SelectionOverlay's box transform, so the
            // ghost sits exactly under the real render.
            transform: `translate(${g.cx - g.w / 2}px, ${g.cy - g.h / 2}px) rotate(${g.rotation}deg)`,
            transformOrigin: "center center",
          }}
        >
          {g.kind === "image" ? (
            <img
              src={g.src}
              alt=""
              draggable={false}
              className="block h-full w-full select-none"
              // object-fill: the box already carries the media's true aspect, so
              // filling it is 1:1 with no distortion (matches the canvas draw).
              style={{ objectFit: "fill" }}
            />
          ) : (
            <video
              ref={(el) => {
                if (el) videoRef.current.set(g.id, el);
                else videoRef.current.delete(g.id);
              }}
              src={g.src}
              muted
              playsInline
              preload="metadata"
              className="block h-full w-full select-none"
              style={{ objectFit: "fill" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
