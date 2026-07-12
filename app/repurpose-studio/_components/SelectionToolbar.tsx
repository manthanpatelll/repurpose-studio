"use client";

// ===========================================================================
// REPURPOSE STUDIO -- SelectionToolbar (floating controls for the selection)
// ===========================================================================
// A small floating toolbar that hovers ABOVE the current selection box, always
// UPRIGHT (never rotated with the overlay). It reads the unified canvas-object
// selection (getSelectedObject) and shows the right controls for it:
//   - OVERLAY: scale% readout, opacity slider, z-order (back/backward/forward/
//     front), delete.
//   - BASE (face/screen clip): a "Reset framing" action that strips this scene's
//     pan/zoom override. No z-order / delete (the base layer is fixed bottom and
//     is never removed from the canvas here).
//
// Like SelectionOverlay it is DOM (never drawn into the canvas, so the export
// stays clean) and it tracks the live transform via a rAF read of the store so
// it follows the box. It positions itself at the box's top-center in rect-local
// CSS px and stays upright. Coral (#FF6B35) accents to match the brand.
// ===========================================================================

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import {
  ArrowLineUp,
  ArrowUp,
  ArrowDown,
  ArrowLineDown,
  Trash,
  ArrowsOutCardinal,
  FrameCorners,
  MagnifyingGlassPlus,
  AlignLeft,
  AlignCenterHorizontal,
  AlignRight,
  AlignTop,
  AlignCenterVertical,
  AlignBottom,
  ColumnsPlusRight,
  RowsPlusBottom,
  FlowArrow,
  ArrowLineLeft,
  ArrowLineRight,
  MonitorPlay,
  VideoCamera,
  Minus,
  Plus,
} from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  MIN_OVERLAY_SCALE,
  MAX_OVERLAY_SCALE,
  type PreviewRect,
} from "@/lib/repurpose/overlay-geometry";
import type { OverlayTransform, ClipTransition } from "@/lib/repurpose/types";

const CORAL = "#FF6B35";

/**
 * One zoom control row for the rail: a LOG-mapped slider + a typeable % input.
 * Log mapping because the ranges span multiples (overlay 2%..400%, base framing
 * 100%..600%) -- a linear slider would cram the useful band into a few pixels.
 * The text input keeps a local draft while focused (committed on Enter/blur,
 * discarded on Escape) so typing "15" mid-way never clamps under the cursor.
 * Used by BOTH the overlay rail (transform.scale) and the base-clip rail
 * (per-scene screen/face framing scale).
 */
function ZoomRow({
  icon,
  title,
  value,
  min,
  max,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (scale: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const logMin = Math.log(min);
  const logSpan = Math.log(max) - logMin;
  const sliderPos =
    (Math.log(Math.min(max, Math.max(min, value))) - logMin) / logSpan;
  const pct = Math.round(value * 100);
  // -/+ steppers: one click = 5 percentage points, hard-clamped to the row's
  // own [min, max] -- the base-framing rows bottom out at exactly 100% (as
  // shot), so minus can never dip to 99/98; overlay rows keep their own floor.
  const step = (dir: 1 | -1) =>
    onChange(Math.min(max, Math.max(min, (pct + dir * 5) / 100)));
  return (
    <div className="flex h-7 items-center gap-1.5 px-1" title={title}>
      {icon}
      <button
        type="button"
        title="Zoom out 5%"
        onClick={() => step(-1)}
        disabled={pct <= Math.round(min * 100)}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Minus size={11} weight="bold" />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={sliderPos}
        onChange={(e) =>
          onChange(Math.exp(logMin + parseFloat(e.target.value) * logSpan))
        }
        className="h-1 w-14 cursor-pointer accent-[#FF6B35]"
      />
      <button
        type="button"
        title="Zoom in 5%"
        onClick={() => step(1)}
        disabled={pct >= Math.round(max * 100)}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Plus size={11} weight="bold" />
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(pct)}
        onFocus={(e) => {
          setDraft(String(pct));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft == null) return;
          const typed = parseFloat(draft);
          setDraft(null);
          if (!Number.isFinite(typed)) return;
          onChange(Math.min(max, Math.max(min, typed / 100)));
        }}
        onKeyDown={(e) => {
          // Keep timeline shortcuts (space/delete/arrows) out of this input.
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className="w-8 rounded border border-zinc-700 bg-zinc-800 px-1 text-right text-xs tabular-nums text-zinc-300 outline-none focus:border-[#FF6B35]"
      />
      <span className="text-xs text-zinc-500">%</span>
    </div>
  );
}

/** The transition types offered in the picker, in menu order. */
const TRANSITION_TYPES: ClipTransition["type"][] = ["none", "zoom-settle", "slide"];

/** Human labels for the picker (the raw enum values read poorly in a menu). */
const TRANSITION_LABELS: Record<ClipTransition["type"], string> = {
  none: "Hard cut",
  "zoom-settle": "Zoom settle",
  slide: "Slide",
};

/**
 * The default shape a NEWLY-picked transition gets (mirrors the ingest /
 * persistence DEFAULT_SMART_TRANSITION: a subtle Descript-feel settle, never a
 * pop). Picking "slide" seeds a gentle 6% slide-in from the right. "none" clears
 * the transition entirely (store takes null), so it isn't in this map.
 */
const TRANSITION_PRESET: Record<
  Exclude<ClipTransition["type"], "none">,
  ClipTransition
> = {
  "zoom-settle": { type: "zoom-settle", durationSec: 0.4, amount: 0.025, easing: "natural" },
  slide: { type: "slide", durationSec: 0.4, amount: 0.06, direction: "left", easing: "natural" },
};

export interface SelectionToolbarProps {
  /** Reads the preview canvas's current on-screen rect (CSS px). Null if unmounted. */
  getRect: () => PreviewRect | null;
}

/** What the toolbar is currently pinned to, resolved each frame. */
type ToolbarTarget =
  | {
      kind: "overlay";
      id: string;
      /** Top-center of the box, rect-local CSS px. */
      anchorX: number;
      anchorY: number;
      transform: OverlayTransform;
      opacity: number;
    }
  | {
      kind: "base";
      clipId: string;
      region: "screen" | "face";
    }
  | null;

export function SelectionToolbar({ getRect }: SelectionToolbarProps) {
  const [target, setTarget] = useState<ToolbarTarget>(null);
  const targetRef = useRef<ToolbarTarget>(null);
  const rafRef = useRef<number | null>(null);
  // The docked overlay rail. Positioned `fixed` against the preview panel's LEFT
  // inner edge each frame (hugging the transcript rail) rather than the canvas's
  // left edge -- which left it floating mid-way in the dead space. Written
  // imperatively in the rAF tick to avoid a per-frame React render.
  const railRef = useRef<HTMLDivElement>(null);

  const setOverlayZ = useRepurposeStore((s) => s.setOverlayZ);
  const removeOverlay = useRepurposeStore((s) => s.removeOverlay);
  const setOverlayOpacity = useRepurposeStore((s) => s.setOverlayOpacity);
  const updateOverlayTransform = useRepurposeStore((s) => s.updateOverlayTransform);
  const setClipFaceFraming = useRepurposeStore((s) => s.setClipFaceFraming);
  const setClipScreenFraming = useRepurposeStore((s) => s.setClipScreenFraming);
  const setClipPunch = useRepurposeStore((s) => s.setClipPunch);
  const setClipTransition = useRepurposeStore((s) => s.setClipTransition);
  const alignOverlays = useRepurposeStore((s) => s.alignOverlays);
  const distributeOverlays = useRepurposeStore((s) => s.distributeOverlays);
  const selectedCount = useRepurposeStore((s) => s.selectedOverlayIds.length);

  // Live punch state for the base-clip target so the two punch buttons can
  // render as toggles (add vs REMOVE). target may be null or an overlay, so the
  // lookup guards for a missing clipId and a not-found clip.
  const baseClipId = target?.kind === "base" ? target.clipId : undefined;
  const baseClip = useRepurposeStore((s) =>
    baseClipId ? s.clips.find((c) => c.id === baseClipId) : undefined
  );
  const hasScreenPunch = baseClip?.screenPunch != null;
  const hasFacePunch = baseClip?.facePunch != null;

  // The active clip's incoming transition (the cut INTO it). Absent -> hard cut.
  // The FIRST kept clip is the reel's opening frame with nothing before it, so a
  // transition is meaningless there -- the picker is hidden for it.
  const currentTransition = baseClip?.transitionIn;
  const currentTransitionType: ClipTransition["type"] =
    currentTransition?.type ?? "none";
  const isOpeningClip = useRepurposeStore((s) => {
    if (!baseClipId) return false;
    const firstKept = s.clips.find((c) => c.kept);
    return firstKept?.id === baseClipId;
  });

  // Track the live selection + its box each frame so the toolbar follows a
  // gesture and disappears the instant the selection clears.
  useEffect(() => {
    const tick = () => {
      const rect = getRect();
      const state = useRepurposeStore.getState();
      const sel = state.getSelectedObject();
      let next: ToolbarTarget = null;
      if (rect && sel) {
        if (sel.type === "overlay") {
          const ov = state.overlays.find((o) => o.id === sel.id);
          if (ov && ov.naturalWidth > 0 && ov.naturalHeight > 0) {
            const aspect = ov.naturalHeight / ov.naturalWidth;
            const wPx = ov.transform.scale * rect.width;
            const hPx = wPx * aspect;
            const cx = ov.transform.x * rect.width;
            const cy = ov.transform.y * rect.height;
            // Top-center of the UN-rotated box; the toolbar sits a bit above it.
            // Using the un-rotated top keeps the toolbar stable while rotating.
            next = {
              kind: "overlay",
              id: ov.id,
              anchorX: cx,
              anchorY: cy - hPx / 2,
              transform: ov.transform,
              opacity: ov.opacity,
            };
          }
        } else {
          // Base clip -- only offer reset-framing when it's the ACTIVE scene the
          // preview is editing (the selected clip). Region is derived from which
          // half the playhead scene occupies is not meaningful here, so we key
          // reset on whichever framing the clip carries: expose both resets.
          const clip = state.clips.find((c) => c.id === sel.id && c.kept);
          if (clip) {
            next = { kind: "base", clipId: clip.id, region: "screen" };
          }
        }
      }
      const prev = targetRef.current;
      // Cheap change detection: identity/kind/position/opacity/scale.
      const changed =
        (!!prev !== !!next) ||
        (prev && next && prev.kind !== next.kind) ||
        (prev?.kind === "overlay" &&
          next?.kind === "overlay" &&
          (prev.id !== next.id ||
            Math.abs(prev.anchorX - next.anchorX) > 0.5 ||
            Math.abs(prev.anchorY - next.anchorY) > 0.5 ||
            Math.abs(prev.transform.scale - next.transform.scale) > 1e-4 ||
            Math.abs(prev.opacity - next.opacity) > 1e-3)) ||
        (prev?.kind === "base" &&
          next?.kind === "base" &&
          prev.clipId !== next.clipId);
      if (changed) {
        targetRef.current = next;
        setTarget(next);
      }
      // Dock the rail to the preview panel's LEFT inner edge (hug the
      // transcript rail). Done every frame so it tracks window resizes / layout
      // shifts without a React re-render. BOTH selection kinds render the rail
      // now (overlay controls / base-clip framing controls).
      const rail = railRef.current;
      if (rail && next) {
        const panel = document.getElementById("preview-panel");
        if (panel) {
          const pr = panel.getBoundingClientRect();
          // 12px inset from the panel's left padding edge; vertically centered on
          // the panel so it never rides under the header or off the bottom.
          rail.style.left = `${pr.left + 12}px`;
          rail.style.top = `${pr.top + pr.height / 2}px`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [getRect]);

  const onResetFraming = useCallback(
    (clipId: string) => {
      // Strip BOTH per-scene framings for this clip (revert to as-shot identity).
      setClipScreenFraming(clipId, null);
      setClipFaceFraming(clipId, null);
    },
    [setClipScreenFraming, setClipFaceFraming]
  );

  // TOGGLE the mid-clip zoom punch on a region: if this clip already carries a
  // punch on that region, clicking REMOVES it (store clears field -> undefined);
  // otherwise it adds the default emphasis punch at the playhead.
  const onPunchIn = useCallback(
    (clipId: string, region: "screen" | "face") => {
      const state = useRepurposeStore.getState();
      const clip = state.clips.find((c) => c.id === clipId && c.kept);
      if (!clip) return;
      const existing = region === "screen" ? clip.screenPunch : clip.facePunch;
      if (existing != null) {
        // Already punched here -- remove it (one undo step, per the store).
        setClipPunch(clipId, region, null);
        return;
      }
      const t = state.playhead;
      // Center the punch at the clip's SOURCE time under the current playhead,
      // clamped inside the clip (a playhead parked exactly on the out edge maps
      // to srcEnd, which is fine -- the envelope just tails off at the cut).
      const clampedT = Math.max(clip.timelineStart, Math.min(clip.timelineEnd, t));
      const atSrc = clip.srcStart + (clampedT - clip.timelineStart);
      // Default emphasis punch: +25%, holds 0.6s, natural ease-in.
      setClipPunch(clipId, region, { atSrc, amount: 0.25, holdSec: 0.6, ease: "natural" });
    },
    [setClipPunch]
  );

  // Change this scene's incoming transition TYPE. "none" clears it (hard cut);
  // any real type seeds the subtle Descript-feel preset for that type. If a
  // transition of the same family already exists we KEEP its tweaked
  // amount/duration/direction rather than resetting to the preset.
  const onTransitionType = useCallback(
    (clipId: string, type: ClipTransition["type"]) => {
      if (type === "none") {
        setClipTransition(clipId, null);
        return;
      }
      const existing = useRepurposeStore
        .getState()
        .clips.find((c) => c.id === clipId)?.transitionIn;
      // Same family -> preserve the user's tuned shape, just ensure the type.
      if (existing && existing.type === type) return;
      setClipTransition(clipId, { ...TRANSITION_PRESET[type] });
    },
    [setClipTransition]
  );

  // Flip a SLIDE transition's entry direction (left <-> right). No-op unless the
  // active transition is a slide (the toggle only renders for slides).
  const onFlipSlideDirection = useCallback(
    (clipId: string) => {
      const existing = useRepurposeStore
        .getState()
        .clips.find((c) => c.id === clipId)?.transitionIn;
      if (!existing || existing.type !== "slide") return;
      setClipTransition(clipId, {
        ...existing,
        direction: existing.direction === "right" ? "left" : "right",
      });
    },
    [setClipTransition]
  );

  if (!target) return null;

  const btn =
    "flex h-7 w-7 items-center justify-center rounded text-zinc-200 hover:bg-zinc-700 transition-colors";

  if (target.kind === "base") {
    // Base-clip rail: SAME docked left rail as the overlay branch (one
    // consistent place to look), with framing controls instead of overlay ones.
    // Zoom edits the ACTIVE SCENE's per-region framing only (preserving its
    // pan x/y); the store clamps scale to [1, 6] and handles the syncFaceCam
    // locked-camera case + gesture-coalesced undo.
    const screenFraming = baseClip?.screenFraming;
    const faceFraming = baseClip?.faceFraming;
    const rowBtn =
      "flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors";
    return (
      <div
        ref={railRef}
        className="pointer-events-auto fixed z-30 flex max-h-[80vh] flex-col items-stretch gap-1 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur"
        style={{ left: -9999, top: "50%", transform: "translateY(-50%)" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Per-scene zoom: SCREEN (top region) then FACE (bottom region).
            100% = as shot; slider range mirrors the store's [1, 6] clamp. */}
        <ZoomRow
          icon={<MonitorPlay size={14} weight="bold" style={{ color: CORAL }} />}
          title="SCREEN zoom for this scene (100% = as shot)"
          value={screenFraming?.scale ?? 1}
          min={1}
          max={6}
          onChange={(scale) =>
            setClipScreenFraming(target.clipId, {
              x: screenFraming?.x ?? 0,
              y: screenFraming?.y ?? 0,
              scale,
            })
          }
        />
        <ZoomRow
          icon={<VideoCamera size={14} weight="bold" style={{ color: CORAL }} />}
          title="FACE zoom for this scene (100% = as shot)"
          value={faceFraming?.scale ?? 1}
          min={1}
          max={6}
          onChange={(scale) =>
            setClipFaceFraming(target.clipId, {
              x: faceFraming?.x ?? 0,
              y: faceFraming?.y ?? 0,
              scale,
            })
          }
        />

        <div className="mx-1 my-0.5 h-px bg-zinc-700" />

        <button
          className={`${rowBtn} text-zinc-200 hover:bg-zinc-700`}
          onClick={() => onResetFraming(target.clipId)}
          title="Reset this scene's pan/zoom framing"
        >
          <FrameCorners size={15} weight="bold" />
          Reset framing
        </button>

        {/* Mid-clip zoom punch-in: TOGGLE a transient +25% zoom envelope at the
            playhead for this scene, no split. When a region already carries a
            punch the button flips to a coral ACTIVE state and REMOVES it. */}
        <button
          className={`${rowBtn} ${
            hasScreenPunch
              ? "border border-primary/60 bg-primary/15 text-primary"
              : "text-zinc-200 hover:bg-zinc-700"
          }`}
          onClick={() => onPunchIn(target.clipId, "screen")}
          title={
            hasScreenPunch
              ? "Remove the SCREEN punch on this clip"
              : "Punch in on the SCREEN at the playhead (P)"
          }
        >
          <MagnifyingGlassPlus size={15} weight="bold" style={hasScreenPunch ? undefined : { color: CORAL }} />
          {hasScreenPunch ? "Remove screen punch" : "Screen punch"}
        </button>
        <button
          className={`${rowBtn} ${
            hasFacePunch
              ? "border border-primary/60 bg-primary/15 text-primary"
              : "text-zinc-200 hover:bg-zinc-700"
          }`}
          onClick={() => onPunchIn(target.clipId, "face")}
          title={
            hasFacePunch
              ? "Remove the FACE punch on this clip"
              : "Punch in on the FACE at the playhead (Shift+P)"
          }
        >
          <MagnifyingGlassPlus size={15} weight="bold" />
          {hasFacePunch ? "Remove face punch" : "Face punch"}
        </button>

        {/* Incoming transition (the cut INTO this scene). Hidden on the opening
            clip -- there's nothing before it to transition from. */}
        {!isOpeningClip && (
          <>
            <div className="mx-1 my-0.5 h-px bg-zinc-700" />
            <div className="flex h-7 items-center gap-1.5 px-1">
              <FlowArrow size={15} weight="bold" style={{ color: CORAL }} />
              <select
                value={currentTransitionType}
                onChange={(e) =>
                  onTransitionType(
                    target.clipId,
                    e.target.value as ClipTransition["type"]
                  )
                }
                className="h-7 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-1.5 text-xs text-zinc-200 outline-none focus:border-[#FF6B35]"
                title="Transition INTO this scene"
              >
                {TRANSITION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TRANSITION_LABELS[t]}
                  </option>
                ))}
              </select>
              {currentTransitionType === "slide" && (
                <button
                  className={btn}
                  onClick={() => onFlipSlideDirection(target.clipId)}
                  title={
                    currentTransition?.type === "slide" &&
                    currentTransition.direction === "right"
                      ? "Slides in from the LEFT (click to flip)"
                      : "Slides in from the RIGHT (click to flip)"
                  }
                >
                  {currentTransition?.type === "slide" &&
                  currentTransition.direction === "right" ? (
                    <ArrowLineRight size={15} weight="bold" />
                  ) : (
                    <ArrowLineLeft size={15} weight="bold" />
                  )}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // Overlay toolbar: DOCKED as a vertical rail hugging the preview panel's LEFT
  // inner edge (right up against the transcript rail), NOT the canvas edge --
  // which left it floating mid-way in the dead space. `position: fixed`; its
  // `left`/`top` are set imperatively each rAF frame from #preview-panel's rect
  // (see the tick above), and translateY(-50%) centers it vertically. This
  // replaces the old "float above the box top" placement, which went
  // off-canvas-top and hid under the app header. Divider strips are horizontal
  // (h-px) to suit the column.
  return (
    <div
      ref={railRef}
      className="pointer-events-auto fixed z-30 flex max-h-[80vh] flex-col items-stretch gap-1 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur"
      // Off-screen until the rAF tick sets the real left/top from the panel rect
      // (prevents a one-frame flash at 0,0 on select).
      style={{ left: -9999, top: "50%", transform: "translateY(-50%)" }}
      // Stop pointer-downs on the toolbar from reaching the preview router
      // beneath (which would deselect / begin a drag).
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Scale control: zooms about the overlay's center (scale is the one
          field patched, x/y untouched), same gesture-coalesced undo as a canvas
          resize (`ovxform` key). */}
      <ZoomRow
        icon={<ArrowsOutCardinal size={14} weight="bold" style={{ color: CORAL }} />}
        title="Overlay scale (fraction of frame width)"
        value={target.transform.scale}
        min={MIN_OVERLAY_SCALE}
        max={MAX_OVERLAY_SCALE}
        onChange={(scale) => updateOverlayTransform(target.id, { scale })}
      />

      <div className="mx-1 my-0.5 h-px bg-zinc-700" />

      {/* Opacity slider */}
      <label
        className="flex h-7 items-center gap-1.5 px-1"
        title="Overlay opacity"
      >
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Opac</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={target.opacity}
          onChange={(e) => setOverlayOpacity(target.id, parseFloat(e.target.value))}
          className="h-1 w-14 cursor-pointer accent-[#FF6B35]"
        />
        <span className="w-8 text-right text-xs tabular-nums text-zinc-300">
          {Math.round(target.opacity * 100)}%
        </span>
      </label>

      <div className="mx-1 my-0.5 h-px bg-zinc-700" />

      {/* Z-order controls (overlays only) -- a 2x2 grid to stay compact in the
          rail. */}
      <div className="grid grid-cols-2 gap-1">
        <button className={btn} title="Send to back (Shift+[)" onClick={() => setOverlayZ(target.id, "back")}>
          <ArrowLineDown size={15} weight="bold" />
        </button>
        <button className={btn} title="Send backward ([)" onClick={() => setOverlayZ(target.id, "backward")}>
          <ArrowDown size={15} weight="bold" />
        </button>
        <button className={btn} title="Bring forward (])" onClick={() => setOverlayZ(target.id, "forward")}>
          <ArrowUp size={15} weight="bold" />
        </button>
        <button className={btn} title="Bring to front (Shift+])" onClick={() => setOverlayZ(target.id, "front")}>
          <ArrowLineUp size={15} weight="bold" />
        </button>
      </div>

      {/* Align / Distribute cluster -- only when a multi-selection is active.
          Acts on the WHOLE selection (not just the primary). Rect comes from
          getRect so the pure-geometry store actions have the preview box. A 3x3
          grid keeps the 8 buttons compact inside the vertical rail. */}
      {selectedCount > 1 && (
        <>
          <div className="mx-1 my-0.5 h-px bg-zinc-700" />
          <div className="grid grid-cols-3 gap-1">
          <button
            className={btn}
            title="Align left edges"
            onClick={() => { const r = getRect(); if (r) alignOverlays("left", r); }}
          >
            <AlignLeft size={15} weight="bold" />
          </button>
          <button
            className={btn}
            title="Align horizontal centers"
            onClick={() => { const r = getRect(); if (r) alignOverlays("hcenter", r); }}
          >
            <AlignCenterVertical size={15} weight="bold" />
          </button>
          <button
            className={btn}
            title="Align right edges"
            onClick={() => { const r = getRect(); if (r) alignOverlays("right", r); }}
          >
            <AlignRight size={15} weight="bold" />
          </button>
          <button
            className={btn}
            title="Align top edges"
            onClick={() => { const r = getRect(); if (r) alignOverlays("top", r); }}
          >
            <AlignTop size={15} weight="bold" />
          </button>
          <button
            className={btn}
            title="Align vertical centers"
            onClick={() => { const r = getRect(); if (r) alignOverlays("vcenter", r); }}
          >
            <AlignCenterHorizontal size={15} weight="bold" />
          </button>
          <button
            className={btn}
            title="Align bottom edges"
            onClick={() => { const r = getRect(); if (r) alignOverlays("bottom", r); }}
          >
            <AlignBottom size={15} weight="bold" />
          </button>
          {/* Distribute needs >= 3 to do anything; the store no-ops otherwise, and
              we dim the buttons below 3 so the affordance reads honestly. */}
          <button
            className={btn}
            title="Distribute horizontally (needs 3+)"
            disabled={selectedCount < 3}
            style={{ opacity: selectedCount < 3 ? 0.35 : 1 }}
            onClick={() => { const r = getRect(); if (r) distributeOverlays("h", r); }}
          >
            <ColumnsPlusRight size={15} weight="bold" />
          </button>
          <button
            className={btn}
            title="Distribute vertically (needs 3+)"
            disabled={selectedCount < 3}
            style={{ opacity: selectedCount < 3 ? 0.35 : 1 }}
            onClick={() => { const r = getRect(); if (r) distributeOverlays("v", r); }}
          >
            <RowsPlusBottom size={15} weight="bold" />
          </button>
          </div>
        </>
      )}

      <div className="mx-1 my-0.5 h-px bg-zinc-700" />

      {/* Delete -- full-width in the rail so it's an unmistakable target. */}
      <button
        className="flex h-7 items-center justify-center gap-1 rounded text-xs text-red-300 hover:bg-red-950/50"
        title="Delete overlay (Delete)"
        onClick={() => removeOverlay(target.id)}
      >
        <Trash size={15} weight="bold" />
        Delete
      </button>
    </div>
  );
}
