"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useDeselectOnOutsideClick
// ===========================================================================
// Clears the canvas selection (the coral selection chrome) whenever a
// pointer-down lands ANYWHERE outside the preview container -- the transcript
// rail, the inspector, the timeline, the top bar, or the dark margin around
// the 9:16 preview. Before this, selection only cleared on empty space INSIDE
// the preview (PreviewCanvas' onLayerPointerDown), so clicking any other panel
// left the overlay/clip selected with its handles floating over the video.
//
// WHY a document-level pointerdown listener: the click that should deselect
// happens on a sibling panel React knows nothing about, so there is no single
// React ancestor to hang an onPointerDown on. One capture-free document
// listener sees every pointer-down and asks one question: did this land inside
// the preview CONTAINER? If not, deselect.
//
// WHY the CONTAINER, not the canvas rect: the selection chrome + toolbar are
// DOM siblings of the canvas inside the same relative container. When an
// overlay bleeds off-frame (or once the ghost-overflow guides land) those
// handles can sit slightly OUTSIDE the canvas' own box but are still legit
// parts of the selection -- clicking them must NOT deselect. Because they live
// inside the container, `container.contains(target)` is the correct boundary:
// canvas + chrome + toolbar + split handle all pass, everything else fails.
//
// It is PURELY additive: it does NOT preventDefault or stopPropagation, so the
// click it observed still proceeds normally into whatever panel was clicked
// (a transcript take, an inspector control, a timeline scrub). It only ever
// writes to the store, and only when something is actually selected -- a
// no-selection click is a no-op (no needless store write / re-render).
//
// `pointerdown` (not `click`) so the deselect feels immediate -- the chrome
// disappears the instant the mouse goes down, before the click completes.
// ===========================================================================

import { useEffect, type RefObject } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";

/**
 * Deselect the current canvas object when a pointer-down lands outside the
 * preview `container` (the relative wrapper holding the canvas + selection
 * chrome + toolbar). No-op while nothing is selected.
 *
 * @param containerRef ref to the preview CONTAINER element (canvas + chrome).
 */
export function useDeselectOnOutsideClick(
  containerRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Inside the preview (canvas, selection handles, rotate grip, toolbar,
      // split handle) -> leave selection alone; those are how the selection is
      // manipulated, and empty-space-inside deselect is already handled by the
      // canvas router. `contains` treats the element itself as "inside" too.
      const target = e.target;
      if (target instanceof Node && container.contains(target)) return;

      // Inside the TIMELINE -> also leave selection alone. The timeline owns its
      // own clip/overlay selection: a click on a clip or overlay BLOCK selects it
      // (OverlayBlock/ClipBlock call selectOverlay/selectClip on pointer-down),
      // and a click on the empty track/ruler runs the timeline's own scrub +
      // deselect. Those blocks stopPropagation on their React handler, but this
      // is a document-level listener that a synthetic stopPropagation can't reach
      // -- so without this guard EVERY timeline click (including selecting a block)
      // would fire here and instantly wipe the selection the block just made. The
      // timeline is a sibling panel outside the preview container, so guard on it
      // explicitly. (#timeline-panel wraps the whole timeline; see page.tsx.)
      if (target instanceof Element && target.closest("#timeline-panel")) return;

      // Outside the preview entirely -> clear whatever is selected, but only if
      // there IS a selection (guard against needless store writes / renders).
      const { selectedOverlayId, selectedClipId, selectOverlay, selectClip } =
        useRepurposeStore.getState();
      if (selectedOverlayId === null && selectedClipId === null) return;
      selectOverlay(null);
      selectClip(null);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [containerRef]);
}
