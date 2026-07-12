/**
 * Video Exporter - Orchestrates Canvas frame rendering + Worker encoding.
 *
 * Flow:
 * 1. User clicks Export -> opens modal
 * 2. Probe codec support (HEVC -> H.264 fallback)
 * 3. For each frame: render Canvas -> ImageBitmap -> transfer to Worker
 * 4. Worker encodes with VideoEncoder + Mediabunny muxer
 * 5. Return Blob for download
 *
 * Adapted from TiltIt's production export pipeline.
 */

import {
  EncodeWorkerBridge,
  isWorkerEncodingSupported,
  type WorkerProgressInfo,
} from "./workerBridge";
import {
  BASE_BITRATE_1080P,
  MAX_BITRATE,
  REFERENCE_PIXELS,
  H264_CODEC_STRINGS,
  HEVC_CODEC_STRINGS,
  type QualityPreset,
} from "./workerProtocol";
import { applyWatermarkToBitmap } from "./watermark";

// ── Public types ──────────────────────────────────────────

export interface ExportProgress {
  status: "preparing" | "rendering" | "encoding" | "complete" | "error";
  progress: number; // 0-100
  currentFrame: number;
  totalFrames: number;
  encodedFrames?: number;
}

export interface VideoExportOptions {
  width: number;
  height: number;
  fps: number;
  duration: number; // seconds
  quality: QualityPreset;
  onProgress: (progress: ExportProgress) => void;
  /** Render a single animation frame at the given time. Returns an ImageBitmap. */
  renderFrame: (time: number) => Promise<ImageBitmap>;
  /**
   * FAST PATH (optional): render a frame straight into a VideoFrame carrying the
   * given timestamp/duration (microseconds), skipping the createImageBitmap copy
   * AND the worker's own VideoFrame(bitmap) copy -- one full-frame allocation +
   * copy removed per frame. Used by the worker path ONLY when set and no
   * watermark is requested (a watermark needs a re-drawable bitmap). When unset,
   * or when watermarking, the exporter falls back to `renderFrame` + ImageBitmap.
   * The returned VideoFrame's ownership passes to the exporter (transferred to
   * the worker, which closes it) -- the caller must not reuse it.
   */
  renderVideoFrame?: (
    time: number,
    timestampUs: number,
    durationUs: number
  ) => Promise<VideoFrame>;
  abortSignal?: AbortSignal;
  addWatermark?: boolean;
  /** Force H.264 codec (skip HEVC probe). Better compatibility with editors like Descript. */
  forceH264?: boolean;
}

export interface ExportResult {
  blob: Blob;
  url: string;
}

// ── Feature detection ─────────────────────────────────────

export function isWebCodecsSupported(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoFrame !== "undefined"
  );
}

// ── Bitrate helpers ───────────────────────────────────────

export function getBitrateForDimensions(
  quality: QualityPreset,
  width: number,
  height: number
): number {
  const pixels = Math.max(1, width * height);
  const scale = pixels / REFERENCE_PIXELS;
  return Math.min(
    Math.round(BASE_BITRATE_1080P[quality] * scale),
    MAX_BITRATE
  );
}

/** Estimate file size in bytes for the given export config. */
export function getEstimatedFileSize(
  quality: QualityPreset,
  width: number,
  height: number,
  duration: number
): number {
  const bitrate = getBitrateForDimensions(quality, width, height);
  // VBR compression factor (~70% of nominal bitrate)
  const compressionFactor = 0.7;
  const rawBytes = (bitrate * duration) / 8;
  // Add 5% for MP4 container overhead
  return Math.round(rawBytes * compressionFactor * 1.05);
}

/** Human-readable file size. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Codec probing (main thread) ───────────────────────────

async function probeVideoCodec(
  width: number,
  height: number,
  bitrate: number,
  fps: number,
  forceH264 = false
): Promise<string | null> {
  if (!isWebCodecsSupported()) return null;

  // Probe HEVC first (better compression) -- skip if forceH264
  if (forceH264) {
    // Skip HEVC, go straight to H.264
  } else
  for (const codec of HEVC_CODEC_STRINGS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        hevc: { format: "hevc" as const },
      } as VideoEncoderConfig);
      if (support.supported) return codec;
    } catch {
      continue;
    }
  }

  // Fallback to H.264
  for (const codec of H264_CODEC_STRINGS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });
      if (support.supported) return codec;
    } catch {
      continue;
    }
  }

  return null;
}

// ── Worker-based MP4 export ───────────────────────────────

async function exportVideoWithWorker(
  options: VideoExportOptions
): Promise<ExportResult> {
  const {
    width,
    height,
    fps,
    duration,
    quality,
    onProgress,
    renderFrame,
    renderVideoFrame,
    abortSignal,
    addWatermark = false,
    forceH264 = false,
  } = options;

  // Fast path is only valid when the caller can render a VideoFrame AND no
  // watermark is needed (a watermark must be composited onto a re-drawable
  // bitmap). Otherwise fall back to the ImageBitmap path.
  const useVideoFrameFastPath = Boolean(renderVideoFrame) && !addWatermark;

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const bitrate = getBitrateForDimensions(quality, width, height);
  const estimatedBytes = getEstimatedFileSize(quality, width, height, duration);

  onProgress({
    status: "preparing",
    progress: 0,
    currentFrame: 0,
    totalFrames,
  });

  if (abortSignal?.aborted) {
    throw new DOMException("Export aborted", "AbortError");
  }

  // Pre-probe codec on main thread (saves Worker a redundant probe)
  const resolvedCodec = await probeVideoCodec(width, height, bitrate, fps, forceH264);

  const bridge = new EncodeWorkerBridge();

  try {
    await bridge.initVideo(
      {
        width,
        height,
        fps,
        quality,
        duration,
        totalFrames,
        addWatermark,
        estimatedBytes,
        resolvedCodec: resolvedCodec ?? undefined,
      },
      {
        onProgress: (info: WorkerProgressInfo) => {
          const pct = Math.round(
            (info.encodedFrames / info.totalFrames) * 90
          );
          onProgress({
            status: "rendering",
            progress: pct,
            currentFrame: info.encodedFrames,
            totalFrames: info.totalFrames,
            encodedFrames: info.encodedFrames,
          });
        },
        abortSignal,
      }
    );

    onProgress({
      status: "rendering",
      progress: 0,
      currentFrame: 0,
      totalFrames,
    });

    // Render and send each frame
    for (let i = 0; i < totalFrames; i++) {
      if (abortSignal?.aborted) {
        throw new DOMException("Export aborted", "AbortError");
      }

      const time = i / fps;

      if (useVideoFrameFastPath) {
        // FAST PATH: hand the worker a ready VideoFrame (no ImageBitmap copy).
        // Stamp it with the same timestamp/duration math the worker used before,
        // so encoded timing is byte-identical to the bitmap path.
        const timestampUs = Math.round((i * 1_000_000) / fps);
        const nextUs = Math.round(((i + 1) * 1_000_000) / fps);
        const frame = await renderVideoFrame!(time, timestampUs, nextUs - timestampUs);
        await bridge.sendVideoFrame(i, frame);
      } else {
        const bitmap = await renderFrame(time);
        // Transfer bitmap to Worker (zero-copy)
        await bridge.sendFrame(i, bitmap);
      }

      onProgress({
        status: "rendering",
        progress: Math.round(((i + 1) / totalFrames) * 85),
        currentFrame: i + 1,
        totalFrames,
      });
    }

    onProgress({
      status: "encoding",
      progress: 90,
      currentFrame: totalFrames,
      totalFrames,
    });

    // Finalize: flush encoder + mux into MP4
    const result = await bridge.finalize();

    const blob = new Blob([result.buffer], { type: result.mimeType });
    const url = URL.createObjectURL(blob);

    onProgress({
      status: "complete",
      progress: 100,
      currentFrame: totalFrames,
      totalFrames,
    });

    return { blob, url };
  } finally {
    bridge.dispose();
  }
}

// ── Main-thread fallback MP4 export ───────────────────────

async function exportVideoMainThread(
  options: VideoExportOptions
): Promise<ExportResult> {
  const {
    width,
    height,
    fps,
    duration,
    quality,
    onProgress,
    renderFrame,
    abortSignal,
    addWatermark = false,
    forceH264 = false,
  } = options;

  if (!isWebCodecsSupported()) {
    throw new Error(
      "WebCodecs API not supported in this browser. Please use Chrome 94+ or Edge 94+."
    );
  }

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const bitrate = getBitrateForDimensions(quality, width, height);

  // Even dimensions
  const safeWidth = width % 2 === 0 ? width : width + 1;
  const safeHeight = height % 2 === 0 ? height : height + 1;

  onProgress({
    status: "preparing",
    progress: 0,
    currentFrame: 0,
    totalFrames,
  });

  // Probe codec
  const resolvedCodec = await probeVideoCodec(
    safeWidth,
    safeHeight,
    bitrate,
    fps,
    forceH264
  );
  if (!resolvedCodec) {
    throw new Error("No supported video codec found.");
  }

  // Import mediabunny dynamically for main-thread fallback
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    EncodedVideoPacketSource,
    EncodedPacket,
  } = await import("mediabunny");

  const target = new BufferTarget();
  const format = new Mp4OutputFormat({ fastStart: "in-memory" });
  const output = new Output({ format, target });

  const codecIsHevc =
    resolvedCodec.startsWith("hvc1") || resolvedCodec.startsWith("hev1");
  const videoSource = new EncodedVideoPacketSource(
    codecIsHevc ? "hevc" : "avc"
  );
  output.addVideoTrack(videoSource, { frameRate: fps });
  await output.start();

  let encoder = new VideoEncoder({
    output: (chunk, meta) => {
      videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta);
    },
    error: (err) => {
      console.error("VideoEncoder error:", err);
    },
  });

  // configure() can throw OperationError even when isConfigSupported() passed.
  // Hardware encoders on macOS (VideoToolbox) may reject configs due to:
  // portrait resolution constraints, bitrate limits, concurrent session caps,
  // or H.264 level mismatches. Retry with progressively safer codecs.
  try {
    encoder.configure({
      codec: resolvedCodec,
      width: safeWidth,
      height: safeHeight,
      bitrate,
      bitrateMode: "variable",
      framerate: fps,
      latencyMode: "quality",
      hardwareAcceleration: "no-preference",
      ...(codecIsHevc
        ? { hevc: { format: "hevc" as const } }
        : { avc: { format: "avc" as const } }),
    } as VideoEncoderConfig);
  } catch (configErr) {
    try { encoder.close(); } catch { /* ignore */ }

    const fallbackCodecs = [
      "avc1.640033", // High Profile Level 5.1
      "avc1.640028", // High Profile Level 4.0
      "avc1.4d0028", // Main Profile Level 4.0
    ].filter((c) => c !== resolvedCodec);

    let fallbackOk = false;
    for (const fbCodec of fallbackCodecs) {
      try {
        const fbConfig: VideoEncoderConfig = {
          codec: fbCodec,
          width: safeWidth,
          height: safeHeight,
          bitrate: Math.min(bitrate, 40_000_000), // cap for hw compat
          bitrateMode: "variable",
          framerate: fps,
          latencyMode: "quality",
          hardwareAcceleration: "no-preference",
          avc: { format: "avc" as const },
        };
        const fbSupport = await VideoEncoder.isConfigSupported(fbConfig);
        if (!fbSupport.supported) continue;

        encoder = new VideoEncoder({
          output: (chunk, meta) => {
            videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta);
          },
          error: (err) => {
            console.error("VideoEncoder error:", err);
          },
        });
        encoder.configure(fbConfig);
        fallbackOk = true;
        break;
      } catch {
        continue;
      }
    }

    if (!fallbackOk) {
      throw new Error(
        `Encoder creation failed after trying ${fallbackCodecs.length + 1} codecs. ` +
        `Original: ${configErr instanceof Error ? configErr.message : String(configErr)}`
      );
    }
  }

  onProgress({
    status: "rendering",
    progress: 0,
    currentFrame: 0,
    totalFrames,
  });

  for (let i = 0; i < totalFrames; i++) {
    if (abortSignal?.aborted) {
      encoder.close();
      throw new DOMException("Export aborted", "AbortError");
    }

    const time = i / fps;
    let bitmap = await renderFrame(time);

    // Apply watermark for free tier exports
    if (addWatermark) {
      const watermarked = await applyWatermarkToBitmap(bitmap);
      bitmap.close();
      bitmap = watermarked;
    }

    const frameTimestampUs = Math.round((i * 1_000_000) / fps);
    const nextTimestampUs = Math.round(((i + 1) * 1_000_000) / fps);

    const videoFrame = new VideoFrame(bitmap, {
      timestamp: frameTimestampUs,
      duration: nextTimestampUs - frameTimestampUs,
    });

    const keyFrameInterval = Math.max(1, Math.round(fps));
    encoder.encode(videoFrame, {
      keyFrame: i % keyFrameInterval === 0,
    });
    videoFrame.close();

    onProgress({
      status: "rendering",
      progress: Math.round(((i + 1) / totalFrames) * 85),
      currentFrame: i + 1,
      totalFrames,
    });

    // Yield to event loop every 5 frames
    if (i % 5 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress({
    status: "encoding",
    progress: 90,
    currentFrame: totalFrames,
    totalFrames,
  });

  await encoder.flush();
  encoder.close();

  videoSource.close();
  await output.finalize();

  const buffer = target.buffer!;
  const blob = new Blob([buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);

  onProgress({
    status: "complete",
    progress: 100,
    currentFrame: totalFrames,
    totalFrames,
  });

  return { blob, url };
}

// ── Export facade ─────────────────────────────────────────

/**
 * Export animation as MP4 video.
 *
 * Tries Worker-based encoding first (off-main-thread, better performance).
 * Falls back to main-thread encoding if Worker fails.
 */
export async function exportVideo(
  options: VideoExportOptions
): Promise<ExportResult> {
  if (isWorkerEncodingSupported()) {
    try {
      return await exportVideoWithWorker(options);
    } catch (err) {
      // Re-throw user aborts
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      console.warn(
        "Worker video export failed, falling back to main thread:",
        err
      );
    }
  }

  return exportVideoMainThread(options);
}

/**
 * Trigger browser download of a Blob with a guaranteed filename.
 *
 * Primary: File System Access API (showSaveFilePicker) -- guarantees the
 * filename in ALL Chrome profiles, including guest/unauthenticated.
 * Fallback: blob URL + anchor download attribute.
 *
 * The previous data-URL approach broke in Chrome guest profiles where
 * data: URL downloads silently ignore the `download` attribute, causing
 * Chrome to use the blob UUID as the filename.
 */
export async function downloadBlob(
  blob: Blob,
  filename: string
): Promise<void> {
  // ── Primary: File System Access API ──────────────────────
  // Available in all Chromium browsers (incl. guest profiles).
  // Shows a native save dialog with the correct suggested filename.
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    try {
      const ext = filename.split(".").pop() || "mp4";
      const mimeType = blob.type || "video/mp4";
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
            types: { description: string; accept: Record<string, string[]> }[];
          }) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: `${ext.toUpperCase()} file`,
            accept: { [mimeType]: [`.${ext}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: unknown) {
      // User cancelled the save dialog -- don't fall through
      if (err instanceof DOMException && err.name === "AbortError") return;
      // API unavailable or other error -- fall through to blob URL
    }
  }

  // ── Fallback: blob URL + anchor ──────────────────────────
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      document.body.removeChild(a);
    } catch {
      /* already removed */
    }
    URL.revokeObjectURL(url);
  }, 60_000);
}
