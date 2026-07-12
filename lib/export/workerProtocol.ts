/**
 * Shared typed message protocol for Encode Worker <-> Main Thread communication.
 *
 * This file has NO DOM or Worker-specific dependencies so it can be safely
 * imported from both contexts.
 *
 * Adapted from TiltIt's proven export pipeline for NotifyMotion.
 */

// ── Quality presets ──────────────────────────────────────

export type QualityPreset = "low" | "medium" | "high" | "max";

// ── Main Thread -> Worker Messages ──────────────────────

/** Initialize the Worker for MP4 export (VideoEncoder + Mediabunny). */
export interface InitVideoMessage {
  type: "init-video";
  config: {
    width: number;
    height: number;
    fps: number;
    quality: QualityPreset;
    duration: number;
    totalFrames: number;
    addWatermark: boolean;
    estimatedBytes: number;
    /** Pre-resolved codec string from main-thread probing. */
    resolvedCodec?: string;
  };
}

/** Initialize the Worker for GIF export (gifenc). */
export interface InitGifMessage {
  type: "init-gif";
  config: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    totalFrames: number;
    colors: 64 | 128 | 256;
    addWatermark: boolean;
  };
}

/**
 * Send a rendered frame to the Worker for encoding. Carry EITHER a `bitmap`
 * (ImageBitmap -- the default path, needed when a watermark must be composited)
 * OR an already-built `frame` (VideoFrame -- the fast path a caller uses when it
 * can hand the encoder a VideoFrame straight from its OffscreenCanvas, skipping
 * the createImageBitmap copy + the worker's own VideoFrame(bitmap) copy). Exactly
 * one is set; the worker prefers `frame` when present. Both are transferred
 * (zero-copy), not cloned.
 */
interface FrameMessage {
  type: "frame";
  frameIndex: number;
  /** Transferred (zero-copy), not copied. Set on the default (bitmap) path. */
  bitmap?: ImageBitmap;
  /**
   * Pre-built VideoFrame carrying its own timestamp/duration. Transferred
   * (zero-copy). Set on the fast path; when present the worker encodes it as-is
   * (no ImageBitmap round-trip). Not compatible with in-worker watermarking, so
   * callers that need a watermark send `bitmap` instead.
   */
  frame?: VideoFrame;
}

/** Tell the Worker to flush encoders and finalize the muxer. */
interface FinalizeMessage {
  type: "finalize";
}

/** Cancel the export. Worker should clean up and acknowledge. */
interface AbortMessage {
  type: "abort";
}

export type MainToWorkerMessage =
  | InitVideoMessage
  | InitGifMessage
  | FrameMessage
  | FinalizeMessage
  | AbortMessage;

// ── Worker -> Main Thread Messages ──────────────────────

/** Worker has initialized encoder/muxer and is ready to receive frames. */
interface ReadyMessage {
  type: "ready";
  codec: string;
}

/** Worker reports encoding progress after processing a frame. */
interface ProgressMessage {
  type: "progress";
  encodedFrames: number;
  totalFrames: number;
  encodeQueueSize: number;
}

/** Acknowledgment that a specific frame was consumed by the encoder. */
interface FrameAckMessage {
  type: "frame-ack";
  frameIndex: number;
  encodeQueueSize: number;
}

/** Export completed — final file transferred back as ArrayBuffer. */
interface CompleteMessage {
  type: "complete";
  buffer: ArrayBuffer;
  mimeType: string;
}

/** Worker encountered an error. */
interface ErrorMessage {
  type: "error";
  error: string;
  fatal: boolean;
}

/** Worker acknowledged the abort request and has cleaned up. */
interface AbortedMessage {
  type: "aborted";
}

export type WorkerToMainMessage =
  | ReadyMessage
  | ProgressMessage
  | FrameAckMessage
  | CompleteMessage
  | ErrorMessage
  | AbortedMessage;

// ── Backpressure Constants ──────────────────────────────

/**
 * Max frames queued in Worker's VideoEncoder before main thread pauses sending.
 * Prevents runaway memory usage.
 */
export const MAX_ENCODE_QUEUE_DEPTH = 8;

// ── Bitrate Constants ───────────────────────────────────

/** Base bitrate per quality at 1080p reference (2,073,600 pixels). */
export const BASE_BITRATE_1080P: Record<QualityPreset, number> = {
  low: 8_000_000, //  8 Mbps
  medium: 16_000_000, // 16 Mbps
  high: 28_000_000, // 28 Mbps
  max: 125_000_000, // 125 Mbps (maximum quality)
};

/** Maximum bitrate cap. */
export const MAX_BITRATE = 200_000_000;

export const REFERENCE_PIXELS = 1920 * 1080;

/**
 * H.264 codec strings in priority order (High -> Main -> Baseline).
 * Level 6.2 supports up to 240 Mbps, 4K@120fps.
 */
export const H264_CODEC_STRINGS = [
  "avc1.640033", // High Profile Level 5.1 (4K@30fps, best hw compat)
  "avc1.640028", // High Profile Level 4.0 (1080p@30fps)
  "avc1.4d0028", // Main Profile Level 4.0
  "avc1.42001e", // Baseline Profile Level 3.0
  "avc1.64003E", // High Profile Level 6.2 (last resort -- hw often rejects)
] as const;

/**
 * HEVC/H.265 codec strings — ~50% better compression than H.264.
 */
export const HEVC_CODEC_STRINGS = [
  "hvc1.1.6.L153.B0", // Main Profile Level 5.1 (4K)
  "hvc1.1.6.L120.B0", // Main Profile Level 4.0 (1080p)
] as const;

/** Check if a codec string is HEVC. */
export function isHevcCodec(codec: string): boolean {
  return codec.startsWith("hvc1") || codec.startsWith("hev1");
}

/** Stream target threshold: use StreamTarget for files >100MB. */
export const STREAM_TARGET_THRESHOLD = 100 * 1024 * 1024;
