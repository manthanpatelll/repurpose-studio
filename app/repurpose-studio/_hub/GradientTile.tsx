// ===========================================================================
// Repurpose Studio hub -- GradientTile
// ===========================================================================
// The project tile. When `thumbSrc` is given it layers a real video-frame
// thumbnail (served by /api/repurpose/thumb -- a 50/50 screen+face composite
// from the project's first kept clip) over a coral-gradient base; the gradient
// shows while the jpeg loads and STAYS as the fallback whenever the route 404s
// (footage moved, no kept clip). The id is hashed to drift the gradient hue a
// little around coral so the list reads varied, not one flat block.
//
//   Full mode (grid card): a 9:16 poster with the project name burned bottom-
//   left and a duration chip bottom-right.
//   Compact mode (list row): a small square-ish thumb, name/duration omitted
//   (the row already shows them as columns).
// ===========================================================================

"use client";

import { useState } from "react";
import { Clock } from "@phosphor-icons/react";
import { formatDuration } from "./formatters";

/** Deterministic small integer hash of a string -- stable per project id. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h << 5) - h + id.charCodeAt(i);
    h |= 0; // keep 32-bit
  }
  return Math.abs(h);
}

export function GradientTile({
  id,
  name,
  durationSec,
  compact = false,
  thumbSrc,
}: {
  id: string;
  name?: string;
  durationSec?: number;
  compact?: boolean;
  /** Optional real-frame thumbnail URL; gradient stays the loading/error base. */
  thumbSrc?: string;
}) {
  // 404 from the thumb route (no footage / no kept clip) -> gradient fallback.
  const [thumbFailed, setThumbFailed] = useState(false);

  // Drift the hue +/-28deg around coral (base ~16). Coral #FF6B35 is ~hue 16.
  const drift = (hashId(id) % 57) - 28; // -28..+28
  const baseHue = 16 + drift;
  const background = `linear-gradient(150deg, hsl(${baseHue} 100% 62%), hsl(${baseHue - 10} 85% 42%))`;

  const thumb =
    thumbSrc && !thumbFailed ? (
      // eslint-disable-next-line @next/next/no-img-element -- local API jpeg, no optimizer
      <img
        src={thumbSrc}
        alt=""
        className="absolute inset-0 size-full object-cover"
        loading="lazy"
        draggable={false}
        onError={() => setThumbFailed(true)}
      />
    ) : null;

  if (compact) {
    return (
      <div
        className="relative size-16 shrink-0 overflow-hidden rounded-xl"
        style={{ background }}
        aria-hidden
      >
        {thumb}
        {/* Top sheen + bottom vignette for depth */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/25 via-transparent to-black/35" />
      </div>
    );
  }

  return (
    <div
      className="relative w-full overflow-hidden rounded-2xl"
      style={{ aspectRatio: "9 / 16", background }}
    >
      {thumb}
      {/* Top sheen + bottom vignette */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/25 via-transparent to-black/45" />

      {/* Project name burned into the bottom-left */}
      {name && (
        <div className="absolute inset-x-0 bottom-0 p-4 pr-14">
          <p className="line-clamp-3 text-lg font-black leading-tight tracking-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)]">
            {name}
          </p>
        </div>
      )}

      {/* Duration chip bottom-right */}
      {durationSec != null && durationSec > 0 && (
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full border border-white/20 bg-black/45 px-2 py-1 text-[10px] font-bold tabular-nums text-white backdrop-blur-md">
          <Clock size={11} weight="fill" />
          {formatDuration(durationSec)}
        </div>
      )}
    </div>
  );
}
