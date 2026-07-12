"use client";

// ===========================================================================
// REPURPOSE STUDIO -- ColorAdjustPanel
// ===========================================================================
// Descript-style "Color adjustments" preset rail. Picks a track (Face / Screen)
// then a color-grade preset for it; the choice is written to the store
// (setGrade) and read back by BOTH the live PreviewCanvas and the MP4 export
// through the same drawFrame + gradeFilter, so the preview and the export grade
// identically.
//
// Thumbnails are procedural -- NO external asset. One shared sample scene
// (sky-to-warm-horizon gradient, a landscape band, a coral structure accent,
// and a skin-tone swatch so Warm/Cool/B&W read instantly) is drawn ONCE into an
// offscreen canvas on mount; each tile then draws that scene into its own tiny
// DPR-aware <canvas> with ctx.filter set to the preset's filter -- the exact
// same filter the compositor applies to real footage. Presets are static, so
// tiles redraw only on mount.
// ===========================================================================

import { useEffect, useRef, useState } from "react";
import { Prohibit } from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { COLOR_GRADES } from "@/lib/repurpose/color-grade";

const CORAL = "#FF6B35";

// Tile thumbnail logical size (CSS px). Backing store is DPR-scaled.
const THUMB_W = 64;
const THUMB_H = 48;

/**
 * Draw the shared sample scene into a context sized `w x h` (logical px). Kept
 * deliberately simple + recognisable so each grade reads at a glance: a sky
 * gradient (warm/cool shift shows here), a landscape band, a coral accent
 * (brand structure), and a skin-tone circle (the tell for Warm/Cool/B&W).
 */
function drawSampleScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): void {
  // Sky: cool blue at the top easing into a warm horizon.
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#5b8fd6");
  sky.addColorStop(0.55, "#a9c6e8");
  sky.addColorStop(1, "#f4c98a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Distant landscape band along the lower third.
  const landTop = h * 0.62;
  ctx.fillStyle = "#4b6b4a";
  ctx.fillRect(0, landTop, w, h - landTop);
  ctx.fillStyle = "#3a5540";
  ctx.beginPath();
  ctx.moveTo(0, landTop + 4);
  ctx.lineTo(w * 0.35, landTop - 5);
  ctx.lineTo(w * 0.6, landTop + 3);
  ctx.lineTo(w, landTop - 2);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // Coral structure accent (brand color) -- a small building/marker on the land.
  ctx.fillStyle = CORAL;
  ctx.fillRect(w * 0.14, landTop - h * 0.18, w * 0.11, h * 0.2);

  // Skin-tone swatch circle -- the fastest read for Warm / Cool / B&W.
  ctx.fillStyle = "#e0a980";
  ctx.beginPath();
  ctx.arc(w * 0.74, h * 0.42, h * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

/** Props: className only; everything else comes from the store. */
export interface ColorAdjustPanelProps {
  className?: string;
}

export function ColorAdjustPanel({ className }: ColorAdjustPanelProps) {
  const screenGrade = useRepurposeStore((s) => s.screenGrade);
  const faceGrade = useRepurposeStore((s) => s.faceGrade);
  const setGrade = useRepurposeStore((s) => s.setGrade);

  // Which track the rail edits. Face-first: it's the grade Manthan tweaks most.
  const [activeTrack, setActiveTrack] = useState<"face" | "screen">("face");
  const activeGrade = activeTrack === "screen" ? screenGrade : faceGrade;

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {/* Header: section label + Face/Screen segmented toggle. */}
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Color adjustments
        </h3>
        <div className="flex items-center gap-1">
          {(["face", "screen"] as const).map((track) => {
            const active = activeTrack === track;
            return (
              <button
                key={track}
                type="button"
                onClick={() => setActiveTrack(track)}
                className={`rounded-md border px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
                  active
                    ? "border-[#FF6B35] text-[#FF6B35]"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {track}
              </button>
            );
          })}
        </div>
      </div>

      {/* Preset rail: fixed-size tiles, horizontal scroll (works from ~280px). */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {COLOR_GRADES.map((grade) => (
          <GradeTile
            key={grade.id}
            id={grade.id}
            label={grade.label}
            filter={grade.filter}
            selected={activeGrade === grade.id}
            onSelect={() => setGrade(activeTrack, grade.id)}
          />
        ))}
      </div>
    </div>
  );
}

function GradeTile({
  id,
  label,
  filter,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  filter: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isNone = id === "none";

  // Draw the shared scene + this preset's filter into the tile once on mount.
  // Presets are static, so there's nothing reactive to re-run on. The "none"
  // tile shows an icon instead, so it has no canvas to paint.
  useEffect(() => {
    if (isNone) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(THUMB_W * dpr);
    canvas.height = Math.round(THUMB_H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Grade the whole thumbnail: set the filter, then draw the scene under it,
    // exactly as the compositor grades real footage.
    ctx.filter = filter || "none";
    drawSampleScene(ctx, THUMB_W, THUMB_H);
    ctx.filter = "none";
  }, [filter, isNone]);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={label}
      className="flex shrink-0 flex-col items-center gap-1"
    >
      <div
        className={`overflow-hidden rounded-lg ${
          selected ? "ring-2 ring-[#FF6B35]" : "ring-1 ring-border"
        }`}
        style={{ width: THUMB_W, height: THUMB_H }}
      >
        {isNone ? (
          <div className="flex h-full w-full items-center justify-center bg-secondary">
            <Prohibit size={20} weight="bold" className="text-muted-foreground" />
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className="h-full w-full"
            style={{ width: THUMB_W, height: THUMB_H }}
          />
        )}
      </div>
      <span
        className={`text-[11px] ${
          selected ? "font-medium text-[#FF6B35]" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
