"use client";

// ===========================================================================
// REPURPOSE STUDIO -- TransportBar
// ===========================================================================
// The NLE control strip: a real video-editor transport (play/pause, frame
// step, jump to start/end, loop, in/out region marks, big time readout) plus
// the global keyboard shortcuts that make the editor feel like Descript /
// Premiere. This is the "where is play/pause and keyboard shortcuts" surface
// that was missing -- every button and every key maps 1:1 onto an action the
// store already owns (see lib/repurpose/store.ts):
//   togglePlay, stepFrame(±1), seekToStart/seekToEnd, toggleLoop,
//   setInPoint/setOutPoint/clearInOut, setPlayhead.
//
// State consumed (read-only here): playhead, duration, isPlaying, inPoint,
// outPoint, loopPlayback, footageMeta (for fps -> frame-accurate readout).
//
// Keyboard: ONE window keydown listener, guarded by the SAME isEditable check
// Timeline.tsx uses (INPUT/TEXTAREA/contentEditable -> bail) so typing in a
// field never hijacks transport. Delete/Backspace are deliberately NOT bound
// here -- Timeline.tsx owns clip-delete; binding them would collide. The live
// playhead is read via useRepurposeStore.getState() inside the handler so the
// 1s shift-jumps always offset the CURRENT value, never a stale closure.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SkipBack,
  SkipForward,
  CaretLeft,
  CaretRight,
  Play,
  Pause,
  Repeat,
  BracketsSquare,
  Keyboard,
  ArrowUUpLeft,
  ArrowUUpRight,
  Scissors,
  BookmarkSimple,
  Broom,
  Gauge,
  Check,
  X,
  LockSimple,
  LockSimpleOpen,
} from "@phosphor-icons/react";
import { useRepurposeStore, PLAYBACK_RATES } from "@/lib/repurpose/store";
import type { ClipTransition } from "@/lib/repurpose/types";

export interface TransportBarProps {
  /** Optional wrapper class override; the bar lays out as a horizontal strip. */
  className?: string;
}

const FALLBACK_FPS = 30;

/**
 * Global transition presets for the "restyle every cut" picker. Mirror the
 * per-clip presets in SelectionToolbar + ingest's DEFAULT_SMART_TRANSITION: a
 * subtle Descript-feel settle, never a pop. "none" clears every real cut to a
 * hard cut (store takes null), so it isn't in this map.
 */
const GLOBAL_TRANSITION_PRESET: Record<
  Exclude<ClipTransition["type"], "none">,
  ClipTransition
> = {
  "zoom-settle": { type: "zoom-settle", durationSec: 0.4, amount: 0.025, easing: "natural" },
  slide: { type: "slide", durationSec: 0.4, amount: 0.06, direction: "left", easing: "natural" },
};

/**
 * Format seconds as mm:ss.ff where ff is the frame index within the second
 * (0..fps-1), matching the store's per-frame stepping (stepFrame uses the same
 * fps). Frame-accurate readout is what an NLE scrub needs -- centiseconds would
 * drift from where a single ArrowLeft/Right actually lands the playhead.
 */
function formatTimecodeFrames(seconds: number, fps: number): string {
  const safe = Math.max(0, seconds);
  // Frame math MUST use an integer fps. A fractional source fps (e.g. 29.1666
  // from the footage manifest) makes `totalFrames % fps` a float, which is what
  // printed the raw "0:36.17.999999999999957" -- round fps to a whole number of
  // frames per second for display.
  const wholeFps = Math.max(1, Math.round(fps));
  const totalFrames = Math.round(safe * wholeFps);
  const frame = totalFrames % wholeFps;
  const totalSecs = Math.floor(totalFrames / wholeFps);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}.${frame.toString().padStart(2, "0")}`;
}

/** Compact mm:ss for the in/out region chip (frame precision is noise there). */
function formatShort(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe - mins * 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format a rate for the speed menu: "1x", "1.5x", "0.75x" -- no trailing zeros.
 * The rate ladder itself is the store's PLAYBACK_RATES (shared with the J/K/L
 * shuttle) so the menu and the shuttle can never drift.
 */
function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

/** True on macOS -- picks ⌘ over Ctrl for the undo/redo chords + their labels. */
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

/** Each keyboard binding, mirrored EXACTLY by the shortcuts popover below. */
const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Space", action: "Play / Pause" },
  { keys: "Left / Right", action: "Step 1 frame" },
  { keys: "Shift + Left / Right", action: "Jump 1 second" },
  { keys: "Home / End", action: "Go to start / end" },
  { keys: "I / O", action: "Set in / out point" },
  { keys: "J / K / L", action: "Shuttle down / stop / up" },
  { keys: "Shift + L", action: "Toggle loop" },
  { keys: "S", action: "Split clip at playhead" },
  { keys: "M", action: "Add marker at playhead" },
  { keys: "[ / ]", action: "Prev / next marker" },
  { keys: "N", action: "Toggle snapping" },
  { keys: "Z", action: "Zoom to selection" },
  { keys: "Shift + Z", action: "Fit to window" },
  { keys: `${MOD_LABEL} + D`, action: "Duplicate clip / overlay" },
  { keys: `${MOD_LABEL} + Z`, action: "Undo" },
  { keys: `${MOD_LABEL} + Shift + Z`, action: "Redo" },
  // --- Selected overlay (canvas) ---
  { keys: "Arrows", action: "Nudge overlay 1px" },
  { keys: "Shift + Arrows", action: "Nudge overlay 10px" },
  { keys: `${MOD_LABEL} + ] / [`, action: "Overlay forward / back" },
  { keys: "Delete", action: "Remove selected overlay" },
];

/**
 * The Repurpose Studio transport bar. Centered play cluster flanked by a large
 * frame-accurate time readout (left) and loop / in-out / shortcuts controls
 * (right). All actions come straight from useRepurposeStore.
 */
export function TransportBar({ className }: TransportBarProps) {
  const playhead = useRepurposeStore((s) => s.playhead);
  const duration = useRepurposeStore((s) => s.duration);
  const isPlaying = useRepurposeStore((s) => s.isPlaying);
  const inPoint = useRepurposeStore((s) => s.inPoint);
  const outPoint = useRepurposeStore((s) => s.outPoint);
  const loopPlayback = useRepurposeStore((s) => s.loopPlayback);
  const fps = useRepurposeStore((s) => s.footageMeta?.fps) ?? FALLBACK_FPS;

  const togglePlay = useRepurposeStore((s) => s.togglePlay);
  const stepFrame = useRepurposeStore((s) => s.stepFrame);
  const seekToStart = useRepurposeStore((s) => s.seekToStart);
  const seekToEnd = useRepurposeStore((s) => s.seekToEnd);
  const setInPoint = useRepurposeStore((s) => s.setInPoint);
  const setOutPoint = useRepurposeStore((s) => s.setOutPoint);
  const clearInOut = useRepurposeStore((s) => s.clearInOut);
  const toggleLoop = useRepurposeStore((s) => s.toggleLoop);

  // Undo / redo: actions + reactive availability (button enable + labels).
  const undo = useRepurposeStore((s) => s.undo);
  const redo = useRepurposeStore((s) => s.redo);
  const canUndo = useRepurposeStore((s) => s.past.length > 0);
  const canRedo = useRepurposeStore((s) => s.future.length > 0);

  // Split the clip under the playhead into two at the playhead (S).
  const splitClipAtPlayhead = useRepurposeStore((s) => s.splitClipAtPlayhead);
  // Add a ruler marker at the playhead (M).
  const addMarker = useRepurposeStore((s) => s.addMarker);
  // Reset ALL scene framing: drop every per-clip screen framing + face framing
  // override (and any custom split ratio) back to defaults. Disabled when no
  // clip carries an override.
  const resetAllFraming = useRepurposeStore((s) => s.resetAllFraming);
  const hasMotion = useRepurposeStore((s) =>
    s.clips.some(
      (c) =>
        c.screenFraming !== undefined ||
        c.faceFraming !== undefined ||
        c.splitRatio !== undefined
    )
  );
  // Face-cam sync: when on (default), dragging/scrolling the face region
  // repositions the locked camera on EVERY scene at once instead of just the
  // active one. See lib/repurpose/store.ts `syncFaceCam` doc.
  const syncFaceCam = useRepurposeStore((s) => s.syncFaceCam);
  const toggleSyncFaceCam = useRepurposeStore((s) => s.toggleSyncFaceCam);

  // Global DEFAULT transition: restyle every real cut at once. `hasRealCuts`
  // gates the control (a single-clip reel has no cut to style). `defaultType` is
  // the type shared by every real cut, or "mixed" when they diverge (the select
  // then shows a neutral "Mixed" placeholder until the user picks one style).
  const setDefaultTransition = useRepurposeStore((s) => s.setDefaultTransition);
  const realCutCount = useRepurposeStore(
    (s) => s.clips.filter((c) => c.kept && c.transitionIn !== undefined).length
  );
  const defaultTransitionType = useRepurposeStore((s) => {
    const realCuts = s.clips.filter((c) => c.kept && c.transitionIn !== undefined);
    if (realCuts.length === 0) return "none" as const;
    const first = realCuts[0].transitionIn!.type;
    return realCuts.every((c) => c.transitionIn!.type === first) ? first : "mixed";
  });

  // Playback rate + J/K/L shuttle.
  const playbackRate = useRepurposeStore((s) => s.playbackRate);
  const setPlaybackRate = useRepurposeStore((s) => s.setPlaybackRate);

  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  // The speed pill lives inside the timeline's `overflow-hidden` box, so a
  // normally-positioned dropdown gets clipped. We render the menu with `fixed`
  // coordinates measured off the trigger's bounding rect instead, so it floats
  // above every ancestor. `speedRect` is the trigger's screen rect at open time.
  const speedBtnRef = useRef<HTMLButtonElement | null>(null);
  const [speedRect, setSpeedRect] = useState<DOMRect | null>(null);
  const shortcutsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [shortcutsRect, setShortcutsRect] = useState<DOMRect | null>(null);

  const toggleSpeedMenu = useCallback(() => {
    setShowSpeed((v) => {
      if (!v && speedBtnRef.current) {
        setSpeedRect(speedBtnRef.current.getBoundingClientRect());
      }
      return !v;
    });
  }, []);

  const toggleShortcutsMenu = useCallback(() => {
    setShowShortcuts((v) => {
      if (!v && shortcutsBtnRef.current) {
        setShortcutsRect(shortcutsBtnRef.current.getBoundingClientRect());
      }
      return !v;
    });
  }, []);

  const disabled = duration <= 0;
  const effectiveFps = fps > 0 ? fps : FALLBACK_FPS;
  const hasRegion = inPoint !== null || outPoint !== null;

  const setInHere = useCallback(() => {
    setInPoint(useRepurposeStore.getState().playhead);
  }, [setInPoint]);
  const setOutHere = useCallback(() => {
    setOutPoint(useRepurposeStore.getState().playhead);
  }, [setOutPoint]);

  // ---- global keyboard shortcuts -------------------------------------------
  // Single stable listener. Actions are read from the store (stable identities)
  // and the LIVE playhead via getState(), so the effect never needs playhead as
  // a dependency -- no re-subscribe on every scrub frame. Same isEditable guard
  // as Timeline.tsx so typing in an input never triggers transport.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isEditable) return;

      const store = useRepurposeStore.getState();

      // Undo / redo (⌘/Ctrl + Z, ⌘/Ctrl + Shift + Z or ⌘/Ctrl + Y). Handled
      // FIRST and independent of the `duration > 0` guard below -- history can
      // exist for edits (a caption toggle, a grade) before any timeline is laid
      // out. `metaKey` is ⌘ on macOS; `ctrlKey` covers Windows/Linux.
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.code === "KeyZ" || e.code === "KeyY")) {
        e.preventDefault();
        const redoChord = e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey);
        if (redoChord) store.redo();
        else store.undo();
        return;
      }

      if (store.duration <= 0) return;

      switch (e.code) {
        case "Space":
          e.preventDefault(); // stop the page from scrolling
          store.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) store.setPlayhead(store.playhead - 1);
          else store.stepFrame(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) store.setPlayhead(store.playhead + 1);
          else store.stepFrame(1);
          break;
        case "Home":
          e.preventDefault();
          store.seekToStart();
          break;
        case "End":
          e.preventDefault();
          store.seekToEnd();
          break;
        case "KeyI":
          e.preventDefault();
          store.setInPoint(store.playhead);
          break;
        case "KeyO":
          e.preventDefault();
          store.setOutPoint(store.playhead);
          break;
        case "KeyJ":
          // Shuttle DOWN the forward-rate ladder (pauses at the bottom). No
          // reverse video playback -- see store.shuttle.
          e.preventDefault();
          store.shuttle(-1);
          break;
        case "KeyK":
          // Stop + reset to 1x (the shuttle "park" key).
          e.preventDefault();
          store.shuttle(0);
          break;
        case "KeyL":
          // Shift+L keeps the old loop toggle; plain L now shuttles UP the
          // forward-rate ladder (J/K/L review, the NLE standard STEP 7 wants).
          e.preventDefault();
          if (e.shiftKey) store.toggleLoop();
          else store.shuttle(1);
          break;
        case "KeyS":
          // Split the clip under the playhead. Plain S only -- a modified S
          // (Cmd/Ctrl+S = browser save) is left alone.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          store.splitClipAtPlayhead();
          break;
        case "Slash":
          // "/" also splits, Descript-style: click a word (transcript or clip
          // word cell) to park the playhead, press "/" to carve a manual scene
          // there. Plain only -- Cmd/Ctrl+/ is left for browser shortcuts.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          store.splitClipAtPlayhead();
          break;
        case "KeyC": {
          // Cmd/Ctrl+C with a scene or overlay selected copies its VISUAL
          // ATTRIBUTES (framing / transform + opacity) for the Paste Attributes
          // chord below. A live text selection keeps the native copy, and the
          // default is only swallowed when the copy was actually ours.
          if (!mod || e.shiftKey || e.altKey) break;
          const sel = window.getSelection();
          if (sel && sel.type === "Range") break;
          if (store.copySelectedAttributes()) e.preventDefault();
          break;
        }
        case "KeyV":
          // Cmd/Ctrl+Shift+V pastes the copied attributes onto the current
          // same-kind selection (Descript's Paste Attributes chord). Plain
          // Cmd/Ctrl+V stays the media-blob paste (useOverlayPaste).
          if (!mod || !e.shiftKey || e.altKey) break;
          if (store.pasteAttributesToSelection()) e.preventDefault();
          break;
        case "KeyM":
          // Add a marker at the playhead. Plain M only.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          store.addMarker();
          break;
        case "BracketLeft":
          // "[" -- jump the play mark to the previous marker. Plain only (Cmd/
          // Ctrl/Alt left alone -- Cmd/Ctrl+[ restacks a selected overlay in
          // PreviewCanvas). No-op with no earlier marker.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          store.prevMarker();
          break;
        case "BracketRight":
          // "]" -- jump the play mark to the next marker. Plain only.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          store.nextMarker();
          break;
        case "KeyN":
          // Toggle timeline snapping (the magnet). Plain N only.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          store.toggleSnap();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      className={`flex items-center gap-3 border-t border-neutral-800 bg-neutral-950 px-4 py-2.5 ${className ?? ""}`}
    >
      {/* LEFT -- big frame-accurate time readout / total */}
      <div className="flex min-w-0 shrink-0 items-baseline gap-1.5">
        <span className="font-mono text-lg tabular-nums text-neutral-100">
          {formatTimecodeFrames(playhead, effectiveFps)}
        </span>
        <span className="font-mono text-xs tabular-nums text-neutral-600">
          / {formatTimecodeFrames(duration, effectiveFps)}
        </span>
      </div>

      {/* CENTER -- transport cluster */}
      <div className="flex flex-1 items-center justify-center gap-1.5">
        <GhostButton
          onClick={seekToStart}
          disabled={disabled}
          title="Go to start (Home)"
          aria-label="Go to start"
        >
          <SkipBack size={17} weight="fill" />
        </GhostButton>
        <GhostButton
          onClick={() => stepFrame(-1)}
          disabled={disabled}
          title="Step back 1 frame (Left)"
          aria-label="Step back one frame"
        >
          <CaretLeft size={18} weight="bold" />
        </GhostButton>

        {/* primary play/pause -- coral filled, 2-layer lift-off shadow */}
        <button
          type="button"
          onClick={togglePlay}
          disabled={disabled}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="mx-1 grid h-11 w-11 place-items-center rounded-full bg-[#FF6B35] text-white transition-all hover:bg-[#FF8F6B] active:scale-95 disabled:opacity-40 disabled:hover:bg-[#FF6B35]"
          style={{
            boxShadow: disabled
              ? "none"
              : "0 6px 16px -4px rgba(255,107,53,0.5), 0 2px 6px -2px rgba(0,0,0,0.4)",
          }}
        >
          {isPlaying ? (
            <Pause size={20} weight="fill" />
          ) : (
            // nudge the play triangle optically-centered inside the circle
            <Play size={20} weight="fill" className="translate-x-px" />
          )}
        </button>

        <GhostButton
          onClick={() => stepFrame(1)}
          disabled={disabled}
          title="Step forward 1 frame (Right)"
          aria-label="Step forward one frame"
        >
          <CaretRight size={18} weight="bold" />
        </GhostButton>
        <GhostButton
          onClick={seekToEnd}
          disabled={disabled}
          title="Go to end (End)"
          aria-label="Go to end"
        >
          <SkipForward size={17} weight="fill" />
        </GhostButton>

        {/* Playback-speed selector -- a Descript-style speedometer that opens the
            full rate ladder (0.5x .. 2.5x) as a menu with a check on the active
            rate. The J/K/L shuttle drives the SAME store value + ladder, so the
            menu and the shuttle can never disagree. The trigger always shows the
            current rate so speed is glanceable without opening the menu. */}
        <div className="relative ml-2">
          <button
            ref={speedBtnRef}
            type="button"
            onClick={toggleSpeedMenu}
            disabled={disabled}
            aria-label="Playback speed"
            aria-haspopup="menu"
            aria-expanded={showSpeed}
            title="Playback speed"
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-semibold tabular-nums transition-colors disabled:opacity-40 ${
              showSpeed
                ? "border-[#FF6B35] bg-[#FF6B35] text-white"
                : "border-[#FF6B35]/40 bg-[#FF6B35]/15 text-[#FF8F6B] hover:bg-[#FF6B35]/25 hover:text-white"
            }`}
          >
            <Gauge size={15} weight="bold" />
            {formatRate(playbackRate)}
          </button>
          {showSpeed && speedRect && (
            <>
              {/* click-away backdrop */}
              <div
                className="fixed inset-0 z-[60]"
                onClick={() => setShowSpeed(false)}
              />
              {/* Fixed-positioned so it escapes the timeline's overflow-hidden
                  box (which was clipping a normally-positioned dropdown). Anchored
                  centered above the trigger, bottom edge 8px above it. */}
              <div
                role="menu"
                aria-label="Playback speed"
                style={{
                  position: "fixed",
                  left: speedRect.left + speedRect.width / 2,
                  bottom: window.innerHeight - speedRect.top + 8,
                  transform: "translateX(-50%)",
                }}
                className="z-[70] max-h-72 w-28 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-2xl"
              >
                {PLAYBACK_RATES.map((r) => {
                  const active = Math.abs(playbackRate - r) < 1e-3;
                  return (
                    <button
                      key={r}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        setPlaybackRate(r);
                        setShowSpeed(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs tabular-nums transition-colors ${
                        active
                          ? "bg-[#FF6B35]/15 font-semibold text-[#FF8F6B]"
                          : "text-neutral-300 hover:bg-neutral-800"
                      }`}
                    >
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {active && <Check size={13} weight="bold" />}
                      </span>
                      {formatRate(r)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* RIGHT -- undo/redo, loop, in/out marks + region chip, shortcuts */}
      <div className="flex shrink-0 items-center gap-1.5">
        <GhostButton
          onClick={undo}
          disabled={!canUndo}
          title={`Undo (${MOD_LABEL}+Z)`}
          aria-label="Undo"
        >
          <ArrowUUpLeft size={17} weight="bold" />
        </GhostButton>
        <GhostButton
          onClick={redo}
          disabled={!canRedo}
          title={`Redo (${MOD_LABEL}+Shift+Z)`}
          aria-label="Redo"
        >
          <ArrowUUpRight size={17} weight="bold" />
        </GhostButton>

        <div className="mx-0.5 h-5 w-px bg-neutral-800" />

        <GhostButton
          onClick={() => splitClipAtPlayhead()}
          disabled={disabled}
          title="Split clip at playhead (S or /)"
          aria-label="Split clip at playhead"
        >
          <Scissors size={16} weight="bold" />
        </GhostButton>

        <GhostButton
          onClick={() => addMarker()}
          disabled={disabled}
          title="Add marker at playhead (M)"
          aria-label="Add marker at playhead"
        >
          <BookmarkSimple size={16} weight="bold" />
        </GhostButton>

        <GhostButton
          onClick={resetAllFraming}
          disabled={!hasMotion}
          title="Reset all scene framing (screen + face pan/zoom, split)"
          aria-label="Reset all scene framing"
        >
          <Broom size={16} weight="bold" />
        </GhostButton>

        <GhostButton
          onClick={toggleSyncFaceCam}
          disabled={disabled}
          active={syncFaceCam}
          title={
            syncFaceCam
              ? "Face cam synced across all clips (click to reframe per-scene)"
              : "Face cam reframes per-scene only (click to sync across all clips)"
          }
          aria-label="Toggle face cam sync across all clips"
          aria-pressed={syncFaceCam}
        >
          {syncFaceCam ? (
            <LockSimple size={16} weight="bold" />
          ) : (
            <LockSimpleOpen size={16} weight="regular" />
          )}
        </GhostButton>

        {/* Global default transition: restyle EVERY real cut at once. Disabled
            when the reel has no cut to style (a single continuous clip). Shows
            "Mixed" when cuts diverge; picking a value normalizes them all. */}
        <select
          value={defaultTransitionType}
          disabled={disabled || realCutCount === 0}
          onChange={(e) => {
            const v = e.target.value as ClipTransition["type"] | "mixed";
            if (v === "mixed") return; // placeholder, not a real choice
            setDefaultTransition(v === "none" ? null : { ...GLOBAL_TRANSITION_PRESET[v] });
          }}
          title="Transition on EVERY cut (restyles all cuts at once)"
          aria-label="Default transition for every cut"
          className="h-8 rounded-md border border-neutral-700 bg-neutral-800 px-1.5 text-xs text-neutral-200 outline-none focus:border-[#FF6B35] disabled:opacity-40"
        >
          {defaultTransitionType === "mixed" && (
            <option value="mixed">Mixed cuts</option>
          )}
          <option value="none">Hard cut</option>
          <option value="zoom-settle">Zoom settle</option>
          <option value="slide">Slide</option>
        </select>

        <div className="mx-0.5 h-5 w-px bg-neutral-800" />

        <GhostButton
          onClick={toggleLoop}
          disabled={disabled}
          active={loopPlayback}
          title="Toggle loop (L)"
          aria-label="Toggle loop"
          aria-pressed={loopPlayback}
        >
          <Repeat size={16} weight={loopPlayback ? "bold" : "regular"} />
        </GhostButton>

        <div className="mx-0.5 h-5 w-px bg-neutral-800" />

        <GhostButton
          onClick={setInHere}
          disabled={disabled}
          title="Set in point at playhead (I)"
          aria-label="Set in point"
        >
          <span className="px-0.5 font-mono text-[13px] font-semibold">[</span>
        </GhostButton>
        <GhostButton
          onClick={setOutHere}
          disabled={disabled}
          title="Set out point at playhead (O)"
          aria-label="Set out point"
        >
          <span className="px-0.5 font-mono text-[13px] font-semibold">]</span>
        </GhostButton>

        {/* region readout chip -- only when a mark is set */}
        {hasRegion && (
          <div className="flex items-center gap-1 rounded-md border border-[#FF6B35]/40 bg-[#FF6B35]/10 py-0.5 pl-2 pr-1 text-[11px] tabular-nums text-[#FF8F6B]">
            <BracketsSquare size={12} weight="bold" className="shrink-0" />
            <span>
              {formatShort(inPoint ?? 0)} - {formatShort(outPoint ?? duration)}
            </span>
            <button
              type="button"
              onClick={clearInOut}
              title="Clear in/out region"
              aria-label="Clear in/out region"
              className="grid h-4 w-4 place-items-center rounded text-[#FF8F6B]/80 transition-colors hover:bg-[#FF6B35]/20 hover:text-[#FF8F6B]"
            >
              <X size={11} weight="bold" />
            </button>
          </div>
        )}

        <div className="mx-0.5 h-5 w-px bg-neutral-800" />

        {/* keyboard shortcuts popover */}
        <div className="relative">
          <button
            ref={shortcutsBtnRef}
            type="button"
            onClick={toggleShortcutsMenu}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            aria-expanded={showShortcuts}
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors ${
              showShortcuts
                ? "text-[#FF6B35] hover:bg-[#FF6B35]/10"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            }`}
          >
            <Keyboard size={17} weight="regular" />
          </button>
          {showShortcuts && shortcutsRect && (
            <>
              {/* click-away backdrop */}
              <div
                className="fixed inset-0 z-[60]"
                onClick={() => setShowShortcuts(false)}
              />
              {/* Fixed-positioned so it escapes the timeline's overflow-hidden
                  box. Right edge aligned to the trigger, 8px above it. */}
              <div
                style={{
                  position: "fixed",
                  right: window.innerWidth - shortcutsRect.right,
                  bottom: window.innerHeight - shortcutsRect.top + 8,
                }}
                className="z-[70] w-60 rounded-lg border border-neutral-700 bg-neutral-900 p-3 shadow-2xl">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  <Keyboard size={13} weight="bold" />
                  Shortcuts
                </div>
                <ul className="flex flex-col gap-1.5">
                  {SHORTCUTS.map((sc) => (
                    <li
                      key={sc.keys}
                      className="flex items-center justify-between gap-3 text-[11px]"
                    >
                      <span className="text-neutral-400">{sc.action}</span>
                      <kbd className="shrink-0 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-200">
                        {sc.keys}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Ghost-style icon button matching the timeline toolbar idiom: muted by
 * default, brightens + gets a subtle fill on hover, coral when `active`, and
 * dims to 40% when disabled. Kept local so the transport strip owns its look.
 */
function GhostButton({
  onClick,
  disabled,
  active,
  title,
  children,
  ...rest
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`grid h-8 w-8 place-items-center rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
        active
          ? "text-[#FF6B35] hover:bg-[#FF6B35]/10"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}
