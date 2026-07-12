"use client";

// ===========================================================================
// REPURPOSE STUDIO -- SnapGuides
// ===========================================================================
// The coral dashed guide lines the preview shows while an overlay is being
// dragged and one of its edges/center snaps to an alignment target (a frame
// edge/center, the split seam, a rule-of-thirds line, or another overlay). It
// renders the transient `activeSnapGuides` the move gesture publishes to the
// store: an array while a snap is live, [] otherwise -- so the lines appear only
// during a drag and vanish on pointer-up with no explicit show/hide here.
//
// EDITOR CHROME ONLY: a pointer-events:none DOM sibling ABOVE the canvas, exactly
// like the alignment grid. It is NEVER drawn into the canvas, so it can
// never bake into the exported frame (the compositor + export never see it).
//
// Each guide is normalized (0..1) along its axis, so a percentage position tracks
// any preview size with no rect math:
//   orientation 'v' -> a full-HEIGHT vertical line at left:  `${coord*100}%`
//   orientation 'h' -> a full-WIDTH  horizontal line at top: `${coord*100}%`
// Dashed via a repeating-linear-gradient (a real dashed stroke, not a solid rule)
// so it reads unmistakably as an alignment guide, in the brand coral #FF6B35.
// ===========================================================================

import { useRepurposeStore } from "@/lib/repurpose/store";

const CORAL = "#FF6B35";

// A crisp coral dash: 5px on / 5px off along the line's length. Vertical lines
// gradient DOWN (to bottom), horizontal lines gradient ACROSS (to right), so the
// dash always runs along the guide rather than across its 1px thickness.
const DASH_V = `repeating-linear-gradient(to bottom, ${CORAL} 0 5px, transparent 5px 10px)`;
const DASH_H = `repeating-linear-gradient(to right, ${CORAL} 0 5px, transparent 5px 10px)`;

export function SnapGuides() {
  const guides = useRepurposeStore((s) => s.activeSnapGuides);
  if (guides.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[15]">
      {guides.map((g, i) =>
        g.orientation === "v" ? (
          // Full-height vertical line at x = coord. -0.5px margin centers the 1px
          // stroke on the exact coordinate so it lands on the pixel it snapped to.
          <div
            key={`v-${i}-${g.coord}`}
            className="absolute inset-y-0"
            style={{
              left: `${g.coord * 100}%`,
              width: 1,
              marginLeft: -0.5,
              backgroundImage: DASH_V,
            }}
          />
        ) : (
          // Full-width horizontal line at y = coord.
          <div
            key={`h-${i}-${g.coord}`}
            className="absolute inset-x-0"
            style={{
              top: `${g.coord * 100}%`,
              height: 1,
              marginTop: -0.5,
              backgroundImage: DASH_H,
            }}
          />
        )
      )}
    </div>
  );
}
