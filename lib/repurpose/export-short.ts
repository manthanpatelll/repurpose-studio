// ===========================================================================
// REPURPOSE STUDIO -- export wiring
// ===========================================================================
// Bridges the compositor (drawFrame) to the shared export pipeline
// (lib/export/videoExporter.ts exportVideo -> WebCodecs -> Mediabunny MP4) and
// then muxes an audio track back in.
//
// PIPELINE
//   1. Render + encode the picture with the existing (worker-based, codec-
//      fallback-hardened) videoExporter -> a VIDEO-ONLY MP4 blob.
//   2. Assemble the face-cam audio: for every kept clip, decode the face-cam
//      audio for its SOURCE range [srcStart, srcEnd] and blit those samples
//      into one output AudioBuffer at the clip's OUTPUT position
//      [timelineStart, timelineEnd]. This is the exact same source->output map
//      the video frame-walk uses (see timelineToSourceTime), so audio and
//      picture stay aligned across cuts/retakes/reorders.
//   3. Remux: copy the encoded video packets out of the step-1 MP4 and add the
//      assembled audio (encoded via a Mediabunny AudioBufferSource, which uses
//      the WebCodecs AudioEncoder under the hood) into a single new MP4.
//
// If the face-cam has no audio track, or Web Audio / mediabunny decoding is
// unavailable, we fall back to shipping the silent video-only MP4 (and log
// why) rather than failing the export.
//
// NOTE ON FORMAT: this project's export path (videoExporter.ts) produces MP4
// (H.264/HEVC via WebCodecs + a Mediabunny MP4 muxer). There is no ProRes /
// .mov / alpha encoder here, so the output is `<name>.mp4` and the UI is
// labelled accordingly -- see page.tsx. Do not claim ".mov" for this pipeline.
//
// NOTE ON FPS: the frame-walk cadence and the video encoder framerate are
// sourced from footageMeta.fps (the raw footage's real rate, e.g. 175/6 ≈
// 29.17), NOT a hardcoded 30. A hardcoded 30 walks ~2.8% too many frames per
// second, which on a multi-minute export drifts the audio->video alignment by
// seconds. Sourcing both cadence and encoder rate from the same footage fps
// keeps them locked.
// ===========================================================================

import { exportVideo, downloadBlob, type ExportProgress } from "../export/videoExporter";
import {
  drawFrame,
  type RegionSource,
  type DrawableSource,
  type OverlayDraw,
} from "./compositor";
import { gradeFilter } from "./color-grade";
import {
  timelineToSourceTime,
  transitionProgressAt,
  splitRatioAt,
  screenFramingAt,
  faceFramingAt,
  punchScaleAt,
} from "./time-map";
import { drawCaptions, type CaptionStyle, type CaptionBlock } from "./captions";
import { loadCaptionFonts } from "./caption-fonts";
import type { Clip, FootageMeta, MusicTrack, Overlay, SfxTrack } from "./types";

/**
 * Output resolution presets. Both are 9:16 vertical. "1080p" is the standard
 * Reel/Shorts/TikTok delivery size; "4k" (2160x3840) upscales for crispness on
 * platforms that keep more of the source (source footage is ~1080, so 4K adds
 * no real detail -- only sharper text/edges after the compositor's own draw --
 * at a larger file + longer encode). The compositor draws vector UI (split
 * handle, placeholder labels) fresh at the target size, so those stay crisp.
 */
export type ExportResolution = "1080p" | "4k";

const RESOLUTION_DIMENSIONS: Record<ExportResolution, { width: number; height: number }> = {
  "1080p": { width: 1080, height: 1920 },
  "4k": { width: 2160, height: 3840 },
};

/** Fallback framerate when footageMeta carries no usable fps (see resolveFps). */
const DEFAULT_FPS = 30;

/** Resolve the export framerate from the footage, falling back to 30. */
function resolveFps(footageMeta: FootageMeta | null): number {
  const fps = footageMeta?.fps;
  return typeof fps === "number" && isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

/** Everything the export needs, pulled from the store at click time. */
export interface ExportShortInput {
  clips: Clip[];
  duration: number;
  splitRatio: number;
  footageMeta: FootageMeta | null;
  /**
   * Free-floating media overlays (images + videos) baked ON TOP of the base
   * face+screen composite, each in its own OUTPUT-time window
   * [timelineStart, timelineEnd), free-transformed (normalized center/scale/
   * rotation) and z-ordered among themselves. Built into the SAME OverlayDraw[]
   * the preview feeds drawFrame, so the export is frame-identical.
   *
   * Overlays are ALWAYS silent -- a video overlay contributes NO audio to the
   * export, ever (assembleClipAudio stays face-cam only). Overlays never extend
   * the reel; any window past `duration` is simply never reached by the walk.
   * Omitted/undefined/empty -> byte-identical to a no-overlay export.
   */
  overlays?: Overlay[];
  /**
   * The reel's generated SOUND-EFFECTS track (or null/absent for none). A single
   * full-length WAV, additively mixed INTO the assembled face-cam audio at
   * `sfxTrack.gain` before muxing -- so the exported MP4 carries VO + SFX, matching
   * the preview. Decoded/resampled to the assembled buffer's rate+layout and hard-
   * clamped to [-1,1] after summing. If the face-cam has no audio, the SFX plays
   * alone over a fresh silent bed so an SFX-only reel still exports. Mixing is
   * best-effort: any failure logs and falls back to the face-cam-only audio (never
   * fails the export). Omitted/undefined/null -> byte-identical to a no-SFX export.
   */
  sfxTrack?: SfxTrack | null;
  /**
   * The reel's BACKGROUND-MUSIC bed (or null/absent for none). A single music
   * file added manually, additively mixed INTO the assembled audio the SAME way
   * as the SFX bed, but with a START OFFSET: the music begins at OUTPUT time
   * `musicTrack.startAtSec` (SFX starts at 0). Decoded/resampled to the assembled
   * buffer's rate+layout, gained by `musicTrack.gain`, summed from sample offset
   * `round(startAtSec * sampleRate)`, and hard-clamped to [-1,1] after summing.
   * Music that runs past the reel end is clipped. If the face-cam has no audio and
   * there's no SFX, the music plays alone over a fresh silent bed. Mixing is best-
   * effort: any failure logs and falls back to the un-mixed audio (never fails the
   * export). Omitted/undefined/null -> byte-identical to a no-music export.
   */
  musicTrack?: MusicTrack | null;
  fileName?: string;
  onProgress?: (p: ExportProgress) => void;
  /** Output resolution preset (default "1080p"). See ExportResolution. */
  resolution?: ExportResolution;
  /**
   * Color-grade preset ids per track (see lib/repurpose/color-grade.ts).
   * Forwarded to the SAME drawFrame the preview uses, so a graded export
   * matches the graded preview exactly. Omitted/undefined -> "none" (untouched).
   */
  screenGrade?: string;
  faceGrade?: string;
  /**
   * Burned-in captions, forwarded to the SAME drawCaptions the preview uses so
   * "what you see is what you export." When captionsEnabled and captionBlocks
   * are present, drawCaptions runs LAST in each frame (the top layer). Word
   * timings are SOURCE seconds -- mapped per frame via timelineToSourceTime.
   * Omitted/undefined -> no captions burned in.
   */
  captionsEnabled?: boolean;
  captionStyle?: CaptionStyle;
  captionBlocks?: CaptionBlock[];
  /**
   * When true (default), the finished MP4 is downloaded to disk via
   * downloadBlob. Set false to render WITHOUT a download -- used by the smooth
   * in-editor preview, which just wants the blob URL to feed a <video> (no save
   * dialog, no file on disk). The returned {url, blob} is the same either way;
   * a no-download caller owns revoking the url when it's done with it.
   */
  download?: boolean;
}

/** What {@link exportShort} resolves to: the object-URL of the finished MP4 and
 * its blob (so a no-download caller can revoke the url / re-use the blob).
 * On the download:true path `url` is "" -- the file is already on disk and the
 * URL is revoked internally so the full MP4 blob isn't pinned in memory. */
export interface ExportShortResult {
  url: string;
  blob: Blob;
}

// Output -> source time mapping is shared with the preview and the store's
// keyframe-ripple remap via lib/repurpose/time-map.ts. Using the one
// implementation keeps the export frame-walk pixel-identical to the preview
// (same half-open [start, end) cut boundary, so no one-frame flash at cuts).

/** Load a <video> from a src and resolve once it can render frames. */
function loadVideo(src: string | undefined): Promise<HTMLVideoElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = src;
    const onReady = () => resolve(v);
    v.addEventListener("loadeddata", onReady, { once: true });
    v.addEventListener("error", () => resolve(null), { once: true });
    v.load();
  });
}

/**
 * Seek a video to an exact time and await the seeked event. Rejects (instead of
 * hanging the whole export forever) when the element errors mid-seek or the
 * seeked event never fires -- one wedged frame must surface as a failed export,
 * not a silent stall with the progress bar frozen.
 */
const SEEK_TIMEOUT_MS = 10_000; // far beyond any real seek, even on a cold 4K file
function seekVideo(video: HTMLVideoElement, time: number, fps: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const clamped = Math.max(0, video.duration && isFinite(video.duration) ? Math.min(time, video.duration) : time);
    if (Math.abs(video.currentTime - clamped) < 1 / (fps * 4)) {
      resolve();
      return;
    }
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`seekVideo: video element errored seeking to ${clamped.toFixed(3)}s`));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`seekVideo: seeked never fired for ${clamped.toFixed(3)}s (decoder wedged?)`));
    }, SEEK_TIMEOUT_MS);
    video.currentTime = clamped;
  });
}

// ===========================================================================
// FAST FRAME SOURCE (WebCodecs decode, no per-frame <video> seeking)
// ===========================================================================
// The old path set video.currentTime and awaited the `seeked` event once PER
// TRACK PER FRAME. That event fires ~20-100ms later, capping throughput at
// ~10-50fps and dominating export time on a multi-minute short.
//
// This decoder instead drives mediabunny's CanvasSink.canvasesAtTimestamps():
// we feed it the whole ordered list of SOURCE timestamps (one per output
// frame, already mapped through timelineToSourceTime) and it decodes each
// underlying packet at most once via a WebCodecs VideoDecoder, pre-decoding a
// few frames ahead. For a monotonic timestamp run (the common case -- deleted
// retakes only, no reorders) it hits its fully optimized linear path.
//
// The iterator is PULL-based and yields strictly in the order of the supplied
// timestamps, so we advance it in lockstep with exportVideo's in-order
// renderFrame(i/fps) walk: frame i pulls the i-th decoded canvas. A null
// timestamp (playhead over a collapsed/deleted region) yields no decode -- we
// reuse the last good canvas so the compositor still has something to draw.

/** A per-frame source timestamp, or null when no kept clip covers that frame. */
type FrameTimestamp = number | null;

/** One decoded frame's source + native size. */
interface DecodedFrame {
  source: DrawableSource | null;
  width: number;
  height: number;
}

interface TrackFrameSource {
  /**
   * Pull the decoded frame for output frame `frameIndex`. The mediabunny
   * CanvasSink iterator is single-use and yields strictly in the order of the
   * timestamps it was given, so this MUST be pulled once per frame in ascending
   * order (0, 1, 2, ...). The happy path -- the worker walk, or the main-thread
   * walk when it runs first -- does exactly that.
   *
   * Returns `null` when `frameIndex` is NOT the next expected index. That only
   * happens when exportVideo restarts the frame walk from 0 on the main thread
   * after the worker path threw mid-run: the spent iterator cannot re-seek, so a
   * null tells the caller to retire this decode source and fall back to the
   * re-seekable <video>-seek path for this frame (and every frame after it).
   */
  next(frameIndex: number): Promise<DecodedFrame | null>;
  dispose(): Promise<void>;
}

/**
 * Build a WebCodecs-backed frame source for one track. Returns null when the
 * track can't be opened/decoded (no path, no video track, browser can't decode
 * the codec) so the caller can fall back to the <video>-seek path.
 *
 * `timestamps` is the full ordered list of source times we'll render, one per
 * output frame. Nulls are stripped for the decode request (CanvasSink wants
 * real timestamps) but we keep the original list to know which output frames
 * were null and should reuse the previous frame.
 */
async function makeDecodeFrameSource(
  path: string | undefined,
  timestamps: readonly FrameTimestamp[],
  outWidth: number,
  outHeight: number
): Promise<TrackFrameSource | null> {
  if (!path) return null;
  const { Input, UrlSource, ALL_FORMATS, CanvasSink } = await import("mediabunny");

  const input = new Input({ source: new UrlSource(path), formats: ALL_FORMATS });
  let videoTrack;
  try {
    videoTrack = await input.getPrimaryVideoTrack();
  } catch {
    videoTrack = null;
  }
  if (!videoTrack) {
    await disposeInput(input);
    return null;
  }
  try {
    if (!(await videoTrack.canDecode())) {
      await disposeInput(input);
      return null;
    }
  } catch {
    await disposeInput(input);
    return null;
  }

  // Decode at native display size (fit metadata handled by the sink); the
  // compositor does the cover-fit + pan/zoom into the split region itself.
  // A small pool caps VRAM: we only ever hold the current + look-ahead frames.
  // poolSize caps how many decoded canvases the sink holds -- i.e. how far the
  // WebCodecs decoder may run AHEAD of the encoder. 2 barely covered the current
  // frame + one look-ahead, so decode and encode ran nearly lockstep. 5 lets the
  // decoder pre-decode a short burst while the encoder works the earlier frames,
  // overlapping the two stages (still a tiny, bounded VRAM pool).
  const sink = new CanvasSink(videoTrack, {
    poolSize: 5,
    fit: "fill",
  });

  // Only real (non-null) timestamps go to the decoder, in order. We remember,
  // for each output frame, whether it had a timestamp so next() can reuse the
  // previous canvas for null frames instead of pulling from the iterator.
  const realTimestamps: number[] = [];
  for (const t of timestamps) if (t !== null) realTimestamps.push(t);

  const iterator = sink.canvasesAtTimestamps(realTimestamps);
  let frameCursor = 0; // index into `timestamps`
  let lastSource: DrawableSource | null = null;
  let lastWidth = 0;
  let lastHeight = 0;

  let retired = false;
  return {
    async next(frameIndex: number) {
      // Single-use iterator: it can only be pulled in ascending lockstep with
      // `frameCursor`. A frameIndex that isn't the next expected one means the
      // frame walk restarted (worker threw mid-run -> main-thread retry from 0),
      // so the iterator is spent for that position. Retire this source and let
      // the caller re-seek a <video> instead of pulling stale/exhausted frames.
      if (retired || frameIndex !== frameCursor) {
        retired = true;
        return null;
      }
      const ts = timestamps[frameCursor++];
      if (ts === null) {
        // No decode for this frame -- reuse the previous good canvas.
        return { source: lastSource, width: lastWidth, height: lastHeight };
      }
      const res = await iterator.next();
      const wrapped = res.done ? null : res.value;
      if (wrapped) {
        lastSource = wrapped.canvas as DrawableSource;
        lastWidth = wrapped.canvas.width;
        lastHeight = wrapped.canvas.height;
      }
      return { source: lastSource, width: lastWidth, height: lastHeight };
    },
    async dispose() {
      try {
        await iterator.return?.();
      } catch {
        /* ignore */
      }
      await disposeInput(input);
    },
  };
}

/** Best-effort dispose of a mediabunny Input's underlying reader. */
async function disposeInput(input: unknown): Promise<void> {
  try {
    await (input as { dispose?: () => Promise<void> | void }).dispose?.();
  } catch {
    /* ignore */
  }
}

/**
 * Is this footage URL fetchable right now? A restored project brings back a
 * `blob:` footage URL that died on reload -- exporting against it would fail deep
 * inside mediabunny with an opaque "Failed to fetch" (its UrlSource retries the
 * fetch, logging each attempt). Probe once up front with a 1-byte Range GET so we
 * can throw a CLEAR, actionable error instead. `undefined`/empty paths count as
 * unreachable. HEAD isn't supported on blob: URLs; a ranged GET is, and it moves
 * almost nothing on a live /api/repurpose/video source.
 */
async function isFootageReachable(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    const res = await fetch(path, { headers: { Range: "bytes=0-0" } });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

/**
 * Render the whole Short to an MP4 (with audio) and trigger a download.
 * Resolves to {url, blob}; url is a live object URL only on the download:false
 * path (see ExportShortResult).
 */
export async function exportShort(input: ExportShortInput): Promise<ExportShortResult | null> {
  const {
    clips,
    duration,
    splitRatio,
    footageMeta,
    overlays = [],
    sfxTrack,
    musicTrack,
    fileName = "repurpose-short.mp4",
    onProgress,
    screenGrade,
    faceGrade,
    captionsEnabled,
    captionStyle,
    captionBlocks,
    resolution = "1080p",
    download = true,
  } = input;

  if (duration <= 0) return null;

  // Preflight: both footage sources must be fetchable BEFORE we spin up the
  // decode/encode pipeline. After a page reload a restored project's blob: URLs
  // are dead, and exporting would otherwise fail deep in mediabunny with an
  // opaque "Failed to fetch". Probe both tracks in parallel and throw a clear,
  // actionable message (surfaced verbatim in the page's export-error banner) so
  // Manthan knows to re-select his Screen + Face files via the re-import banner.
  const [screenOk, faceOk] = await Promise.all([
    isFootageReachable(footageMeta?.screenPath),
    isFootageReachable(footageMeta?.faceCamPath),
  ]);
  if (!screenOk || !faceOk) {
    const missing = [!screenOk && "Screen", !faceOk && "Face"]
      .filter(Boolean)
      .join(" + ");
    throw new Error(
      `Can't reach the ${missing} footage. If you reloaded the page, re-select your video files (Screen + Face) to reconnect, then export again.`
    );
  }

  const fps = resolveFps(footageMeta);
  const { width: OUT_WIDTH, height: OUT_HEIGHT } = RESOLUTION_DIMENSIONS[resolution];
  const totalFrames = Math.max(1, Math.ceil(duration * fps));

  // Pre-compute the SOURCE timestamp for every output frame (in encode order),
  // so the WebCodecs decode pipeline can walk them at most once each. null =
  // this frame sits over a collapsed/deleted region (reuse the last frame).
  const frameTimestamps: FrameTimestamp[] = new Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    frameTimestamps[i] = timelineToSourceTime(clips, i / fps);
  }

  // Try the FAST path first: decode both tracks via WebCodecs (no <video>
  // seeking). If a track can't be decoded (unsupported codec, no track), we
  // fall back to the legacy <video>-seek source for THAT track only, so the
  // export never breaks -- it just isn't as fast for the un-decodable track.
  const [screenDecode, faceDecode] = await Promise.all([
    makeDecodeFrameSource(footageMeta?.screenPath, frameTimestamps, OUT_WIDTH, OUT_HEIGHT),
    makeDecodeFrameSource(footageMeta?.faceCamPath, frameTimestamps, OUT_WIDTH, OUT_HEIGHT),
  ]);

  // Legacy <video> elements: created up front for tracks that failed to decode,
  // and lazily on demand for a decode track that RETIRES mid-export (the worker
  // path threw and exportVideo restarted the walk from frame 0, spending the
  // single-use decode iterator -- see makeDecodeFrameSource / pullRegionSource).
  // A <video> is re-seekable, so it serves any frame index on the restart pass.
  let screenVideo = screenDecode ? null : await loadVideo(footageMeta?.screenPath);
  let faceVideo = faceDecode ? null : await loadVideo(footageMeta?.faceCamPath);
  // Memoized per-path <video> loads so a retired decode track lazy-loads its
  // fallback exactly once even though frames pull concurrently (Promise.all).
  const lazyVideoLoads = new Map<string, Promise<HTMLVideoElement | null>>();
  const loadVideoOnce = (path: string | undefined): Promise<HTMLVideoElement | null> => {
    if (!path) return Promise.resolve(null);
    let p = lazyVideoLoads.get(path);
    if (!p) {
      p = loadVideo(path);
      lazyVideoLoads.set(path, p);
    }
    return p;
  };

  // ── OVERLAY SETUP (free-floating image/video layers) ─────────────────────
  // Overlays composite ON TOP of the base composite, each in its own OUTPUT-time
  // window, free-transformed and z-ordered. They are ADDITIVE: a broken/
  // unreachable overlay is skipped with a warning, never a thrown export.
  //
  //   Images -> decode ONCE to an ImageBitmap (cached by id, closed on teardown).
  //   Videos -> each gets its OWN independent makeDecodeFrameSource over ITS OWN
  //             monotonic active-frame timestamp list (isolated from the two base
  //             iterators; each overlay is a different file => a different sink).
  //             A per-overlay re-seekable <video> is the worker-restart fallback.
  //
  // Overlays whose whole window sits at/after `duration` are unreachable by the
  // frame walk (frames only run 0..totalFrames-1) -- we SKIP them up front.
  const overlayBitmaps = new Map<string, ImageBitmap>();
  // Per video overlay: its WebCodecs decode source (null when the codec can't be
  // decoded -> falls back to the pooled <video>), plus a lazily-loaded, re-seekable
  // <video> used both as the primary source (no decode) and the restart fallback.
  interface OverlayVideoState {
    overlay: Overlay;
    decode: TrackFrameSource | null;
    video: HTMLVideoElement | null;
    videoLoad: Promise<HTMLVideoElement | null> | null;
    /** Per-overlay source timestamp for each output frame (null = inactive). */
    timestamps: FrameTimestamp[];
  }
  const overlayVideos = new Map<string, OverlayVideoState>();

  // Sort a stable ascending-z copy ONCE so drawOneFrame just filters by window.
  const overlaysByZ = [...overlays].sort((a, b) => a.zIndex - b.zIndex);

  // The output time of frame i is i / fps; an overlay is active on frame i when
  // that time lies in [timelineStart, timelineEnd). This is the SAME half-open
  // window the preview filters on, so preview == export.
  const overlayActiveAt = (o: Overlay, i: number): boolean => {
    const t = i / fps;
    return t >= o.timelineStart && t < o.timelineEnd;
  };

  const reachableOverlays: Overlay[] = [];
  for (const o of overlaysByZ) {
    // An overlay is reachable if ANY output frame falls inside its window.
    const firstActive = Math.max(0, Math.ceil(o.timelineStart * fps));
    if (firstActive >= totalFrames || o.timelineEnd <= o.timelineStart) {
      console.warn(
        `exportShort: overlay ${o.id} window [${o.timelineStart}, ${o.timelineEnd}) is outside the reel [0, ${duration}) -- skipping.`
      );
      continue;
    }
    // Reachable but the source URL is dead (restored blob: URL) -> skip, warn.
    if (!(await isFootageReachable(o.src))) {
      console.warn(
        `exportShort: overlay ${o.id} source is unreachable (${o.src}) -- skipping. Re-import the asset if you reloaded.`
      );
      continue;
    }
    reachableOverlays.push(o);
  }

  await Promise.all(
    reachableOverlays.map(async (o) => {
      if (o.kind === "image") {
        try {
          const res = await fetch(o.src);
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob);
          overlayBitmaps.set(o.id, bitmap);
        } catch (err) {
          console.warn(`exportShort: overlay image ${o.id} failed to decode -- skipping.`, err);
        }
        return;
      }
      // Video: build its own monotonic active-frame timestamp list, then an
      // isolated decode source over exactly those frames. Inactive frames are
      // null (the shared makeDecodeFrameSource skips the decode + reuses the last
      // canvas for them, keeping the single-use iterator cursor in lockstep).
      const timestamps: FrameTimestamp[] = new Array(totalFrames);
      for (let i = 0; i < totalFrames; i++) {
        timestamps[i] = overlayActiveAt(o, i)
          ? o.srcStart + (i / fps - o.timelineStart)
          : null;
      }
      const decode = await makeDecodeFrameSource(o.src, timestamps, OUT_WIDTH, OUT_HEIGHT);
      overlayVideos.set(o.id, {
        overlay: o,
        decode,
        // When the codec can't be decoded up front, prime the <video> fallback now.
        video: decode ? null : await loadVideo(o.src),
        videoLoad: null,
        timestamps,
      });
    })
  );

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(OUT_WIDTH, OUT_HEIGHT)
      : Object.assign(document.createElement("canvas"), { width: OUT_WIDTH, height: OUT_HEIGHT });
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("exportShort: could not get 2D context");

  // Register the caption faces for canvas text BEFORE the frame walk starts, so
  // the first burned-in caption uses the real face instead of racing its load
  // and falling back to a system font. Idempotent (shared promise); only worth
  // awaiting when captions will actually be drawn.
  if (captionsEnabled && captionBlocks?.length) {
    await loadCaptionFonts();
  }

  // Seek a fallback <video> to this frame's source time and read its pixels.
  const pullFromVideo = async (
    frameIndex: number,
    video: HTMLVideoElement
  ): Promise<DecodedFrame> => {
    const srcTime = frameTimestamps[frameIndex];
    if (srcTime !== null) await seekVideo(video, srcTime, fps);
    const ready = video.readyState >= 2;
    return {
      source: ready ? (video as DrawableSource) : null,
      width: video.videoWidth ?? 0,
      height: video.videoHeight ?? 0,
    };
  };

  // Pull one composited region's source for the given output frame index. Prefers
  // the WebCodecs decode source (pulled strictly in frame order); if that source
  // retires because the walk restarted (decode.next returns null -- spent
  // single-use iterator), it lazily loads a re-seekable <video> for that track's
  // path and seeks it, so the restart pass still gets the correct source frame.
  const pullRegionSource = async (
    frameIndex: number,
    decode: TrackFrameSource | null,
    getVideo: () => HTMLVideoElement | null,
    setVideo: (v: HTMLVideoElement | null) => void,
    path: string | undefined
  ): Promise<DecodedFrame> => {
    if (decode) {
      const decoded = await decode.next(frameIndex);
      if (decoded) return decoded;
      // Decode source retired (out-of-order pull on a restart). Fall through to
      // a re-seekable <video>, loading it once if we haven't already.
    }
    let video = getVideo();
    if (!video && path) {
      video = await loadVideoOnce(path);
      setVideo(video);
    }
    if (video) return pullFromVideo(frameIndex, video);
    return { source: null, width: 0, height: 0 };
  };

  // Pull one video OVERLAY's decoded frame for output frame `frameIndex`. Mirrors
  // pullRegionSource but keyed to the overlay's OWN monotonic timestamp list:
  //   - decode source present -> pull it EVERY frame (in lockstep with its cursor,
  //     even inactive frames -- inactive frames are null timestamps that the
  //     shared source skips, keeping the single-use iterator aligned). Retires to
  //     the <video> fallback if the walk restarts (decode.next returns null).
  //   - decode source absent/retired -> seek the overlay's re-seekable <video> to
  //     its own source time for this frame (timestamps[frameIndex], null=inactive).
  // The caller only USES the result on the overlay's active frames.
  const pullOverlayVideo = async (
    frameIndex: number,
    st: OverlayVideoState
  ): Promise<DecodedFrame> => {
    if (st.decode) {
      const decoded = await st.decode.next(frameIndex);
      if (decoded) return decoded;
      // Retired on a restart pass -- drop to the re-seekable <video> from here on.
      st.decode = null;
    }
    let video = st.video;
    if (!video) {
      if (!st.videoLoad) st.videoLoad = loadVideo(st.overlay.src);
      video = await st.videoLoad;
      st.video = video;
    }
    if (!video) return { source: null, width: 0, height: 0 };
    const srcTime = st.timestamps[frameIndex];
    if (srcTime !== null) await seekVideo(video, srcTime, fps);
    const ready = video.readyState >= 2;
    return {
      source: ready ? (video as DrawableSource) : null,
      width: video.videoWidth ?? 0,
      height: video.videoHeight ?? 0,
    };
  };

  // exportVideo drives the frame callback in order i = 0..total-1 -- BUT if the
  // worker path throws mid-run, exportVideo restarts the whole walk from i = 0 on
  // the main thread. A mutable frame counter would keep counting up across that
  // restart (pulling stale/exhausted decode frames), so we derive the frame index
  // from `time` instead: it is the exact inverse of the time exportVideo passes
  // (time = i / fps), so it resets to 0 on a restart and stays lock-stepped with
  // frameTimestamps[i]. Both the ImageBitmap path (renderFrame) and the fast
  // VideoFrame path (renderVideoFrame) go through drawOneFrame, so the pixels are
  // identical -- the only difference is the final snapshot (createImageBitmap vs a
  // VideoFrame built straight off the canvas).
  const drawOneFrame = async (time: number): Promise<void> => {
    const i = Math.round(time * fps);
    // Pull the two base regions AND every video overlay's decoded frame for this
    // output frame together. Every video overlay is pulled EVERY frame (its
    // decode source has its own cursor and MUST advance in lockstep with the
    // global frame index -- inactive frames are null timestamps it skips), so the
    // single-use iterators stay aligned. We only DRAW the overlays active at `i`.
    const overlayVideoPulls = overlaysByZ
      .filter((o) => o.kind === "video" && overlayVideos.has(o.id))
      .map(async (o) => {
        const st = overlayVideos.get(o.id)!;
        return { id: o.id, frame: await pullOverlayVideo(i, st) };
      });

    const [screenSrc, faceSrc, ...overlayVideoResults] = await Promise.all([
      pullRegionSource(
        i,
        screenDecode,
        () => screenVideo,
        (v) => { screenVideo = v; },
        footageMeta?.screenPath
      ),
      pullRegionSource(
        i,
        faceDecode,
        () => faceVideo,
        (v) => { faceVideo = v; },
        footageMeta?.faceCamPath
      ),
      ...overlayVideoPulls,
    ]);
    const overlayVideoFrames = new Map<string, DecodedFrame>();
    for (const r of overlayVideoResults) overlayVideoFrames.set(r.id, r.frame);

    const screenRegion: RegionSource = {
      source: screenSrc.source,
      sourceWidth: screenSrc.width,
      sourceHeight: screenSrc.height,
      // PER-SCENE screen framing (one static pan/zoom per scene, eased across
      // cuts by the Smart transition) -- the SAME screenFramingAt the preview
      // loop calls with the same output `time`, so the exported crop is
      // frame-identical to what Manthan framed per scene. Then fold in the mid-
      // clip zoom punch-in (screenPunch): the SAME punchScaleAt the preview loop
      // calls with the same output `time`, so the exported punch is frame-
      // identical. 1 outside the envelope = a no-op.
      transform: (() => {
        const base = screenFramingAt(clips, time);
        const p = punchScaleAt(clips, time, "screen");
        return p === 1 ? base : { ...base, scale: base.scale * p };
      })(),
      placeholderLabel: "SCREEN",
      filter: gradeFilter(screenGrade ?? "none"),
    };
    const faceRegion: RegionSource = {
      source: faceSrc.source,
      sourceWidth: faceSrc.width,
      sourceHeight: faceSrc.height,
      // PER-SCENE face framing (per-scene overrides + Smart-transition easing
      // resolved inside) -- the same faceFramingAt the preview loop calls with
      // the same output `time`, so the exported face crop is frame-identical.
      // Then fold in the face punch envelope identically (same punchScaleAt, same
      // output `time`) -> frame-identical to the preview.
      transform: (() => {
        const base = faceFramingAt(clips, time);
        const p = punchScaleAt(clips, time, "face");
        return p === 1 ? base : { ...base, scale: base.scale * p };
      })(),
      placeholderLabel: "FACE",
      filter: gradeFilter(faceGrade ?? "none"),
    };

    // Per-cut "Smart transition" MOTION for THIS output frame. Computed from the
    // SAME output-timeline `time` already fed to timelineToSourceTime (which
    // built frameTimestamps[i]) and the SAME `clips`, so the window position is
    // identical to the preview loop. The effect is INCOMING-only, so the frame
    // we already decoded/seeked (the incoming clip's source frame) is exactly
    // the frame the transition scales/slides -- no extra seek, no outgoing snapshot.
    const tp = transitionProgressAt(clips, time);

    // PER-SCENE split, eased across cuts -- the SAME splitRatioAt the preview
    // loop uses with the SAME output `time`, so the exported seam is identical
    // to what Manthan framed per scene (a tucked-up face on one scene, more room
    // on the next). `splitRatio` is the global default fallback.
    const frameSplit = splitRatioAt(clips, time, splitRatio);

    // FREE-FLOATING OVERLAYS -- resolve every overlay active at this output frame
    // into an OverlayDraw the compositor draws ON TOP of the base composite,
    // bottom-to-top by zIndex. Built from the SAME z-sorted list + half-open
    // window filter the preview uses, so preview == export. Images use their
    // cached ImageBitmap; videos use the frame pulled above. A source that isn't
    // ready yet (missing bitmap / no decoded video frame) is skipped this frame
    // -- never a black rectangle (no-blank-first-frame convention).
    const overlayDraws: OverlayDraw[] = [];
    for (const o of overlaysByZ) {
      if (!overlayActiveAt(o, i)) continue;
      if (o.kind === "image") {
        const bitmap = overlayBitmaps.get(o.id);
        if (!bitmap) continue;
        overlayDraws.push({
          source: bitmap,
          naturalWidth: bitmap.width,
          naturalHeight: bitmap.height,
          transform: { ...o.transform, opacity: o.opacity },
          band: o.band,
        });
      } else {
        const df = overlayVideoFrames.get(o.id);
        if (!df || !df.source || df.width <= 0 || df.height <= 0) continue;
        overlayDraws.push({
          source: df.source,
          naturalWidth: df.width,
          naturalHeight: df.height,
          transform: { ...o.transform, opacity: o.opacity },
          band: o.band,
        });
      }
    }

    drawFrame(ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, {
      screen: screenRegion,
      face: faceRegion,
      splitRatio: frameSplit,
      width: OUT_WIDTH,
      height: OUT_HEIGHT,
      // Overlays composited on top of the base regions, ascending z (index 0
      // bottom-most). Empty array is a strict no-op. Overlays are the LAST thing
      // drawFrame paints; captions then draw AFTER this drawFrame call (below),
      // so text always stays above every overlay. Do not move the drawCaptions
      // call before this one.
      overlays: overlayDraws,
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
    // composites above them. INVARIANT (do not reorder): this drawCaptions call
    // MUST stay the last draw of the frame, strictly after the drawFrame above
    // (base regions -> divider -> every overlay) and before the bitmap/VideoFrame
    // is snapshotted. Overlays are the last thing drawFrame paints, so keeping
    // captions here guarantees burned-in text sits above the split video AND every
    // media overlay -- and in the export there is no DOM layer, so captions are
    // truly on top of everything. Same drawCaptions the preview calls in the SAME
    // order, so what you see is what you export. Word timings are SOURCE seconds
    // -> map `time`.
    if (captionsEnabled && captionStyle && captionBlocks?.length) {
      const srcT = timelineToSourceTime(clips, time);
      drawCaptions(ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, {
        style: captionStyle,
        blocks: captionBlocks,
        srcT,
        width: OUT_WIDTH,
        height: OUT_HEIGHT,
        // Pin to the PER-SCENE eased seam so pinned captions ride the same split
        // the frame was drawn with -- export matches the preview exactly.
        splitRatio: frameSplit,
      });
    }

  };

  // Default path: snapshot the composited canvas to an ImageBitmap (the worker
  // then wraps it in a VideoFrame). Kept as the fallback when the fast path is
  // unavailable (e.g. VideoFrame ctor missing).
  const renderFrame = async (time: number): Promise<ImageBitmap> => {
    await drawOneFrame(time);
    return createImageBitmap(canvas as CanvasImageSource);
  };

  // Fast path: build a VideoFrame directly off the OffscreenCanvas with the
  // encoder's timestamp/duration -- skips createImageBitmap AND the worker's
  // VideoFrame(bitmap) copy (one full-frame alloc + copy removed per frame).
  // Pixels are identical to renderFrame (same drawOneFrame). Only used when no
  // watermark is requested (this export never watermarks).
  const canBuildVideoFrame = typeof VideoFrame !== "undefined";
  const renderVideoFrame = async (
    _time: number,
    timestampUs: number,
    durationUs: number
  ): Promise<VideoFrame> => {
    await drawOneFrame(_time);
    return new VideoFrame(canvas as CanvasImageSource, {
      timestamp: timestampUs,
      duration: durationUs,
    });
  };

  // ── 1. Video-only encode (existing hardened pipeline) ────────────────────
  let videoResult;
  try {
    videoResult = await exportVideo({
      width: OUT_WIDTH,
      height: OUT_HEIGHT,
      fps,
      duration,
      quality: "high",
      onProgress: onProgress ?? (() => {}),
      renderFrame,
      // Fast path when the browser supports building a VideoFrame from a canvas.
      ...(canBuildVideoFrame ? { renderVideoFrame } : {}),
      // H.264 for broad editor compatibility (Descript etc.).
      forceH264: true,
    });
  } finally {
    // Release the WebCodecs decoders + their inputs regardless of outcome --
    // the two base tracks AND every video overlay's isolated decode source.
    await Promise.all([
      screenDecode?.dispose() ?? Promise.resolve(),
      faceDecode?.dispose() ?? Promise.resolve(),
      ...[...overlayVideos.values()].map(
        (st) => st.decode?.dispose() ?? Promise.resolve()
      ),
    ]);
    // Close every decoded overlay ImageBitmap so its backing memory is freed
    // (many overlays => many bitmaps; leaving them open leaks GPU/heap memory).
    for (const bitmap of overlayBitmaps.values()) bitmap.close();
    overlayBitmaps.clear();
  }

  // ── 2 + 3. Assemble face-cam audio (+ mix SFX) and mux it into the MP4 ────
  let finalBlob = videoResult.blob;
  try {
    let audioBuffer = await assembleClipAudio(
      footageMeta?.faceCamPath,
      clips,
      duration
    );
    // Additively mix the manual BACKGROUND-MUSIC bed on top of the face-cam audio
    // (or, when the face-cam had no audio, onto a fresh silent bed so a music-only
    // reel still carries sound). Unlike the SFX bed it starts at OUTPUT time
    // `startAtSec`, not 0. Best-effort: on any failure this returns the untouched
    // buffer -- music must never fail the whole export. Both music and SFX are
    // additive, so the mix order between them doesn't matter.
    if (musicTrack) {
      audioBuffer = await mixMusicIntoBuffer(audioBuffer, musicTrack, duration);
    }
    // Additively mix the generated SFX bed on top of the face-cam audio (or,
    // when the face-cam had no audio, onto a fresh silent bed so an SFX-only
    // reel still carries sound). Best-effort: on any failure this returns the
    // untouched face-cam buffer -- SFX must never fail the whole export.
    if (sfxTrack) {
      audioBuffer = await mixSfxIntoBuffer(audioBuffer, sfxTrack, duration);
    }
    if (audioBuffer) {
      finalBlob = await muxAudioIntoMp4(videoResult.blob, audioBuffer, fps);
    } else {
      console.warn(
        "exportShort: face-cam has no decodable audio track -- shipping silent video."
      );
    }
  } catch (err) {
    // Never fail the whole export because audio muxing hit a snag -- ship the
    // (silent) picture we already encoded and surface why.
    console.warn(
      "exportShort: audio mux failed, shipping silent video instead:",
      err
    );
    finalBlob = videoResult.blob;
  }

  // If we produced a distinct (muxed) blob, the old video-only URL is dead.
  if (finalBlob !== videoResult.blob) {
    URL.revokeObjectURL(videoResult.url);
  }

  // Only save to disk when asked (the default). The smooth in-editor preview
  // passes download:false -- it just wants the blob URL to feed a <video>, with
  // no save dialog and no file written (that caller owns revoking the url).
  // The download path never reads the returned url, so revoke instead of
  // minting: leaving it live pins the full multi-hundred-MB MP4 blob in memory
  // for the rest of the session, once per export.
  if (download) {
    await downloadBlob(finalBlob, fileName);
    if (finalBlob === videoResult.blob) URL.revokeObjectURL(videoResult.url);
    return { url: "", blob: finalBlob };
  }
  const url =
    finalBlob === videoResult.blob ? videoResult.url : URL.createObjectURL(finalBlob);
  return { url, blob: finalBlob };
}

// ===========================================================================
// AUDIO ASSEMBLY
// ===========================================================================

/**
 * Decode the face-cam audio for every kept clip's SOURCE range and lay those
 * samples into a single output AudioBuffer at each clip's OUTPUT position --
 * i.e. the exact source->output map the video frame-walk uses. Returns null
 * when there is no usable audio (no path, no audio track, or Web Audio /
 * mediabunny unavailable) so the caller can fall back to a silent export.
 */
async function assembleClipAudio(
  faceCamPath: string | undefined,
  clips: readonly Clip[],
  duration: number
): Promise<AudioBuffer | null> {
  if (!faceCamPath) return null;
  if (typeof AudioBuffer === "undefined") return null;

  const OfflineCtx =
    (typeof OfflineAudioContext !== "undefined" && OfflineAudioContext) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext) ||
    null;
  if (!OfflineCtx) return null;

  const { Input, UrlSource, ALL_FORMATS, AudioBufferSink } = await import("mediabunny");

  const input = new Input({ source: new UrlSource(faceCamPath), formats: ALL_FORMATS });
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) return null;
    if (!(await audioTrack.canDecode())) return null;

    const sampleRate = audioTrack.sampleRate;
    const numberOfChannels = Math.max(1, audioTrack.numberOfChannels);
    const totalFrames = Math.max(1, Math.ceil(duration * sampleRate));

    // The scratch context defines the assembled buffer's channel/rate layout.
    const outCtx = new OfflineCtx(numberOfChannels, totalFrames, sampleRate);
    const out = outCtx.createBuffer(numberOfChannels, totalFrames, sampleRate);

    const sink = new AudioBufferSink(audioTrack);

    let wroteAny = false;
    for (const clip of clips) {
      if (!clip.kept) continue;
      const srcStart = clip.srcStart;
      const srcEnd = clip.srcEnd;
      if (srcEnd <= srcStart) continue;

      // Iterate decoded buffers overlapping this clip's SOURCE range and copy
      // only the overlapping slice into the OUTPUT position.
      for await (const { buffer, timestamp } of sink.buffers(srcStart, srcEnd)) {
        const bufStart = timestamp;
        const bufEnd = timestamp + buffer.duration;

        // Overlap of [bufStart, bufEnd] with the clip's [srcStart, srcEnd].
        const clipFrom = Math.max(bufStart, srcStart);
        const clipTo = Math.min(bufEnd, srcEnd);
        if (clipTo <= clipFrom) continue;

        // Sample offsets inside the decoded buffer for the overlap slice.
        const readOffset = Math.round((clipFrom - bufStart) * sampleRate);
        const copyLen = Math.round((clipTo - clipFrom) * sampleRate);
        if (copyLen <= 0) continue;

        // Where in the OUTPUT this slice lands: the clip's timelineStart plus
        // the slice's offset from the clip's srcStart.
        const outStartSec = clip.timelineStart + (clipFrom - srcStart);
        const writeOffset = Math.round(outStartSec * sampleRate);
        if (writeOffset >= totalFrames) continue;

        const clampedLen = Math.min(
          copyLen,
          totalFrames - writeOffset,
          buffer.length - readOffset
        );
        if (clampedLen <= 0) continue;

        for (let ch = 0; ch < numberOfChannels; ch++) {
          // If the decoded buffer has fewer channels than the output, reuse
          // channel 0 (mono -> stereo). If it has more, take the first N.
          const srcCh = ch < buffer.numberOfChannels ? ch : 0;
          const srcData = buffer.getChannelData(srcCh);
          const dstData = out.getChannelData(ch);
          for (let i = 0; i < clampedLen; i++) {
            dstData[writeOffset + i] += srcData[readOffset + i];
          }
        }
        wroteAny = true;
      }
    }

    return wroteAny ? out : null;
  } finally {
    // Input is disposable; release its underlying reader.
    try {
      await (input as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Additively mix the reel's generated SFX WAV into the assembled face-cam
 * buffer and return the (possibly newly-created) result.
 *
 *  - When `base` exists, the SFX is decoded, resampled to the base buffer's
 *    sampleRate + channel layout AND gained (all in one OfflineAudioContext
 *    render pass), then summed into a copy of the base per channel.
 *  - When `base` is null (face-cam had no audio), a fresh silent bed sized
 *    `duration` at 48000/2ch is created so an SFX-only reel still exports.
 *  - After summing, every touched sample is HARD-CLAMPED to [-1, 1] (additive
 *    mixing can push VO + SFX past full-scale; there is no limiter upstream).
 *
 * The SFX bed is already full output-length (0..duration), so it lands at
 * output sample offset 0. Best-effort: any decode/resample failure logs a
 * warning and returns `base` unchanged so SFX never fails the export.
 */
async function mixSfxIntoBuffer(
  base: AudioBuffer | null,
  sfxTrack: SfxTrack,
  duration: number
): Promise<AudioBuffer | null> {
  if (typeof AudioBuffer === "undefined") return base;

  const OfflineCtx =
    (typeof OfflineAudioContext !== "undefined" && OfflineAudioContext) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext) ||
    null;
  if (!OfflineCtx) return base;

  try {
    // Target layout: match the face-cam bed when present so summing is 1:1;
    // otherwise a sane stereo/48k default for an SFX-only export.
    const targetRate = base ? base.sampleRate : 48000;
    const targetChannels = base ? base.numberOfChannels : 2;
    const targetFrames = base
      ? base.length
      : Math.max(1, Math.ceil(duration * targetRate));

    // Fetch + decode the SFX WAV. Decode happens at the file's own rate; the
    // render pass below resamples it to targetRate.
    const res = await fetch(sfxTrack.src);
    if (!res.ok) {
      console.warn(
        `mixSfxIntoBuffer: SFX fetch failed (${res.status}) -- shipping without SFX.`
      );
      return base;
    }
    const sfxBytes = await res.arrayBuffer();

    // decodeAudioData wants its own context; a tiny scratch ctx at the target
    // rate is fine -- decodeAudioData ignores the ctx rate and decodes at the
    // file's native rate (the render pass does the actual resample).
    const decodeCtx = new OfflineCtx(1, 1, targetRate);
    const decoded = await decodeCtx.decodeAudioData(sfxBytes);

    // ONE pass: resample decoded -> targetRate AND apply the track's gain.
    const render = new OfflineCtx(
      targetChannels,
      targetFrames,
      targetRate
    );
    const srcNode = render.createBufferSource();
    srcNode.buffer = decoded;
    const g = render.createGain();
    g.gain.value = sfxTrack.gain;
    srcNode.connect(g).connect(render.destination);
    srcNode.start(0);
    const resampled = await render.startRendering();

    // Output = a copy of the base bed (or a fresh silent bed) so we never
    // mutate the assembled face-cam buffer in place.
    const outCtx = new OfflineCtx(targetChannels, targetFrames, targetRate);
    const out = outCtx.createBuffer(targetChannels, targetFrames, targetRate);
    if (base) {
      for (let ch = 0; ch < targetChannels; ch++) {
        out.getChannelData(ch).set(base.getChannelData(ch));
      }
    }

    // Additively sum the resampled+gained SFX into the output, per channel,
    // starting at sample 0. mono SFX -> stereo out reuses channel 0 (mirrors
    // assembleClipAudio's mono->stereo fallback).
    const sumLen = Math.min(targetFrames, resampled.length);
    for (let ch = 0; ch < targetChannels; ch++) {
      const srcCh = ch < resampled.numberOfChannels ? ch : 0;
      const srcData = resampled.getChannelData(srcCh);
      const dstData = out.getChannelData(ch);
      for (let i = 0; i < sumLen; i++) {
        // Sum then HARD-CLAMP to [-1, 1] -- additive mix can exceed full scale.
        let v = dstData[i] + srcData[i];
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        dstData[i] = v;
      }
    }

    return out;
  } catch (err) {
    console.warn(
      "mixSfxIntoBuffer: SFX mix failed, shipping face-cam audio only:",
      err
    );
    return base;
  }
}

/**
 * Additively mix the reel's manual BACKGROUND-MUSIC file into the assembled
 * audio and return the (possibly newly-created) result. This mirrors
 * {@link mixSfxIntoBuffer} exactly EXCEPT the music lands at an OUTPUT-time
 * START OFFSET instead of at sample 0:
 *
 *  - When `base` exists, the music is decoded, resampled to the base buffer's
 *    sampleRate + channel layout AND gained (one OfflineAudioContext render
 *    pass), then summed into a copy of the base per channel starting at sample
 *    `round(musicTrack.startAtSec * sampleRate)`.
 *  - When `base` is null (face-cam had no audio and no SFX ran first), a fresh
 *    silent bed sized `duration` at 48000/2ch is created so a music-only reel
 *    still exports.
 *  - Only samples that land WITHIN the base buffer are written; music that runs
 *    past the reel end is clipped. After summing, every touched sample is HARD-
 *    CLAMPED to [-1, 1] (additive mix can exceed full scale; no limiter upstream).
 *
 * Best-effort: any decode/resample failure logs a warning and returns `base`
 * unchanged so music never fails the export.
 */
async function mixMusicIntoBuffer(
  base: AudioBuffer | null,
  musicTrack: MusicTrack,
  duration: number
): Promise<AudioBuffer | null> {
  if (typeof AudioBuffer === "undefined") return base;

  const OfflineCtx =
    (typeof OfflineAudioContext !== "undefined" && OfflineAudioContext) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext) ||
    null;
  if (!OfflineCtx) return base;

  try {
    // Target layout: match the base bed when present so summing is 1:1;
    // otherwise a sane stereo/48k default for a music-only export.
    const targetRate = base ? base.sampleRate : 48000;
    const targetChannels = base ? base.numberOfChannels : 2;
    const targetFrames = base
      ? base.length
      : Math.max(1, Math.ceil(duration * targetRate));

    // Fetch + decode the music file. Decode happens at the file's own rate; the
    // render pass below resamples it to targetRate.
    const res = await fetch(musicTrack.src);
    if (!res.ok) {
      console.warn(
        `mixMusicIntoBuffer: music fetch failed (${res.status}) -- shipping without music.`
      );
      return base;
    }
    const musicBytes = await res.arrayBuffer();

    const decodeCtx = new OfflineCtx(1, 1, targetRate);
    const decoded = await decodeCtx.decodeAudioData(musicBytes);

    // ONE pass: resample decoded -> targetRate AND apply the track's gain.
    const render = new OfflineCtx(targetChannels, targetFrames, targetRate);
    const srcNode = render.createBufferSource();
    srcNode.buffer = decoded;
    const g = render.createGain();
    g.gain.value = musicTrack.gain;
    srcNode.connect(g).connect(render.destination);
    srcNode.start(0);
    const resampled = await render.startRendering();

    // Output = a copy of the base bed (or a fresh silent bed) so we never
    // mutate the incoming buffer in place.
    const outCtx = new OfflineCtx(targetChannels, targetFrames, targetRate);
    const out = outCtx.createBuffer(targetChannels, targetFrames, targetRate);
    if (base) {
      for (let ch = 0; ch < targetChannels; ch++) {
        out.getChannelData(ch).set(base.getChannelData(ch));
      }
    }

    // Music begins at OUTPUT time `startAtSec` -- convert to a sample offset in
    // the output bed. A negative startAtSec is clamped to 0; an offset at/after
    // the reel end leaves the bed untouched (music never heard).
    const writeStart = Math.max(0, Math.round(musicTrack.startAtSec * targetRate));
    if (writeStart >= targetFrames) return out;

    // How many resampled samples fit between writeStart and the reel end -- clip
    // any music that runs past the end.
    const sumLen = Math.min(resampled.length, targetFrames - writeStart);
    for (let ch = 0; ch < targetChannels; ch++) {
      const srcCh = ch < resampled.numberOfChannels ? ch : 0;
      const srcData = resampled.getChannelData(srcCh);
      const dstData = out.getChannelData(ch);
      for (let i = 0; i < sumLen; i++) {
        // Sum then HARD-CLAMP to [-1, 1] -- additive mix can exceed full scale.
        let v = dstData[writeStart + i] + srcData[i];
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        dstData[writeStart + i] = v;
      }
    }

    return out;
  } catch (err) {
    console.warn(
      "mixMusicIntoBuffer: music mix failed, shipping audio without music:",
      err
    );
    return base;
  }
}

// ===========================================================================
// AUDIO MUX
// ===========================================================================

/**
 * Copy the encoded video packets out of a video-only MP4 and combine them with
 * an assembled AudioBuffer into a single new MP4 (video + audio). The audio is
 * encoded via a Mediabunny AudioBufferSource, which drives the WebCodecs
 * AudioEncoder internally. Returns the new MP4 blob.
 */
async function muxAudioIntoMp4(
  videoOnlyMp4: Blob,
  audioBuffer: AudioBuffer,
  fps: number
): Promise<Blob> {
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    Output,
    Mp4OutputFormat,
    BufferTarget,
    EncodedVideoPacketSource,
    EncodedPacketSink,
    AudioBufferSource,
    getFirstEncodableAudioCodec,
    QUALITY_HIGH,
  } = await import("mediabunny");

  const input = new Input({ source: new BlobSource(videoOnlyMp4), formats: ALL_FORMATS });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      // Nothing to remux against -- return the original.
      return videoOnlyMp4;
    }

    const decoderConfig = await videoTrack.getDecoderConfig();
    const videoCodec = videoTrack.codec;
    if (!decoderConfig || !videoCodec) {
      return videoOnlyMp4;
    }

    // Pick an audio codec the browser can actually encode with our layout.
    const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus"], {
      numberOfChannels: audioBuffer.numberOfChannels,
      sampleRate: audioBuffer.sampleRate,
    });
    if (!audioCodec) {
      return videoOnlyMp4;
    }

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    output.addVideoTrack(videoSource, { frameRate: fps });

    const audioSource = new AudioBufferSource({
      codec: audioCodec,
      bitrate: QUALITY_HIGH,
    });
    output.addAudioTrack(audioSource);

    await output.start();

    // Copy every encoded video packet, in decode order. The first packet
    // carries the decoder config (required by EncodedVideoPacketSource.add).
    const sink = new EncodedPacketSink(videoTrack);
    let first = true;
    for await (const packet of sink.packets()) {
      await videoSource.add(packet, first ? { decoderConfig } : undefined);
      first = false;
    }

    // Feed the assembled audio (starts at output timestamp 0).
    await audioSource.add(audioBuffer);

    await output.finalize();

    const buffer = target.buffer;
    if (!buffer) return videoOnlyMp4;
    return new Blob([buffer], { type: "video/mp4" });
  } finally {
    try {
      await (input as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    } catch {
      /* ignore */
    }
  }
}
