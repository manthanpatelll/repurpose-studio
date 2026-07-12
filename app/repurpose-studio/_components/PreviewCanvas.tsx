"use client";

// ===========================================================================
// REPURPOSE STUDIO -- PreviewCanvas
// ===========================================================================
// The live 1080x1920 vertical compositor preview. Owns:
//   - SLOT_COUNT hidden <video> elements per source: an ACTIVE screen+face
//     pair (frame-locked, seeked to the same source time) that the compositor
//     paints, plus STANDBY pairs pre-seeked to the next discontinuous cuts'
//     source in-points so a real cut is an element SWAP, not a live seek --
//     and a rapid double-cut is TWO warm swaps (see preview-preseek).
//   - A DPR-correct <canvas> that calls the pure `drawFrame` (lib/repurpose/
//     compositor.ts) every rAF / store change to composite screen (top) +
//     face (bottom) per the current splitRatio and pan/zoom keyframes.
//   - A draggable split-handle overlay (drag to change splitRatio, clamped
//     0.4-0.6 by the store's setSplitRatio).
//   - Per-region drag-to-pan and scroll-to-zoom, which write a new pan/zoom
//     keyframe at the current playhead for that track.
//
// No footage yet -> `drawFrame` draws labeled "SCREEN"/"FACE" placeholder
// rectangles so the split-screen layout is visible standalone (see
// PreviewPanelPlaceholder in ../page.tsx, which this component replaces).
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setupCrispCanvas } from "@/lib/engine/crisp-canvas";
import {
  drawFrame,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  type RegionSource,
  type OverlayDraw,
} from "@/lib/repurpose/compositor";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  timelineToSourceTime,
  transitionProgressAt,
  splitRatioAt,
  screenFramingAt,
  faceFramingAt,
  punchScaleAt,
} from "@/lib/repurpose/time-map";
import { gradeFilter } from "@/lib/repurpose/color-grade";
import { drawCaptions } from "@/lib/repurpose/captions";
import { loadCaptionFonts } from "@/lib/repurpose/caption-fonts";
import type { Clip } from "@/lib/repurpose/types";
import {
  CONTIGUOUS_CUT_EPSILON,
  nextDiscontinuousCutsAfter,
  StandbySeeker,
} from "@/lib/repurpose/preview-preseek";
import type { PreviewRect } from "@/lib/repurpose/overlay-geometry";
import { clampOverlayToTopHalf } from "@/lib/repurpose/overlay-geometry";
import { GhostOverflowLayer } from "./GhostOverflowLayer";
import { SnapGuides } from "./SnapGuides";
import { useObjectSelection } from "./useObjectSelection";
import { useDeselectOnOutsideClick } from "./useDeselectOnOutsideClick";
import { useSfxPreview, useMusicPreview } from "./useSfxPreview";
import { useFacecamProxy } from "./useFacecamProxy";
import { SelectionOverlay } from "./SelectionOverlay";
import { SelectionToolbar } from "./SelectionToolbar";

// Output <-> source time mapping lives in lib/repurpose/time-map.ts so the
// preview, the exporter, and the store's keyframe-ripple remap all share ONE
// implementation. `timelineToSourceTime` there uses a half-open
// [timelineStart, timelineEnd) boundary, so a frame landing exactly on a cut
// belongs to the incoming clip (no one-frame flash of the outgoing tail).

/** Output resolution the canvas is backed by (export-matching). Overridable for tests/storybook. */
export interface PreviewCanvasProps {
  /** Output width in px. Default 1080. */
  width?: number;
  /** Output height in px. Default 1920. */
  height?: number;
  /** Extra className applied to the outer wrapper (sizing/positioning is the caller's job). */
  className?: string;
}

const MIN_SPLIT = 0.4;
const MAX_SPLIT = 0.6;
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;

// Size of the double-buffer video pool PER SOURCE: 1 active pair +
// (SLOT_COUNT - 1) standby pairs. Depth 2 means the NEXT cut *and* the cut
// AFTER it are both pre-seeked, so a rapid double-cut (<1s apart) is two warm
// swaps -- with a single standby the freed pair never re-seeked in time and
// the second cut fell back to the ~1s hard-seek freeze. Bump this if
// machine-gun triple-cuts ever hiccup; each +1 costs two more hidden <video>s.
const SLOT_COUNT = 3;
const STANDBY_DEPTH = SLOT_COUNT - 1;
const SLOT_INDICES = Array.from({ length: SLOT_COUNT }, (_, i) => i);

// During playback the FACE video is the master clock: within one contiguous
// clip we DERIVE the playhead from faceVideo.currentTime rather than advancing
// it by wall time and re-seeking the video to match. That was the old glitch --
// two independent clocks (the store playhead vs. the video's own currentTime)
// disagreed every frame, so a >tolerance drift check hard-seeked the face video
// back constantly, stuttering it. Now we only hard-seek at a CLIP CUT (a real
// source discontinuity); mid-clip the video decodes smoothly and the playhead
// follows it, so there is nothing to stutter.
//
// A tiny guard band: treat the video as "still inside this clip" until its
// currentTime reaches within this many seconds of the clip's srcEnd, then hand
// off to the next clip. One frame at 30fps.
const CLIP_CUT_EPSILON = 1 / 30;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The kept clip whose output span [timelineStart, timelineEnd) contains t, or null. */
function activeClipAt(clips: readonly Clip[], t: number): Clip | null {
  let lastKept: Clip | null = null;
  for (const clip of clips) {
    if (!clip.kept) continue;
    lastKept = clip;
    if (t >= clip.timelineStart && t < clip.timelineEnd) return clip;
  }
  // At/just past the very end, the last kept clip is still the active one.
  if (lastKept && t >= lastKept.timelineEnd) return lastKept;
  return null;
}

/** The next kept clip AFTER `clip` in array order, or null if it's the last. */
function nextKeptClipAfter(clips: readonly Clip[], clip: Clip): Clip | null {
  const idx = clips.indexOf(clip);
  if (idx < 0) return null;
  for (let i = idx + 1; i < clips.length; i++) {
    if (clips[i].kept) return clips[i];
  }
  return null;
}

// A cut is "contiguous" when the next kept clip resumes the SAME source file at
// (essentially) the same source time the current clip ends -- i.e. no retake was
// trimmed out between them and nothing was reordered. In that case the source
// videos are ALREADY decoding the exact frames the next clip wants, so the
// hard-seek at the cut is pure waste: on a streaming range-request source it
// stalls playback for ~1s (seek -> rebuffer -> resume) while the last frame
// freezes on screen. Skipping the seek here is what makes scene changes instant.
// CONTIGUOUS_CUT_EPSILON (one frame of slack for float error in back-to-back
// srcEnd/srcStart) now lives in lib/repurpose/preview-preseek.ts -- the single
// source of truth shared with nextDiscontinuousCutsAfter, which uses the SAME
// test to decide which upcoming cuts the standby pool should pre-seek to.

/** Drag/zoom interaction state for one region (screen or face). */
interface RegionDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startTransform: { x: number; y: number; scale: number };
}

/**
 * Live 1080x1920 split-screen compositor preview. Renders the current frame
 * via the pure `drawFrame` module, and exposes drag-to-pan / scroll-to-zoom /
 * drag-the-split-handle interactions that write back to `useRepurposeStore`.
 */
export function PreviewCanvas({
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  className,
}: PreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The consolidated interaction-layer div -- held so the wheel-zoom handler can
  // be attached as a NON-PASSIVE native listener (React's onWheel is passive).
  const interactionLayerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // DOUBLE-BUFFERED base videos: SLOT_COUNT
  // hidden <video> slots per source file, ordered by slotOrderRef -- a ring
  // where order[0] is the ACTIVE pair (the compositor paints it and the face
  // element of that pair is the master clock + the audio) and order[1..] are
  // the STANDBY pairs: paused, pre-seeked (by the StandbySeekers below) to the
  // next STANDBY_DEPTH discontinuous cuts' source in-points. Crossing a cut
  // ROTATES the ring (order[1] promotes to active, the freed active goes to
  // the back and re-targets the farthest tracked cut) instead of hard-seeking
  // the big raw file over the byte-range stream (~1s freeze). Ref callbacks in
  // the JSX write the slots; slotOrderRef is a ref (not state) because a swap
  // happens inside the rAF loop and must not trigger a React render.
  const screenElsRef = useRef<(HTMLVideoElement | null)[]>(
    Array(SLOT_COUNT).fill(null)
  );
  const faceElsRef = useRef<(HTMLVideoElement | null)[]>(
    Array(SLOT_COUNT).fill(null)
  );
  const slotOrderRef = useRef<number[]>([...SLOT_INDICES]);
  // Monotonic swap counter: the async autoplay-rejection revert in the rAF
  // loop must only undo the swap it belongs to. If a rapid double-cut (or a
  // user pause) lands between a swap and its play-promise rejection, the
  // generation won't match and the stale revert becomes a no-op instead of
  // rotating slotOrderRef against the wrong baseline.
  const swapGenRef = useRef(0);
  const activeScreen = useCallback(
    () => screenElsRef.current[slotOrderRef.current[0]],
    []
  );
  const activeFace = useCallback(
    () => faceElsRef.current[slotOrderRef.current[0]],
    []
  );
  // Serialized pre-seek managers, one per STANDBY ring position (k = 0 parks
  // at the next cut, k = 1 at the cut after, ...). getEl() is resolved fresh
  // on every call because WHICH element sits at each position rotates at every
  // swap; StandbySeeker rebinds itself when the resolved element changes.
  const faceSeekersRef = useRef<StandbySeeker[] | null>(null);
  const screenSeekersRef = useRef<StandbySeeker[] | null>(null);
  if (!faceSeekersRef.current) {
    faceSeekersRef.current = Array.from(
      { length: STANDBY_DEPTH },
      (_, k) =>
        new StandbySeeker(() => faceElsRef.current[slotOrderRef.current[k + 1]])
    );
  }
  if (!screenSeekersRef.current) {
    screenSeekersRef.current = Array.from(
      { length: STANDBY_DEPTH },
      (_, k) =>
        new StandbySeeker(
          () => screenElsRef.current[slotOrderRef.current[k + 1]]
        )
    );
  }
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  // rAF timestamp of the previous playing frame; null forces the next frame to
  // seed it (so the first frame after pressing play never takes a giant jump).
  const lastTimestampRef = useRef<number | null>(null);
  // The playhead value the rAF clock itself last wrote. While playing,
  // the face video is the master clock: it DERIVES the playhead every frame,
  // which silently overwrote any playhead someone ELSE set (timeline click,
  // transcript word click) one frame later -- the "clicking the timeline does
  // nothing during playback" bug. Each tick compares the store playhead to
  // this ref: a mismatch beyond one frame means a deliberate external seek,
  // which the clock must HONOR (hard-seek both videos there) instead of
  // clobbering. null = playback just (re)started, nothing to compare yet.
  const expectedPlayheadRef = useRef<number | null>(null);
  // The split ratio ACTUALLY composited this frame -- per-clip, eased across
  // cuts (splitRatioAt). The rAF loop writes it here every frame so the split
  // handle overlay + the pan/zoom region divider can sit on the real seam the
  // video is drawn at, not the raw global default. A ref (read by the DOM handle
  // position) + a throttled state mirror (to re-render the handle) so we don't
  // setState 60x/sec. Seeded to the default split (0.5) for the very first paint;
  // the loop overwrites it on frame 1 with the real per-scene value.
  const liveSplitRef = useRef<number>(0.5);
  const [handleSplit, setHandleSplit] = useState<number>(0.5);
  // Alignment grid (rule-of-thirds + center crosshair) to eyeball-center an
  // overlay. Toggled from the top bar (store-owned so the navbar button and this
  // preview share one source of truth). DOM-only -- it is a sibling above the
  // canvas, so it NEVER bakes into the exported frames.
  const showGrid = useRepurposeStore((s) => s.showGrid);

  // Whether Cmd/Ctrl is currently held, so the interaction layer shows a `copy`
  // cursor -- the affordance that a drag now CLONES the overlay (matches Figma).
  const [cloneModifier, setCloneModifier] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setCloneModifier(e.metaKey || e.ctrlKey);
    const onBlur = () => setCloneModifier(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const splitRatio = useRepurposeStore((s) => s.splitRatio);
  const setSplitRatio = useRepurposeStore((s) => s.setSplitRatio);
  const setClipSplitRatio = useRepurposeStore((s) => s.setClipSplitRatio);
  const setClipFaceFraming = useRepurposeStore((s) => s.setClipFaceFraming);
  const setClipScreenFraming = useRepurposeStore((s) => s.setClipScreenFraming);
  const playhead = useRepurposeStore((s) => s.playhead);
  const clips = useRepurposeStore((s) => s.clips);
  const footageMeta = useRepurposeStore((s) => s.footageMeta);
  const duration = useRepurposeStore((s) => s.duration);
  const isPlaying = useRepurposeStore((s) => s.isPlaying);
  const playbackRate = useRepurposeStore((s) => s.playbackRate);
  const inPoint = useRepurposeStore((s) => s.inPoint);
  const outPoint = useRepurposeStore((s) => s.outPoint);
  const loopPlayback = useRepurposeStore((s) => s.loopPlayback);
  const screenGrade = useRepurposeStore((s) => s.screenGrade);
  const faceGrade = useRepurposeStore((s) => s.faceGrade);
  const captionsEnabled = useRepurposeStore((s) => s.captionsEnabled);
  const captionStyle = useRepurposeStore((s) => s.captionStyle);
  const captionBlocks = useRepurposeStore((s) => s.captionBlocks);
  const overlays = useRepurposeStore((s) => s.overlays);
  const setPlayhead = useRepurposeStore((s) => s.setPlayhead);
  const pause = useRepurposeStore((s) => s.pause);

  // Make the generated SFX bed audible during live preview, synced to the
  // playhead and summing acoustically with the face-cam <video> audio.
  const sfxTrack = useRepurposeStore((s) => s.sfxTrack);
  useSfxPreview(sfxTrack);
  const musicTrack = useRepurposeStore((s) => s.musicTrack);
  useMusicPreview(musicTrack);

  // LOW-RES PREVIEW PROXY for the facecam raw. The hook hands back the
  // src the face <video> slots should use: the original streaming URL until a
  // one-time ffmpeg proxy is built server-side, then (on the next pause) the
  // proxy URL -- tiny file, keyframe every 0.5s, so scrubbing and cold-cut
  // fallback seeks are near-instant. EXPORT still reads footageMeta.faceCamPath
  // directly and is untouched by this swap.
  const faceProxy = useFacecamProxy(
    footageMeta?.faceCamPath,
    footageMeta?.durationSec,
    isPlaying
  );

  // Keep latest store values in refs so the rAF loop (mounted once) always
  // reads current state without re-subscribing the loop itself. The loop is
  // both the renderer AND the playback clock, so it needs the playback flags
  // (isPlaying / in-out region / loop) and the grades on top of the draw state.
  const liveRef = useRef({
    splitRatio,
    playhead,
    clips,
    duration,
    isPlaying,
    playbackRate,
    inPoint,
    outPoint,
    loopPlayback,
    screenGrade,
    faceGrade,
    captionsEnabled,
    captionStyle,
    captionBlocks,
    overlays,
  });
  useEffect(() => {
    liveRef.current = {
      splitRatio,
      playhead,
      clips,
      duration,
      isPlaying,
      playbackRate,
      inPoint,
      outPoint,
      loopPlayback,
      screenGrade,
      faceGrade,
      captionsEnabled,
      captionStyle,
      captionBlocks,
      overlays,
    };
  }, [
    splitRatio,
    playhead,
    clips,
    duration,
    isPlaying,
    playbackRate,
    inPoint,
    outPoint,
    loopPlayback,
    screenGrade,
    faceGrade,
    captionsEnabled,
    captionStyle,
    captionBlocks,
    overlays,
  ]);

  // --- Overlay media pools ----------------------------------------------------
  // Image overlays decode ONCE into an HTMLImageElement (kept in imgPoolRef,
  // keyed by overlay id). Video overlays get one hidden pooled <video> each
  // (videoPoolRef, populated by the ref callbacks on the hidden <video> pool
  // rendered in JSX below). The single rAF loop reads both pools every frame to
  // build the OverlayDraw[] it hands drawFrame, WITHOUT re-subscribing -- exactly
  // like the two base videos. A video overlay is ALWAYS muted (an overlay never
  // emits audio); the pooled <video> below sets `muted`.
  const imgPoolRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map());

  // --- Register the caption faces for canvas text (once on mount) -------------
  // Captions are drawn via ctx.fillText, so the browser must have loaded + added
  // the faces to document.fonts before the first caption draw or it silently
  // falls back to a system font. loadCaptionFonts() is idempotent (shared
  // promise), so calling it here just warms the faces for the rAF loop below.
  useEffect(() => {
    loadCaptionFonts();
  }, []);

  // --- Decode image overlays once + backfill intrinsic size -------------------
  // On first sight of an image overlay id, kick off a decode (HTMLImageElement).
  // Once loaded it lives in imgPoolRef so the rAF loop can drawImage it every
  // frame with zero per-frame decode. If the store's naturalWidth/Height is
  // still 0 (added before the media resolved), backfill it so the timeline,
  // selection box, and export all get the true aspect ratio. Videos backfill
  // their size from videoWidth/Height in the pooled <video>'s loadedmetadata.
  // Prune pool entries whose overlay was removed so the map can't leak.
  useEffect(() => {
    const pool = imgPoolRef.current;
    for (const ov of overlays) {
      if (ov.kind !== "image" || pool.has(ov.id)) continue;
      const img = new Image();
      img.decoding = "async";
      const id = ov.id;
      img.onload = () => {
        if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
        const cur = useRepurposeStore.getState().overlays.find((o) => o.id === id);
        if (cur && (cur.naturalWidth <= 0 || cur.naturalHeight <= 0)) {
          // Metadata backfill only -- not an editable mutation, so it bypasses
          // history (setState, not an action). Guarded to the one overlay.
          useRepurposeStore.setState((s) => ({
            overlays: s.overlays.map((o) =>
              o.id === id
                ? { ...o, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }
                : o
            ),
          }));
        }
      };
      img.src = ov.src;
      pool.set(id, img);
    }
    // Prune images for overlays that no longer exist.
    const liveIds = new Set(overlays.filter((o) => o.kind === "image").map((o) => o.id));
    for (const key of pool.keys()) {
      if (!liveIds.has(key)) pool.delete(key);
    }
  }, [overlays]);

  // --- Neutralize OS/browser media keys over the preview <video>s -------------
  // The studio's own transport is Space / J-K-L / arrows (see TransportBar). But
  // the preview uses real <video> elements, so macOS hardware media keys
  // (F7 prev / F8 play-pause / F9 next -- and the Touch Bar / Now-Playing
  // equivalents) get routed by the browser straight into those videos, toggling
  // playback out from under the app. Manthan doesn't use those keys for this
  // tool and they fight the rAF clock. We claim the MediaSession and register
  // NO-OP handlers for the transport actions so pressing F7/F8/F9 does nothing
  // to the preview. This is scoped to while the studio is mounted (handlers are
  // cleared on unmount) and does not touch the user's OS media keys anywhere
  // else. Guarded because mediaSession is browser-only and not in every engine.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const actions: MediaSessionAction[] = [
      "play",
      "pause",
      "stop",
      "seekbackward",
      "seekforward",
      "previoustrack",
      "nexttrack",
    ];
    const noop = () => {
      /* swallow the media key: the app's own transport owns playback */
    };
    for (const action of actions) {
      try {
        ms.setActionHandler(action, noop);
      } catch {
        // Some engines throw on unsupported actions -- ignore and continue.
      }
    }
    // Mark nothing as actively playing so the OS "Now Playing" target stays idle.
    try {
      ms.playbackState = "none";
    } catch {
      /* not settable in every engine */
    }
    return () => {
      for (const action of actions) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // --- Seek both videos to the frame-locked SOURCE time (SCRUB only) ----------
  // playhead is OUTPUT-timeline seconds; video.currentTime is RAW SOURCE
  // seconds. Map through the assembled clip list so trimmed/deleted/reordered
  // retakes never leak into the preview. Both videos share one source time
  // (screen + face are frame-locked to a single raw timebase).
  //
  // This is the PAUSED (scrub) path: it hard-seeks on any playhead change while
  // the clock is stopped, exactly as before. During playback the clock owns
  // currentTime (the videos free-run and the rAF loop resyncs on drift), so we
  // must NOT hard-seek here -- doing so would fight the running video and stutter
  // it. Gate on isPlaying so the seek only fires when NOT playing.
  useEffect(() => {
    if (isPlaying) return; // clock owns currentTime while playing
    const srcTime = timelineToSourceTime(clips, playhead);
    if (srcTime === null) return; // no kept clip here -- hold the current frame
    const screenVideo = activeScreen();
    const faceVideo = activeFace();
    if (screenVideo && Math.abs(screenVideo.currentTime - srcTime) > 1 / 60) {
      screenVideo.currentTime = srcTime;
    }
    if (faceVideo && Math.abs(faceVideo.currentTime - srcTime) > 1 / 60) {
      faceVideo.currentTime = srcTime;
    }
  }, [playhead, clips, isPlaying, activeScreen, activeFace]);

  // --- Pre-seek the STANDBY pool at the next discontinuous cuts -------------
  // Whenever the clip list or playhead moves, park standby pair k at the
  // source in-point of the (k+1)-th real (discontinuous) cut ahead of the
  // playhead. StandbySeeker serializes the seeks and no-ops when the target is
  // unchanged, so running this on every playhead tick is cheap. Fewer cuts
  // ahead than standbys -> the extra standbys keep their old park (harmless).
  // Runs paused or playing: pre-seeking while paused means the very first cuts
  // after pressing play are already warm. Keyed on footageMeta so a project
  // load re-targets once the sources exist.
  useEffect(() => {
    const cuts = nextDiscontinuousCutsAfter(clips, playhead, STANDBY_DEPTH);
    cuts.forEach((cut, k) => {
      faceSeekersRef.current?.[k]?.target(cut.seekSrc);
      screenSeekersRef.current?.[k]?.target(cut.seekSrc);
    });
  }, [clips, playhead, footageMeta]);

  // Forget in-flight seek state when the component unmounts (or the sources
  // change identity) so a stale 'seeked' listener never fires on a dead node.
  useEffect(() => {
    return () => {
      faceSeekersRef.current?.forEach((s) => s.reset());
      screenSeekersRef.current?.forEach((s) => s.reset());
    };
  }, [footageMeta]);

  // --- Re-sync the face slots after a proxy src swap -------------------------
  // Changing <video>.src resets every face element to t=0. The swap only ever
  // happens while paused, so: reset the face seekers (their in-flight state
  // died with the old src), re-seek the active slot to the frame under the
  // playhead once its metadata is in, and re-issue the standbys' pre-seek
  // targets directly (the pre-seek effect won't re-run on its own --
  // clips/playhead/footageMeta are all unchanged by a src swap).
  useEffect(() => {
    if (!faceProxy.src) return;
    faceSeekersRef.current?.forEach((s) => s.reset());
    const live = liveRef.current;
    const srcTime = timelineToSourceTime(live.clips, live.playhead);
    // Direct-seek ONLY the active slot; each standby belongs to its seeker
    // (re-targeted below), and two writers issuing currentTime on the same
    // element would interleave unpredictably.
    const v = activeFace();
    if (v && srcTime !== null) {
      const apply = () => {
        if (Math.abs(v.currentTime - srcTime) > 1 / 60) v.currentTime = srcTime;
      };
      if (v.readyState >= 1) apply();
      else v.addEventListener("loadedmetadata", apply, { once: true });
    }
    const cuts = nextDiscontinuousCutsAfter(
      live.clips,
      live.playhead,
      STANDBY_DEPTH
    );
    cuts.forEach((cut, k) => faceSeekersRef.current?.[k]?.target(cut.seekSrc));
  }, [faceProxy.src, activeFace]);

  // --- Start/stop the source <video>s in lockstep with isPlaying -------------
  // Synchronizing the real play state of two external <video> elements with the
  // store flag is a true external-system sync -> Effect (keyed on isPlaying).
  // When flipping TRUE: seed the clock (reset lastTimestamp so the first frame
  // doesn't jump), seek both videos to the current source time, then .play()
  // both. Because isPlaying only ever flips true from a user gesture (play
  // button / space), this .play() runs inside that gesture's continuation, so
  // the unmuted FACE video is allowed to start; .catch(() => {}) swallows any
  // stray rejection so a blocked promise never throws.
  // When flipping FALSE (pause / end-of-region): .pause() both videos.
  useEffect(() => {
    const screenVideo = activeScreen();
    const faceVideo = activeFace();
    if (isPlaying) {
      lastTimestampRef.current = null; // first playing frame seeds the delta
      expectedPlayheadRef.current = null; // fresh start -- no false "external seek"
      const srcTime = timelineToSourceTime(
        liveRef.current.clips,
        liveRef.current.playhead
      );
      if (srcTime !== null) {
        if (screenVideo && Math.abs(screenVideo.currentTime - srcTime) > 1 / 60) {
          screenVideo.currentTime = srcTime;
        }
        if (faceVideo && Math.abs(faceVideo.currentTime - srcTime) > 1 / 60) {
          faceVideo.currentTime = srcTime;
        }
      }
      // FACE carries the audio (see the unmuted FACE <video> below); SCREEN
      // stays muted, so only the narration plays. Both still .play() to keep
      // their frames advancing in real time. The playback-rate effect below
      // (keyed on isPlaying too) sets .playbackRate on both, so the first
      // playing frame already runs at the chosen speed.
      screenVideo?.play().catch(() => {});
      faceVideo?.play().catch(() => {});
      // Overlay videos: only the ones ACTIVE at the current playhead start; the
      // rest stay paused until the rAF loop reaches their window. Seek each to
      // its source frame first so it starts on the right picture. Always muted.
      const t0 = liveRef.current.playhead;
      for (const ov of liveRef.current.overlays) {
        if (ov.kind !== "video") continue;
        const v = videoPoolRef.current.get(ov.id);
        if (!v) continue;
        if (t0 >= ov.timelineStart && t0 < ov.timelineEnd) {
          v.currentTime = ov.srcStart + (t0 - ov.timelineStart);
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      }
    } else {
      // Pause BOTH slots -- the standby pair is normally already paused (it
      // only ever sits pre-seeked), but a swap that raced the pause could have
      // left the freed pair rolling; belt-and-braces stop everything.
      for (const v of screenElsRef.current) v?.pause();
      for (const v of faceElsRef.current) v?.pause();
      for (const v of videoPoolRef.current.values()) v.pause();
    }
  }, [isPlaying, activeScreen, activeFace]);

  // --- Apply the playback-rate multiplier to both source <video>s ------------
  // The FACE video is the master clock while playing (its currentTime derives
  // the playhead), so setting its playbackRate is what actually makes playback
  // fast/slow; the SCREEN video matches so the (silent) frames stay locked. Also
  // re-applied when isPlaying flips true, because seeding a video can reset its
  // rate. The wall-clock fallback in the rAF loop reads the same rate from the
  // live ref, so BOTH clock paths honor it.
  useEffect(() => {
    const rate = playbackRate > 0 ? playbackRate : 1;
    // BOTH slots get the rate -- the standby pair must already carry the right
    // playbackRate the instant a swap promotes it to active, or the first
    // post-cut frames would run at 1x.
    for (const v of screenElsRef.current) if (v) v.playbackRate = rate;
    for (const v of faceElsRef.current) if (v) v.playbackRate = rate;
    // Overlay videos honor J/K/L speed too so their motion stays locked to the
    // base composite (they are never the master clock -- just rate-matched).
    for (const v of videoPoolRef.current.values()) v.playbackRate = rate;
  }, [playbackRate, isPlaying]);

  // --- Canvas setup (DPR-correct backing store, resizes with container) -----
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      // The canvas is always logically `width x height` (1080x1920) and the
      // compositor draws in that coordinate space. setupCrispCanvas backs the
      // bitmap at native resolution for that logical size, but it also pins an
      // inline CSS width/height of 1080x1920px -- which would overflow this
      // small preview panel (inline styles beat the `h-full w-full` utility
      // classes). Clear those two inline dimensions afterwards so the canvas
      // bitmap scales down to fill the aspect-ratio-locked container instead.
      ctxRef.current = setupCrispCanvas(canvas, width, height);
      canvas.style.width = "";
      canvas.style.height = "";
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [width, height]);

  // --- Playback clock + render loop ------------------------------------------
  // ONE rAF loop is both the clock (advances the playhead over real wall time
  // while playing) and the compositor (draws the current frame every frame,
  // playing or not, preserving scrub-preview when paused).
  //
  // Clock: while isPlaying, each frame advances an OUTPUT-time playhead by the
  // real elapsed wall time (rAF timestamp delta / 1000 -- never assume 60fps)
  // and writes it back via setPlayhead. Region: regionStart = inPoint ?? 0,
  // regionEnd = outPoint ?? duration. Crossing regionEnd either wraps to
  // regionStart (loop) or clamps to regionEnd + pause()s and stops the videos.
  //
  // Frame-lock: while playing the videos free-run as the real-time source, so
  // each frame we compare the FACE video's currentTime to the EXPECTED source
  // time for the current playhead; if it has drifted past PLAYBACK_DRIFT_TOLERANCE
  // (e.g. crossing a clip cut, where source time jumps but wall time doesn't) we
  // re-seek BOTH videos so trimmed/deleted retakes never leak in and screen+face
  // stay locked.
  useEffect(() => {
    const tick = (timestamp: number) => {
      const live = liveRef.current;
      // Resolve the ACTIVE pair fresh every frame -- a cut swap in an earlier
      // frame changes which physical elements these are, so they can never be
      // captured once at effect mount like they used to be.
      const screenVideo = screenElsRef.current[slotOrderRef.current[0]];
      const faceVideo = faceElsRef.current[slotOrderRef.current[0]];

      // 1) CLOCK -- the FACE video is the master timebase. Within one contiguous
      // clip we DERIVE the playhead from faceVideo.currentTime (smooth, no
      // re-seeking); we only hard-seek at a clip CUT, where source time jumps.
      if (live.isPlaying) {
        const regionStart = live.inPoint ?? 0;
        const regionEnd = live.outPoint ?? live.duration;
        const last = lastTimestampRef.current;
        lastTimestampRef.current = timestamp;

        // EXTERNAL SEEK: the store playhead moved since this clock
        // last wrote it -> a timeline/transcript click mid-playback. Honor it:
        // hard-seek both videos to the clicked time so the clock re-derives
        // from there, instead of dragging the playhead back to wherever the
        // video happened to be (which read as "clicking does nothing").
        // Threshold = well past one frame of self-written drift. The proxy
        // makes this seek fast; the videoWidth render gate holds the last
        // frame during it, exactly like any cut.
        const expected = expectedPlayheadRef.current;
        if (expected !== null && Math.abs(live.playhead - expected) > 0.25) {
          const jumpSrc = timelineToSourceTime(live.clips, live.playhead);
          if (jumpSrc !== null) {
            if (faceVideo) faceVideo.currentTime = jumpSrc;
            if (screenVideo) screenVideo.currentTime = jumpSrc;
          }
          expectedPlayheadRef.current = live.playhead;
        }

        const clip = activeClipAt(live.clips, live.playhead);
        // Fall back to wall-clock advancement only when we can't read the video
        // as a clock this frame (not ready, paused mid-buffer, or no clip).
        const canUseVideoClock =
          !!clip && !!faceVideo && faceVideo.readyState >= 2 && !faceVideo.paused;

        if (last !== null) {
          let next: number;
          if (canUseVideoClock && clip) {
            const src = faceVideo.currentTime;
            if (src >= clip.srcEnd - CLIP_CUT_EPSILON) {
              // Reached this clip's out point -> CUT. Move to the next kept clip.
              next = clip.timelineEnd;
              const nextClip = nextKeptClipAfter(live.clips, clip);
              // Only hard-seek when the next clip's source in-point is
              // DISCONTINUOUS from where we are (a retake was trimmed out, or the
              // clips were reordered). When the next line simply continues the
              // same take back-to-back, the videos are already decoding the right
              // frames -- seeking would stall the stream for ~1s and freeze the
              // last frame. So we let playback roll straight through: seamless.
              const contiguous =
                !!nextClip &&
                Math.abs(nextClip.srcStart - clip.srcEnd) <= CONTIGUOUS_CUT_EPSILON;
              if (!contiguous) {
                const seekSrc = timelineToSourceTime(live.clips, next);
                if (seekSrc !== null) {
                  // DOUBLE-BUFFER SWAP: the FIRST standby
                  // pair has (usually) been sitting paused, pre-seeked to
                  // exactly this source in-point since the pre-seek effect saw
                  // this cut coming. If it's warm, promote it: rotate the slot
                  // ring, match rate, move the audio (unmute new face / mute
                  // old), play the new pair, park the old. The canvas paints
                  // the new pair NEXT frame -- no live seek, no ~1s freeze on
                  // the byte-range stream. The freed pair goes to the BACK of
                  // the ring; the standby that was parked at the FOLLOWING cut
                  // moves up to first, so a rapid double-cut swaps warm again
                  // immediately.
                  const order = slotOrderRef.current;
                  const standbyFace = faceElsRef.current[order[1]];
                  const standbyScreen = screenElsRef.current[order[1]];
                  const swapReady =
                    !!standbyFace &&
                    !!standbyScreen &&
                    !!faceVideo &&
                    !!screenVideo &&
                    !!faceSeekersRef.current?.[0]?.readyAt(seekSrc) &&
                    !!screenSeekersRef.current?.[0]?.readyAt(seekSrc);
                  if (swapReady) {
                    const rate = live.playbackRate > 0 ? live.playbackRate : 1;
                    const prevOrder = [...order];
                    const gen = ++swapGenRef.current;
                    slotOrderRef.current = [...order.slice(1), order[0]];
                    standbyFace.playbackRate = rate;
                    standbyScreen.playbackRate = rate;
                    standbyFace.muted = false; // narration moves to the new face
                    const playPromise = standbyFace.play();
                    standbyScreen.play().catch(() => {});
                    faceVideo.muted = true;
                    faceVideo.pause();
                    screenVideo.pause();
                    // Re-target every standby seeker RIGHT NOW at the cuts
                    // ahead of this boundary -- the React pre-seek effect will
                    // also fire, but only after this tick's setPlayhead
                    // renders, and a rapid double-cut can arrive sooner. Each
                    // seeker rebinds to the element now sitting at its ring
                    // position; the one already parked at the right in-point
                    // no-ops, the freed pair starts seeking to the farthest
                    // tracked cut immediately.
                    const upcoming = nextDiscontinuousCutsAfter(
                      live.clips,
                      next,
                      STANDBY_DEPTH
                    );
                    upcoming.forEach((c, k) => {
                      faceSeekersRef.current?.[k]?.target(c.seekSrc);
                      screenSeekersRef.current?.[k]?.target(c.seekSrc);
                    });
                    playPromise?.catch(() => {
                      // Autoplay refused (shouldn't happen mid-session after a
                      // real play gesture, but never leave a silent frozen
                      // preview): revert THIS swap and fall back to the old
                      // hard-seek of the original pair. The revert fires
                      // async, so it is generation-guarded -- if a newer swap
                      // (rapid double-cut) already rotated the ring, undoing
                      // it here would corrupt the active/standby roles + mute
                      // state; the stale revert must be a no-op instead.
                      if (swapGenRef.current !== gen) return;
                      slotOrderRef.current = prevOrder;
                      // Drop every seeker's in-flight state -- their bindings
                      // were re-targeted for the rotated ring above and would
                      // fight the restored one; the pre-seek effect re-parks
                      // them cleanly on its next run.
                      faceSeekersRef.current?.forEach((s) => s.reset());
                      screenSeekersRef.current?.forEach((s) => s.reset());
                      standbyFace.muted = true;
                      standbyFace.pause();
                      standbyScreen.pause();
                      faceVideo.muted = false;
                      faceVideo.currentTime = seekSrc;
                      screenVideo.currentTime = seekSrc;
                      // Only resume if the user is still in playback -- a
                      // pause that landed between swap and rejection wins.
                      if (liveRef.current.isPlaying) {
                        faceVideo.play().catch(() => {});
                        screenVideo.play().catch(() => {});
                      }
                    });
                  } else {
                    // Standby not warm (project just loaded, a rapid
                    // double-cut, or a clip shorter than the seek took): fall
                    // back to hard-seeking the active pair -- exactly the old
                    // behavior, never worse than before.
                    if (faceVideo) faceVideo.currentTime = seekSrc;
                    if (screenVideo) screenVideo.currentTime = seekSrc;
                  }
                }
              }
            } else {
              // Mid-clip: playhead follows the smoothly-decoding video exactly.
              next = clip.timelineStart + (src - clip.srcStart);
              // Keep the (silent) screen video locked to the face timebase only
              // if it has drifted noticeably -- a rare correction, not per-frame.
              if (screenVideo && Math.abs(screenVideo.currentTime - src) > 0.15) {
                screenVideo.currentTime = src;
              }
            }
          } else {
            // No usable video clock -> advance by real elapsed wall time, scaled
            // by the playback rate (the video-clock path gets this for free via
            // the videos' own playbackRate, so only the fallback multiplies here).
            const rate = live.playbackRate > 0 ? live.playbackRate : 1;
            next = live.playhead + ((timestamp - last) / 1000) * rate;
          }

          if (next >= regionEnd) {
            if (live.loopPlayback) {
              setPlayhead(regionStart);
              expectedPlayheadRef.current = regionStart;
              const wrapSrc = timelineToSourceTime(live.clips, regionStart);
              if (wrapSrc !== null) {
                if (screenVideo) screenVideo.currentTime = wrapSrc;
                if (faceVideo) faceVideo.currentTime = wrapSrc;
              }
            } else {
              setPlayhead(regionEnd);
              expectedPlayheadRef.current = regionEnd;
              pause();
              // Pause EVERY base slot, not the pair captured at the top of
              // this tick: if a cut swap happened earlier in this same tick,
              // screenVideo/faceVideo are the just-retired pair and the
              // freshly promoted (unmuted, playing) pair would sail on for a
              // frame until the isPlaying effect catches it. Sweeping both
              // slots closes that gap; pausing an already-paused standby is a
              // no-op.
              for (const v of screenElsRef.current) v?.pause();
              for (const v of faceElsRef.current) v?.pause();
              lastTimestampRef.current = null;
            }
          } else {
            setPlayhead(next);
            expectedPlayheadRef.current = next;
          }
        }
      }

      // 3) RENDER -- composite the current frame (playing or paused). Read the
      // freshest playhead from the ref (setPlayhead above updates it next frame,
      // but we want this frame drawn at whatever the store currently holds).
      const ctx = ctxRef.current;
      if (ctx) {
        const {
          splitRatio: globalSplit,
          playhead: t,
          clips: liveClips,
          screenGrade: sg,
          faceGrade: fg,
          captionsEnabled: capsOn,
          captionStyle: capStyle,
          captionBlocks: capBlocks,
          overlays: liveOverlays,
          isPlaying: playing,
        } = liveRef.current;

        // PER-SCENE split, eased across cuts (splitRatioAt). This is the split
        // actually composited this frame -- a scene Manthan tucked the face up on
        // keeps its own value, and the seam glides at the cut into it. Publish it
        // so the DOM handle overlay + region dividers sit on the real seam; mirror
        // to state only when it changes enough to matter (avoid a 60fps setState).
        const liveSplit = splitRatioAt(liveClips, t, globalSplit);
        if (Math.abs(liveSplit - liveSplitRef.current) > 1e-4) {
          liveSplitRef.current = liveSplit;
          setHandleSplit(liveSplit);
        }

        // SCREEN: one static per-scene pan/zoom (clip.screenFraming), eased
        // across cuts by the Smart transition -- resolved inside screenFramingAt,
        // shared verbatim with the export. A scene with no framing of its own
        // frames as shot (identity). Then FOLD IN the mid-clip zoom punch-in
        // (clip.screenPunch): a transient scale multiplier (1 outside the
        // envelope, so a no-op) applied on top of the base framing scale. Same
        // punchScaleAt the export calls with the same output time -> frame-identical.
        const screenBase = screenFramingAt(liveClips, t);
        const screenPunch = punchScaleAt(liveClips, t, "screen");
        const screenTransform =
          screenPunch === 1
            ? screenBase
            : { ...screenBase, scale: screenBase.scale * screenPunch };
        // FACE: one static per-scene framing (clip.faceFraming), eased across
        // cuts the same way -- resolved inside faceFramingAt, shared with export.
        // Fold in the face punch envelope identically.
        const faceBase = faceFramingAt(liveClips, t);
        const facePunch = punchScaleAt(liveClips, t, "face");
        const faceTransform =
          facePunch === 1
            ? faceBase
            : { ...faceBase, scale: faceBase.scale * facePunch };

        // Per-cut Smart transition (Descript-style zoom-settle motion, NOT a
        // fade). transitionProgressAt is a PURE function of the current playhead
        // shared with the export frame-walk, so preview and export render the
        // SAME motion frame-for-frame. It returns non-null only while inside an
        // incoming clip's transition window; null the rest of the time, in which
        // case we pass no `transition` and drawFrame behaves exactly as before.
        // This fires whether playing OR paused-and-scrubbing, which is correct --
        // scrubbing into a transition window should preview that motion frame.
        const tp = transitionProgressAt(liveClips, t);

        // Draw the video whenever it HAS a frame to give -- gate on
        // videoWidth > 0, NOT readyState >= 2. A <video> keeps its last decoded
        // frame available to drawImage across a seek (readyState briefly drops
        // to 1 mid-seek), so the old gate blanked to the "SCREEN"/"FACE"
        // placeholder for the 1-2s a cut's seek took -- the black flash at every
        // scene change. With videoWidth as the gate the previous frame holds on
        // screen until the next one decodes, then swaps: a clean cut, no black.
        const screenReady = !!screenVideo && screenVideo.videoWidth > 0;
        const faceReady = !!faceVideo && faceVideo.videoWidth > 0;
        const screenRegion: RegionSource = {
          source: screenReady ? screenVideo : null,
          sourceWidth: screenVideo?.videoWidth ?? 0,
          sourceHeight: screenVideo?.videoHeight ?? 0,
          transform: screenTransform,
          placeholderLabel: "SCREEN",
          filter: gradeFilter(sg),
        };
        const faceRegion: RegionSource = {
          source: faceReady ? faceVideo : null,
          sourceWidth: faceVideo?.videoWidth ?? 0,
          sourceHeight: faceVideo?.videoHeight ?? 0,
          transform: faceTransform,
          placeholderLabel: "FACE",
          filter: gradeFilter(fg),
        };

        // FREE-FLOATING OVERLAYS -- resolve every overlay active at this playhead
        // into an OverlayDraw the compositor draws on top of the base composite,
        // bottom-to-top by zIndex. Built from the SAME overlays array + window
        // filter + z-sort the export uses, so preview == export for overlays.
        //
        // Video overlays: the FACE video stays the master clock -- an overlay is
        // NEVER the clock. While SCRUBBING (paused) we hard-seek each active
        // overlay video to its source frame `want`. While PLAYING the pooled
        // <video> free-runs at playbackRate and we only issue a LIGHT drift
        // resync when it strays > 0.25s (a rare correction, not per-frame), and
        // .play()/.pause() it as it enters/leaves its window. Sources gate on a
        // decoded frame (naturalWidth / videoWidth > 0) so an overlay never draws
        // a black rectangle before its media is ready.
        const active = liveOverlays
          .filter((o) => t >= o.timelineStart && t < o.timelineEnd)
          .sort((a, b) => a.zIndex - b.zIndex);
        const overlayDraws: OverlayDraw[] = [];
        for (const o of active) {
          if (o.kind === "image") {
            const img = imgPoolRef.current.get(o.id) ?? null;
            const ready = !!img && img.naturalWidth > 0 && img.naturalHeight > 0;
            if (!ready) continue; // no black first frame -- skip until decoded
            overlayDraws.push({
              source: img,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              transform: { ...o.transform, opacity: o.opacity },
              band: o.band,
            });
          } else {
            const v = videoPoolRef.current.get(o.id) ?? null;
            if (!v || v.videoWidth <= 0) continue; // gate on a decoded frame
            const want = o.srcStart + (t - o.timelineStart);
            if (playing) {
              // Light drift correction only -- the overlay is not the clock.
              if (v.paused) v.play().catch(() => {});
              if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
            } else {
              // Scrub: hard-seek to the exact source frame for this output time.
              if (Math.abs(v.currentTime - want) > 1 / 30) v.currentTime = want;
            }
            overlayDraws.push({
              source: v,
              naturalWidth: v.videoWidth,
              naturalHeight: v.videoHeight,
              transform: { ...o.transform, opacity: o.opacity },
              band: o.band,
            });
          }
        }
        // Pause overlay videos that fell OUT of their window this frame so an
        // idle B-roll clip isn't left decoding in the background during playback.
        if (playing) {
          const activeVideoIds = new Set(
            active.filter((o) => o.kind === "video").map((o) => o.id)
          );
          for (const [id, v] of videoPoolRef.current) {
            if (!activeVideoIds.has(id) && !v.paused) v.pause();
          }
        }

        drawFrame(ctx, {
          screen: screenRegion,
          face: faceRegion,
          splitRatio: liveSplit,
          width,
          height,
          // Overlays drawn on top of the base composite; an empty array is a
          // strict no-op. Sorted ascending by zIndex so index 0 is bottom-most.
          // Overlays are the LAST thing drawFrame paints; captions then draw
          // AFTER this drawFrame call (below), so text always stays above every
          // overlay. Do not move the drawCaptions call before this one.
          overlays: overlayDraws,
          // Only feed a transition while one is actually playing at this
          // playhead; when tp is null, omit it so drawFrame renders a hard cut
          // exactly as it did before this field existed (strictly additive).
          ...(tp
            ? {
                transition: {
                  type: tp.transition.type,
                  progress: tp.progress,
                  amount: tp.transition.amount,
                  direction: tp.transition.direction,
                  easing: tp.transition.easing,
                },
              }
            : {}),
        });

        // CAPTIONS ARE THE TOP LAYER -- they always draw AFTER overlays; nothing
        // composites above them. INVARIANT (do not reorder): this drawCaptions
        // call MUST stay the last draw of the pass, strictly after the drawFrame
        // above (which paints the base regions, the divider, and every overlay).
        // Overlays are the last thing drawFrame paints, so keeping captions here
        // guarantees text sits above the split video AND every media overlay. The
        // export mirrors this exact order (see export-short.ts drawOneFrame), so
        // preview == export. (The split handle is a DOM overlay, so in the preview
        // it visually sits above canvas captions -- expected; in the export there
        // is no DOM and captions are truly on top of everything.) Word timings are
        // SOURCE seconds, so map the current playhead t -> source time first.
        if (capsOn) {
          const srcT = timelineToSourceTime(liveClips, t);
          drawCaptions(ctx, {
            style: capStyle,
            blocks: capBlocks,
            srcT,
            width,
            height,
            // Pin captions to the split seam so dragging the split (face-cam up/
            // down) carries the captions with it -- see CaptionStyle.pinToSplit.
            splitRatio: liveSplit,
          });
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [width, height, setPlayhead, pause]);

  // ---------------------------------------------------------------------
  // Split-handle drag: pointer on the divider adjusts the split for the SCENE
  // under the playhead (per-clip), not the whole reel. Whichever kept clip owns
  // the current playhead gets its own splitRatio; the cut into it eases from the
  // previous scene's split. Falls back to the global default only when the
  // playhead is over no kept clip (empty timeline / a collapsed region), so the
  // handle is never dead. Reads the active clip fresh from the store each move
  // (liveRef holds the current playhead + clips) so a clip edit mid-session is
  // always respected.
  // ---------------------------------------------------------------------
  const handleDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      if (!container) return;
      const pointerId = e.pointerId;
      const target = e.currentTarget;
      target.setPointerCapture(pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        const localY = moveEvent.clientY - rect.top;
        const ratio = clamp(localY / rect.height, MIN_SPLIT, MAX_SPLIT);
        // Target the clip under the playhead so only THIS scene's split changes.
        const { clips: liveClips, playhead: t } = liveRef.current;
        const active = activeClipAt(liveClips, t);
        if (active) setClipSplitRatio(active.id, ratio);
        else setSplitRatio(ratio); // no scene here -> nudge the global default
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setSplitRatio, setClipSplitRatio]
  );

  // ---------------------------------------------------------------------
  // Per-region drag-to-pan + scroll-to-zoom. Both regions write ONE static
  // framing onto the ACTIVE scene (the clip under the playhead) -- no keyframes.
  //   SCREEN: clip.screenFraming for this scene.
  //   FACE:   clip.faceFraming for this scene.
  // The scene holds that framing; the cut into the next scene eases to ITS
  // framing via the Smart transition (screenFramingAt / faceFramingAt).
  // ---------------------------------------------------------------------
  const dragStateRef = useRef<Record<"screen" | "face", RegionDragState | null>>({
    screen: null,
    face: null,
  });

  const currentTransformFor = useCallback(
    (track: "screen" | "face") => {
      // The framing actually composited at the playhead for this region (the
      // active scene's own static framing, transition-eased across the cut) --
      // so a drag STARTS from exactly what's on screen. A scene with no framing
      // of its own reads identity, not a previous scene's held-forward value.
      return track === "face"
        ? faceFramingAt(liveRef.current.clips, liveRef.current.playhead)
        : screenFramingAt(liveRef.current.clips, liveRef.current.playhead);
    },
    []
  );

  const writeTransform = useCallback(
    (track: "screen" | "face", patch: { x: number; y: number; scale: number }) => {
      const clamped = {
        x: clamp(patch.x, -1, 1),
        y: clamp(patch.y, -1, 1),
        scale: clamp(patch.scale, ZOOM_MIN, ZOOM_MAX),
      };
      // Both regions write ONE static framing onto the ACTIVE scene (the clip
      // under the playhead). No keyframes: the scene holds this framing, and the
      // cut into the next scene eases to ITS framing via the Smart transition.
      const active = activeClipAt(liveRef.current.clips, liveRef.current.playhead);
      if (!active) return;
      if (track === "face") setClipFaceFraming(active.id, clamped);
      else setClipScreenFraming(active.id, clamped);
    },
    [setClipFaceFraming, setClipScreenFraming]
  );

  // Core of a base-region reframe drag, decoupled from the DOM element it was
  // dispatched from. The consolidated preview pointer-down router (below) calls
  // this when a pointer-down MISSED every overlay and fell into a base band, so
  // face/screen still pan/zoom by drag exactly as before -- but through the ONE
  // interaction layer that also owns overlay selection (no fighting layers). The
  // region's pixel size is passed in explicitly (the router derives it from the
  // container rect + composited split) since there is no longer a per-region div
  // to measure from `e.currentTarget`.
  const beginRegionReframe = useCallback(
    (
      track: "screen" | "face",
      e: React.PointerEvent,
      regionWidthPx: number,
      regionHeightPx: number
    ) => {
      const pointerId = e.pointerId;
      const startTransform = currentTransformFor(track);
      dragStateRef.current[track] = {
        pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTransform,
      };

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragStateRef.current[track];
        if (!drag) return;
        const dxPx = moveEvent.clientX - drag.startClientX;
        const dyPx = moveEvent.clientY - drag.startClientY;
        // Normalize screen-pixel drag delta to the [-1, 1] pan range. Dividing
        // by half the region size means dragging fully across the region pans
        // the full available range at scale 1; feels proportional at higher
        // zoom too since the underlying crop range shrinks with it.
        const dx = (dxPx / (regionWidthPx / 2)) * -1; // drag right -> pan left (content follows pointer)
        const dy = (dyPx / (regionHeightPx / 2)) * -1;
        writeTransform(track, {
          x: drag.startTransform.x + dx,
          y: drag.startTransform.y + dy,
          scale: drag.startTransform.scale,
        });
      };
      const onUp = () => {
        dragStateRef.current[track] = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [currentTransformFor, writeTransform]
  );

  // Scroll-to-zoom on the ONE consolidated interaction layer. Which base region
  // zooms is decided by the cursor's Y against the composited split seam (the
  // same seam the pan bands used to be split at), so screen (top) and face
  // (bottom) still zoom independently under the wheel.
  //
  // Attached NATIVELY with { passive: false } (see the effect below), NOT via
  // React's onWheel prop: React 17+ registers its delegated root 'wheel' listener
  // as PASSIVE, so an onWheel handler's preventDefault() is silently ignored and
  // the surrounding panel scrolls WHILE the region zooms (plus a console warning).
  // The Timeline already uses this same native-listener pattern for its zoom.
  const onLayerWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const el = interactionLayerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      const track: "screen" | "face" =
        localY / rect.height < liveSplitRef.current ? "screen" : "face";
      const current = currentTransformFor(track);
      const zoomDelta = -e.deltaY * 0.0015;
      const nextScale = clamp(current.scale * (1 + zoomDelta), ZOOM_MIN, ZOOM_MAX);
      writeTransform(track, { x: current.x, y: current.y, scale: nextScale });
    },
    [currentTransformFor, writeTransform]
  );

  // Bind the wheel-zoom handler as a NON-PASSIVE native listener so its
  // preventDefault() actually suppresses the page/panel scroll (a React onWheel
  // prop is passive, so preventDefault there is a no-op). Re-attaches if the
  // handler identity changes; cleans up on unmount.
  useEffect(() => {
    const el = interactionLayerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onLayerWheel, { passive: false });
    return () => el.removeEventListener("wheel", onLayerWheel);
  }, [onLayerWheel]);

  // ---------------------------------------------------------------------
  // CANVAS DIRECT-MANIPULATION -- one consolidated pointer-down router.
  // getRect feeds normalized<->screen mapping to the pure geometry + the DOM
  // chrome; it returns the preview canvas's live on-screen box (the container,
  // which the canvas fills edge-to-edge). All coordinates are fractions of this
  // rect, so the math is identical at preview size and at 1080p/4K export.
  // ---------------------------------------------------------------------
  const getRect = useCallback((): PreviewRect | null => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, []);

  const { routePointerDown, beginHandleGesture } = useObjectSelection({ getRect });

  // Clicking ANYWHERE outside the preview container (transcript rail, inspector,
  // timeline, top bar, or the dark margin around the 9:16) clears the canvas
  // selection so the coral chrome disappears. The container -- not the canvas
  // rect -- is the boundary: the selection handles + toolbar are DOM siblings
  // that may bleed past the canvas box, but they still live inside this
  // container, so clicking them (to manipulate the selection) never deselects.
  useDeselectOnOutsideClick(containerRef);

  const selectClip = useRepurposeStore((s) => s.selectClip);
  const selectOverlay = useRepurposeStore((s) => s.selectOverlay);

  // The single pointer-down on the interaction layer. Order (topmost first):
  //   overlay hit -> the hook already selected it + began a move drag (nothing
  //     more to do here).
  //   base hit -> select the ACTIVE clip (so the base gets a selection + the
  //     reset-framing toolbar) AND reuse the region reframe drag for pan.
  //   empty -> deselect everything.
  const onLayerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // A pointer-down on a child that stopped propagation (the split handle, a
      // selection handle, the toolbar) never reaches here. Everything else routes.
      const route = routePointerDown(e);
      if (route.kind === "overlay") {
        e.preventDefault();
        e.stopPropagation();
        return; // hook owns the move drag
      }
      if (route.kind === "base") {
        e.preventDefault();
        e.stopPropagation();
        // Select the clip under the playhead so the base object reads as
        // selected (toolbar reset-framing); no clip = leave selection cleared.
        const active = activeClipAt(liveRef.current.clips, liveRef.current.playhead);
        if (active) selectClip(active.id);
        else selectOverlay(null);
        // Reuse the existing per-region reframe drag. Region pixel height is the
        // band's share of the container per the composited split.
        const rect = e.currentTarget.getBoundingClientRect();
        const regionWidthPx = rect.width;
        const split = liveSplitRef.current;
        const regionHeightPx =
          route.region === "screen" ? rect.height * split : rect.height * (1 - split);
        beginRegionReframe(route.region, e, regionWidthPx, regionHeightPx);
        return;
      }
      // Empty -> clear any selection.
      selectOverlay(null);
      selectClip(null);
    },
    [routePointerDown, beginRegionReframe, selectClip, selectOverlay]
  );

  // ---------------------------------------------------------------------
  // Keyboard on a SELECTED OVERLAY: pixel arrow-nudge, z-order chords, and
  // Esc-deselect. Delete/Backspace and Cmd+D are already owned by the Timeline's
  // window handler (gated on the same selectedOverlayId), so we deliberately do
  // NOT re-bind them here -- that would double-fire. We own the behaviors the
  // timeline doesn't:
  //   - Arrow = 1px nudge, Shift+Arrow = 10px (industry convention). "1px" is one
  //     ON-SCREEN preview pixel, mapped through the live preview rect to normalized
  //     (dxNorm = px / rect.width, dyNorm = px / rect.height) -- the exact same
  //     screen-px -> normalized mapping the drag paths use, so nudge and drag agree.
  //   - Cmd/Ctrl+] bring forward, Cmd/Ctrl+[ send backward (setOverlayZ).
  //   - Esc clears the selection.
  // Every nudge re-runs the HARD top-half keep-out (clampOverlayToTopHalf) so the
  // overlay bottom can never be nudged across the split seam -- the same invariant
  // drag/resize/duplicate/add enforce. Gated off the transcript panel + any
  // editable target so typing never nudges or re-stacks an overlay.
  // ---------------------------------------------------------------------
  const updateOverlayTransform = useRepurposeStore((s) => s.updateOverlayTransform);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("#transcript-panel") ||
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      const id = useRepurposeStore.getState().selectedOverlayId;
      if (!id) return;

      if (e.key === "Escape") {
        e.preventDefault();
        useRepurposeStore.getState().selectOverlay(null);
        return;
      }

      // ] / [ -- restack the overlay among overlays (layer up / layer down).
      // Bare press = one step; Shift = all the way to front/back. The legacy
      // Cmd/Ctrl chords keep working (same one-step action). code-based so it
      // is keyboard-layout stable, matching the Timeline chords.
      if (e.code === "BracketRight") {
        e.preventDefault();
        useRepurposeStore
          .getState()
          .setOverlayZ(id, e.shiftKey ? "front" : "forward");
        return;
      }
      if (e.code === "BracketLeft") {
        e.preventDefault();
        useRepurposeStore
          .getState()
          .setOverlayZ(id, e.shiftKey ? "back" : "backward");
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        return; // any other mod-chord (undo/redo/dupe) is owned elsewhere
      }

      // Pixel nudge: 1px, Shift = 10px. Resolve to normalized through the LIVE
      // preview rect so a press moves exactly N on-screen pixels at any zoom.
      const px = e.shiftKey ? 10 : 1;
      let signX = 0;
      let signY = 0;
      if (e.key === "ArrowLeft") signX = -1;
      else if (e.key === "ArrowRight") signX = 1;
      else if (e.key === "ArrowUp") signY = -1;
      else if (e.key === "ArrowDown") signY = 1;
      else return;
      e.preventDefault();

      const rect = getRect();
      if (!rect) return;
      const ov = useRepurposeStore.getState().overlays.find((o) => o.id === id);
      if (!ov) return;

      const nextX = ov.transform.x + (signX * px) / rect.width;
      const nextY = ov.transform.y + (signY * px) / rect.height;
      // HARD top-half keep-out -- correct the moved transform so the bottom edge
      // never crosses the seam (splitRatio read fresh, like the drag paths).
      const clampSplit = useRepurposeStore.getState().splitRatio;
      const clamped = clampOverlayToTopHalf(
        { ...ov.transform, x: nextX, y: nextY },
        ov.naturalWidth,
        ov.naturalHeight,
        rect,
        clampSplit
      );
      updateOverlayTransform(id, { x: clamped.x, y: clamped.y });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [updateOverlayTransform, getRect]);

  // ---------------------------------------------------------------------
  // "P" = drop a mid-clip ZOOM PUNCH-IN at the playhead on the active scene.
  //   P        -> SCREEN region (the common case: punch into the screen detail)
  //   Shift+P  -> FACE region
  // Adds a default punch (amount 0.25 = +25%, holdSec 0.6) centered at the
  // active clip's SOURCE time under the playhead. A keypress has no cursor, so
  // the region is chosen by the modifier, not by pointer Y. Gated off the
  // transcript panel + any editable target so typing a "p" never punches. One
  // discrete undo step (setClipPunch commits with its own coalesce key).
  // ---------------------------------------------------------------------
  const setClipPunch = useRepurposeStore((s) => s.setClipPunch);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd/Ctrl+P (print) alone
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("#transcript-panel") ||
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      const { clips: liveClips, playhead: t } = liveRef.current;
      const active = activeClipAt(liveClips, t);
      if (!active) return; // no scene under the playhead -- nothing to punch
      e.preventDefault();
      const region: "screen" | "face" = e.shiftKey ? "face" : "screen";
      // TOGGLE: if this region already carries a punch, the keypress REMOVES it
      // (mirrors the toolbar buttons); otherwise it adds the default punch.
      const existing = region === "screen" ? active.screenPunch : active.facePunch;
      if (existing != null) {
        setClipPunch(active.id, region, null);
        return;
      }
      const atSrc = active.srcStart + (t - active.timelineStart);
      setClipPunch(active.id, region, { atSrc, amount: 0.25, holdSec: 0.6, ease: "natural" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setClipPunch]);

  // ---------------------------------------------------------------------
  // The handle + region dividers follow the LIVE composited split (per-scene,
  // eased across cuts -- published each frame by the rAF loop), so the coral
  // handle always sits on the seam actually drawn, not the raw global default.
  const topPct = useMemo(() => handleSplit * 100, [handleSplit]);

  return (
    <div
      ref={containerRef}
      // overflow-VISIBLE: the ghosted off-frame overlay bleed + the
      // selection handles for an overlay dragged partway off-frame must be able
      // to paint OUTSIDE the 9:16 box. The black fill lives on the <canvas> leaf
      // node itself, so its bitmap edge clips the composited video to a crisp
      // FLAT rect (no rounded corners -- matches the exported reel) while its
      // siblings (ghost layer, snap guides, chrome) are free to bleed. The
      // page.tsx wrapper (max-w-[340px], no overflow-hidden)
      // and the flanking asides bound the bleed, and overflow:visible never
      // creates a page scrollbar, so nothing scrolls horizontally.
      className={`relative w-full select-none overflow-visible shadow-2xl ${className ?? ""}`}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      {/* Hidden source videos -- decoded frames only, never displayed directly. */}
      {/* src omitted until footage loads -- passing "" makes the browser try to
          load the page URL and logs an error. undefined leaves the element idle. */}
      {/* Audio source of truth: only ONE track plays. The ACTIVE face slot
          carries the narration (unmuted); everything else stays muted.
          SLOT_COUNT slots per source (double-buffer ring):
          slot 0 starts active, the rest sit paused + pre-seeked at the next
          discontinuous cuts. `muted` is set here only for the INITIAL state --
          after a swap it is managed imperatively in the rAF loop, and React
          never rewrites a prop whose value didn't change between renders, so
          the imperative flips stick. */}
      {SLOT_INDICES.map((slot) => (
        <video
          key={`screen-${slot}`}
          ref={(el) => {
            screenElsRef.current[slot] = el;
          }}
          src={footageMeta?.screenPath || undefined}
          muted
          playsInline
          preload="auto"
          className="hidden"
        />
      ))}
      {/* Face slots read faceProxy.src -- the original streaming URL until the
          low-res preview proxy is built + a pause lets it swap in. Export
          never sees this: it reads footageMeta.faceCamPath directly. onError
          falls back to the original if a purged proxy cache 404s mid-session. */}
      {SLOT_INDICES.map((slot) => (
        <video
          key={`face-${slot}`}
          ref={(el) => {
            faceElsRef.current[slot] = el;
          }}
          src={faceProxy.src}
          muted={slot !== 0}
          playsInline
          preload="auto"
          className="hidden"
          onError={faceProxy.onSrcError}
        />
      ))}

      {/* Overlay <video> pool -- one hidden, ALWAYS-muted element per video
          overlay, keyed by id. The ref callback registers/unregisters it in
          videoPoolRef so the rAF loop can seek + drawImage it every frame; a
          removed overlay's element unmounts and its map entry is cleared. An
          overlay never emits audio, so `muted` is permanent. */}
      {overlays
        .filter((o) => o.kind === "video")
        .map((o) => (
          <video
            key={o.id}
            ref={(el) => {
              if (el) videoPoolRef.current.set(o.id, el);
              else videoPoolRef.current.delete(o.id);
            }}
            src={o.src}
            muted
            playsInline
            preload="auto"
            className="hidden"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              if (el.videoWidth <= 0 || el.videoHeight <= 0) return;
              const cur = useRepurposeStore
                .getState()
                .overlays.find((ov) => ov.id === o.id);
              if (cur && (cur.naturalWidth <= 0 || cur.naturalHeight <= 0)) {
                // Metadata backfill only (bypasses history via setState).
                useRepurposeStore.setState((s) => ({
                  overlays: s.overlays.map((ov) =>
                    ov.id === o.id
                      ? { ...ov, naturalWidth: el.videoWidth, naturalHeight: el.videoHeight }
                      : ov
                  ),
                }));
              }
            }}
          />
        ))}
      {/* GHOSTED OFF-FRAME OVERFLOW -- a dim, non-interactive copy of
          each active overlay's media, positioned with the SAME normalized ->
          screen mapping the compositor uses, sitting BEHIND the canvas (z-0).
          The part of each ghost that falls INSIDE the 9:16 frame is painted over
          by the opaque canvas (z-[1]) at full fidelity; only the part that bleeds
          OUTSIDE the frame shows through, at reduced opacity -- so an overlay
          dragged/zoomed off-frame stays visible + grabbable without any change to
          the clipped canvas render or the export (DOM-only, like the grid). */}
      <GhostOverflowLayer getRect={getRect} />

      {/* The composited video. FLAT-edged to match the exported reel exactly --
          the real 1080x1920 output has no rounded corners, so the preview must not
          fake a phone-frame roundness (it was purely cosmetic CSS, never in the
          export). z-[1] so it paints OVER the inside portion of the ghost. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[1] h-full w-full bg-black"
      />

      {/* Alignment grid -- rule-of-thirds guides + a brighter center crosshair,
          so an overlay can be eyeballed to dead center. pointer-events:none so
          it never blocks a drag; DOM-only so it is NEVER in the export. Percent
          positions, so it tracks any preview size. z-10 keeps it under the
          selection chrome. */}
      {showGrid && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {/* rule-of-thirds -- faint white lines at 1/3 and 2/3 */}
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/20" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/20" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/20" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/20" />
          {/* center crosshair -- brighter coral so "dead center" reads instantly */}
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#FF6B35]/60" />
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#FF6B35]/60" />
          <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#FF6B35]/80" />
        </div>
      )}

      {/* MAGNETIC SNAP GUIDES -- the coral dashed alignment lines drawn
          while an overlay is being dragged and one of its edges/center snaps to a
          frame line, the split seam, a rule-of-thirds line, or another overlay.
          Reads the transient `activeSnapGuides` from the store (set by the move
          gesture, [] otherwise, so the lines appear only mid-drag). Sits above the
          grid (z-10) and interaction layer but below the selection chrome (z-20);
          pointer-events:none + DOM-only, so it NEVER blocks a drag or bakes into
          the export. */}
      <SnapGuides />

      {/* low-res proxy build progress -- a quiet pill while the one-time ffmpeg
          pass runs in the background. DOM-only (never in the export), gone the
          moment the proxy is ready. Playback keeps using the original file
          until the swap, so this is purely informational. */}
      {faceProxy.buildProgress !== null && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium tracking-wide text-white/75">
          Preparing fast preview {Math.round(faceProxy.buildProgress * 100)}%
        </div>
      )}

      {/* CONSOLIDATED interaction layer -- ONE full-canvas surface that routes
          every pointer-down through the overlay hit-test first (select + drag an
          overlay), then falls back to the base-region reframe (pan/zoom the
          face/screen scene), then to deselect. This replaces the two separate
          pan bands so the overlay selection never fights them. The split handle,
          the selection handles, and the toolbar are siblings ABOVE this layer
          with pointer-events + stopPropagation, so they win the hit-test and
          this router never sees their grabs. */}
      <div
        ref={interactionLayerRef}
        className={`absolute inset-0 z-[2] ${cloneModifier ? "cursor-copy" : "cursor-move"}`}
        onPointerDown={onLayerPointerDown}
        title="Click an overlay to select; drag to move it. Shift-click to multi-select, Cmd/Ctrl-drag to clone. Drag the canvas to pan / scroll to zoom."
      />

      {/* Split handle -- the seam stays fully draggable (same hit strip, same
          cursor, same onPointerDown), but the always-on coral pill is GONE: it
          overlapped the captions sitting on the seam and got in the way. The pill
          now shows ONLY on hover, so the divider is discoverable when you reach
          for it yet invisible the rest of the time. Functionality is unchanged. */}
      <div
        className="group absolute inset-x-0 z-10 flex cursor-ns-resize items-center justify-center"
        style={{ top: `${topPct}%`, height: 16, marginTop: -8 }}
        onPointerDown={handleDividerPointerDown}
      >
        <div className="h-[3px] w-10 rounded-full bg-[#FF6B35] opacity-0 shadow-[0_0_0_3px_rgba(0,0,0,0.35)] transition-opacity group-hover:opacity-100" />
      </div>

      {/* Selection chrome (DOM only -- never drawn into the canvas, so the
          export stays clean). The box body is pointer-events:none so a drag on
          the media falls through to the router above; only the 8 resize handles
          + the rotate grip opt in and forward to beginHandleGesture. */}
      <SelectionOverlay getRect={getRect} beginHandleGesture={beginHandleGesture} />
      {/* Floating, always-upright toolbar for whatever is selected. */}
      <SelectionToolbar getRect={getRect} />
    </div>
  );
}
