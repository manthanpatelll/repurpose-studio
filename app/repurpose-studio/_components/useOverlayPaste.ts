"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useOverlayPaste
// ===========================================================================
// A window-level `paste` listener that turns an image/video pasted from the
// clipboard into an overlay at the current playhead. Mounted once at the studio
// page root.
//
// GATING: paste is a global event, so it must NOT hijack a genuine text paste
// into an input / textarea / contentEditable field, or a paste while focus is
// inside the transcript panel (#transcript-panel) -- there the user is editing
// words, not dropping media. When the paste target is one of those, we bail and
// let the browser's native paste run. Only a bare-canvas / timeline paste of a
// real image/video blob becomes an overlay.
// ===========================================================================

import { useEffect } from "react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { ingestOverlayFile } from "@/lib/repurpose/overlay-ingest";

/** True when the event's target is a place a normal text paste should win. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // Anywhere inside the transcript rail -- word editing, not media dropping.
  if (target.closest("#transcript-panel")) return true;
  return false;
}

/**
 * Mount a global paste -> overlay pipeline. A pasted image/video blob is ingested
 * at the current playhead (copy-to-disk, then addOverlay). Text pastes and pastes
 * into editable fields / the transcript panel are left to the browser.
 */
export function useOverlayPaste(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Don't steal a real text paste into an input / the transcript.
      if (isEditableTarget(e.target)) return;
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;

      // Grab the FIRST image/video blob in the payload (a pasted screenshot is a
      // single image item; a copied file may carry one media item).
      let mediaFile: File | null = null;
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        if (!item.type.startsWith("image/") && !item.type.startsWith("video/")) continue;
        const file = item.getAsFile();
        if (file) {
          mediaFile = file;
          break;
        }
      }
      if (!mediaFile) return; // no media -> let the native paste run

      // We ARE handling this as a media paste -> block the default text paste.
      e.preventDefault();
      const atTime = useRepurposeStore.getState().playhead;
      // Place at the canvas center (default drop point) at the current playhead.
      void ingestOverlayFile(mediaFile, atTime).catch((err) => {
        console.error("Overlay paste ingest failed:", err);
      });
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}
