"use client";

// ===========================================================================
// REPURPOSE STUDIO -- SelectionOverlay (DOM chrome for the selected overlay)
// ===========================================================================
// The selection box + 8 resize handles + rotation grip for the currently
// selected OVERLAY, drawn as absolutely-positioned DOM inside the preview
// container -- NOT into the canvas, so the exported frame never contains the
// chrome. Coral (#FF6B35) to match the brand + the split handle.
//
// It tracks the overlay's live transform every animation frame (reading the
// same store the rAF compositor reads), so as a gesture updates the transform
// the box follows the media frame-for-frame. The box itself is a rotated,
// %-positioned element; the handles are counter-rotated back to upright so they
// stay square regardless of the overlay's rotation. Handle pointer-downs are
// forwarded to useObjectSelection.beginHandleGesture (passed in), which runs the
// resize/rotate solver; the box BODY does not begin a drag here -- the preview's
// consolidated pointer-down router owns move (so a body-drag and a canvas click
// share one path). The box is pointer-events:none EXCEPT the handles, so a drag
// that starts on the media (not a handle) still reaches the preview router
// underneath.
// ===========================================================================

import { useEffect, useRef, useState, useCallback } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { HandleId, PreviewRect } from "@/lib/repurpose/overlay-geometry";
import type { OverlayTransform } from "@/lib/repurpose/types";

const CORAL = "#FF6B35";

/** The 8 resize handles laid out around the box, plus the rotate grip above N. */
const RESIZE_HANDLES: ReadonlyArray<{ id: HandleId; cx: number; cy: number; cursor: string }> = [
  { id: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { id: "n", cx: 0.5, cy: 0, cursor: "ns-resize" },
  { id: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { id: "e", cx: 1, cy: 0.5, cursor: "ew-resize" },
  { id: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
  { id: "s", cx: 0.5, cy: 1, cursor: "ns-resize" },
  { id: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { id: "w", cx: 0, cy: 0.5, cursor: "ew-resize" },
];

export interface SelectionOverlayProps {
  /** Reads the preview canvas's current on-screen rect (CSS px). Null if unmounted. */
  getRect: () => PreviewRect | null;
  /** Start a resize/rotate gesture (from useObjectSelection). */
  beginHandleGesture: (handle: HandleId, e: React.PointerEvent) => void;
}

/** The box geometry resolved for THIS frame, in rect-local CSS px. */
interface BoxFrame {
  /** Center in CSS px (rect-local). */
  cx: number;
  cy: number;
  /** Full width / height of the un-rotated box in CSS px. */
  w: number;
  h: number;
  /** Rotation in degrees (from the overlay transform). */
  rotation: number;
}

/**
 * Resolve the selected overlay's transform into a rect-local pixel box. Computes
 * the un-rotated width/height directly from the transform's scale and the
 * media's intrinsic aspect ratio (so the DOM box, a rotated rect, matches the
 * drawn media exactly); rotation is applied as-is via CSS transform.
 */
function resolveBox(
  transform: OverlayTransform,
  naturalWidth: number,
  naturalHeight: number,
  rect: PreviewRect
): BoxFrame {
  // Un-rotated size: width = scale * rectWidth; height derived from aspect.
  const aspect =
    naturalHeight > 0 && naturalWidth > 0 ? naturalHeight / naturalWidth : 1;
  const wPx = transform.scale * rect.width;
  const hPx = wPx * aspect;
  return {
    cx: transform.x * rect.width,
    cy: transform.y * rect.height,
    w: wPx,
    h: hPx,
    rotation: transform.rotation,
  };
}

export function SelectionOverlay({ getRect, beginHandleGesture }: SelectionOverlayProps) {
  // A rAF loop mirrors the selected overlay's live transform into local state so
  // the chrome follows the media as a gesture updates the store. We keep the
  // resolved box in state (re-render on change only) to avoid a per-frame churn.
  const [box, setBox] = useState<BoxFrame | null>(null);
  const boxRef = useRef<BoxFrame | null>(null);
  const rafRef = useRef<number | null>(null);

  // Boxes for the NON-primary members of a multi-selection (lighter outline, no
  // handles). Empty unless >1 overlay is selected. Tracked the same rAF way as the
  // primary box so they follow live edits (e.g. an align nudge).
  const [multiBoxes, setMultiBoxes] = useState<Array<{ id: string } & BoxFrame> | null>(null);
  const multiBoxesRef = useRef<Array<{ id: string } & BoxFrame> | null>(null);

  // Live-drag flag (set by useObjectSelection while a move/resize gesture runs).
  // Drives the tactile FEEL: the selection outline lifts (brighter, softer glow)
  // and the box cursor reads "grabbing" while dragging. A store subscription
  // (not per-frame polling) -- it flips at most twice per gesture.
  const dragging = useRepurposeStore((s) => s.overlayDragging);

  useEffect(() => {
    const tick = () => {
      const rect = getRect();
      const { overlays, selectedOverlayId, selectedOverlayIds } =
        useRepurposeStore.getState();
      const ov = selectedOverlayId
        ? overlays.find((o) => o.id === selectedOverlayId)
        : null;
      let next: BoxFrame | null = null;
      if (rect && ov && ov.naturalWidth > 0 && ov.naturalHeight > 0) {
        next = resolveBox(ov.transform, ov.naturalWidth, ov.naturalHeight, rect);
      }
      const prev = boxRef.current;
      const changed =
        (!!prev !== !!next) ||
        (prev && next &&
          (Math.abs(prev.cx - next.cx) > 0.25 ||
            Math.abs(prev.cy - next.cy) > 0.25 ||
            Math.abs(prev.w - next.w) > 0.25 ||
            Math.abs(prev.h - next.h) > 0.25 ||
            Math.abs(prev.rotation - next.rotation) > 0.05));
      if (changed) {
        boxRef.current = next;
        setBox(next);
      }

      // Secondary outlines: only when the selection has more than one member.
      // Outline every member EXCEPT the primary (which already has full chrome).
      let nextMulti: Array<{ id: string } & BoxFrame> | null = null;
      if (rect && selectedOverlayIds.length > 1) {
        const boxes: Array<{ id: string } & BoxFrame> = [];
        for (const id of selectedOverlayIds) {
          if (id === selectedOverlayId) continue; // primary drawn separately
          const o = overlays.find((ov2) => ov2.id === id);
          if (!o || o.naturalWidth <= 0 || o.naturalHeight <= 0) continue;
          boxes.push({ id, ...resolveBox(o.transform, o.naturalWidth, o.naturalHeight, rect) });
        }
        nextMulti = boxes.length > 0 ? boxes : null;
      }
      const prevMulti = multiBoxesRef.current;
      const multiChanged =
        (!!prevMulti !== !!nextMulti) ||
        (!!prevMulti && !!nextMulti &&
          (prevMulti.length !== nextMulti.length ||
            prevMulti.some((pb, i) => {
              const nb = nextMulti![i];
              return (
                pb.id !== nb.id ||
                Math.abs(pb.cx - nb.cx) > 0.25 ||
                Math.abs(pb.cy - nb.cy) > 0.25 ||
                Math.abs(pb.w - nb.w) > 0.25 ||
                Math.abs(pb.h - nb.h) > 0.25 ||
                Math.abs(pb.rotation - nb.rotation) > 0.05
              );
            })));
      if (multiChanged) {
        multiBoxesRef.current = nextMulti;
        setMultiBoxes(nextMulti);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [getRect]);

  const onHandleDown = useCallback(
    (handle: HandleId) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation(); // don't let the preview router see a handle grab
      beginHandleGesture(handle, e);
    },
    [beginHandleGesture]
  );

  // Nothing selected at all -> render nothing. (When >1 is selected the primary
  // `box` is always present, so this only bails on a truly empty selection.)
  if (!box && !multiBoxes) return null;

  const handleSize = 12; // CSS px
  const rotateOffset = 26; // grip distance above the top edge, CSS px

  return (
    <>
      {/* Secondary members of a multi-selection: a lighter coral outline only, no
          handles. Drawn BEHIND the primary chrome. Each is a rotated, positioned
          box exactly like the primary, but non-interactive. */}
      {multiBoxes?.map((mb) => (
        <div
          key={mb.id}
          className="pointer-events-none absolute left-0 top-0 z-10"
          style={{
            width: mb.w,
            height: mb.h,
            transform: `translate(${mb.cx - mb.w / 2}px, ${mb.cy - mb.h / 2}px) rotate(${mb.rotation}deg)`,
            transformOrigin: "center center",
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              border: `1.5px solid ${CORAL}`,
              opacity: 0.55,
              borderRadius: 2,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.3)",
            }}
          />
        </div>
      ))}

      {/* Primary selection: full chrome (box + handles + rotate grip). */}
      {box && (
    <div
      // The rotated, positioned box. pointer-events:none on the frame itself so a
      // body drag falls through to the preview router; only the handles opt in.
      className="pointer-events-none absolute left-0 top-0 z-20"
      style={{
        width: box.w,
        height: box.h,
        transform: `translate(${box.cx - box.w / 2}px, ${box.cy - box.h / 2}px) rotate(${box.rotation}deg)`,
        transformOrigin: "center center",
      }}
    >
      {/* Selection outline. While dragging it LIFTS -- a soft coral glow + a hair
          of scale -- so grabbing the media feels tactile (the feel layer). The
          transition makes the lift ease in/out rather than snap. */}
      <div
        className="absolute inset-0"
        style={{
          border: `2px solid ${CORAL}`,
          boxShadow: dragging
            ? `0 0 0 1px rgba(0,0,0,0.35), 0 6px 20px rgba(255,107,53,0.35)`
            : "0 0 0 1px rgba(0,0,0,0.35)",
          borderRadius: 2,
          transform: dragging ? "scale(1.012)" : "scale(1)",
          transition: "box-shadow 120ms ease-out, transform 120ms ease-out",
        }}
      />

      {/* Rotation grip stem + grip, centered above the top edge (upright once the
          box's own rotation is composed with it -- it sits along the box's local
          up axis so it rotates with the box, which reads correctly). */}
      <div
        className="pointer-events-none absolute"
        style={{
          left: "50%",
          top: -rotateOffset,
          width: 2,
          height: rotateOffset,
          marginLeft: -1,
          background: CORAL,
        }}
      />
      <div
        onPointerDown={onHandleDown("rotate")}
        title="Rotate (hold Shift to snap 15 degrees)"
        className="pointer-events-auto absolute"
        style={{
          left: "50%",
          top: -rotateOffset - handleSize / 2,
          width: handleSize,
          height: handleSize,
          marginLeft: -handleSize / 2,
          borderRadius: "50%",
          background: "#fff",
          border: `2px solid ${CORAL}`,
          cursor: "grab",
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        }}
      />

      {/* 8 resize handles. Each is a small square pinned at its corner/edge and
          counter-rotated back upright so it stays axis-aligned to the viewer. */}
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.id}
          onPointerDown={onHandleDown(h.id)}
          className="pointer-events-auto absolute"
          style={{
            left: `${h.cx * 100}%`,
            top: `${h.cy * 100}%`,
            width: handleSize,
            height: handleSize,
            marginLeft: -handleSize / 2,
            marginTop: -handleSize / 2,
            background: "#fff",
            border: `2px solid ${CORAL}`,
            borderRadius: 2,
            cursor: h.cursor,
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
            // Counter-rotate the handle so it stays square to the viewer.
            transform: `rotate(${-box.rotation}deg)`,
          }}
        />
      ))}
    </div>
      )}
    </>
  );
}
