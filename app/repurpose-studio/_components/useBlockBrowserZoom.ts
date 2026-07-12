"use client";

// ===========================================================================
// REPURPOSE STUDIO -- useBlockBrowserZoom
// ===========================================================================
// Blocks BROWSER-level zoom (Chrome page zoom) while the studio is open, so
// zooming the timeline never also zooms the whole app UI. Manthan hit exactly
// that: ctrl/cmd+scroll over the timeline zoomed the timeline AND Chrome.
//
// WHY a native document listener: React 17+ attaches its root `wheel`
// listener as PASSIVE, so an `e.preventDefault()` inside a component's
// `onWheel` (like the Timeline's zoom handler) is silently ignored by the
// browser -- it cannot stop page zoom. Only a native listener registered with
// `{ passive: false }` can. Registered in the CAPTURE phase on `document` so
// it beats everything else; preventDefault does NOT stop propagation, so the
// Timeline's own ctrl/cmd+wheel zoom keeps working -- only Chrome's default
// page-zoom reaction is suppressed.
//
// What is blocked, page-wide while mounted:
//   - ctrl/cmd + wheel        (Chrome zoom shortcut on scroll)
//   - trackpad pinch          (Chrome reports it as a ctrlKey wheel event)
//   - ctrl/cmd + = / + / - / 0 (keyboard zoom in / out / reset)
//   - Safari gesture* events   (pinch; not fired by Chrome, harmless there)
//
// Scoped to the page: mounted from RepurposeStudioPage, removed on unmount,
// so the rest of the app keeps normal browser zoom behavior.
// ===========================================================================

import { useEffect } from "react";

export function useBlockBrowserZoom(): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // Plain scroll must stay native (timeline pan, panel scrolling); only
      // the zoom chord is intercepted.
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // "=" is the unshifted "+" key; Chrome treats cmd+= as zoom-in. "0" is
      // zoom-reset. These particular browser shortcuts ARE preventable from
      // keydown (unlike e.g. cmd+T), which is how Figma-style editors do it.
      if (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0") {
        e.preventDefault();
      }
    };

    const onGesture = (e: Event) => e.preventDefault();

    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("keydown", onKeyDown, { capture: true });
    // Safari-only pinch events; no-ops in Chrome.
    document.addEventListener("gesturestart", onGesture);
    document.addEventListener("gesturechange", onGesture);
    document.addEventListener("gestureend", onGesture);

    return () => {
      document.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("gesturestart", onGesture);
      document.removeEventListener("gesturechange", onGesture);
      document.removeEventListener("gestureend", onGesture);
    };
  }, []);
}
