/// <reference lib="webworker" />

/**
 * Encode Worker - runs VideoEncoder + Mediabunny (or gifenc) off the main thread.
 *
 * Receives rendered ImageBitmaps from the main thread, applies watermark,
 * encodes to H.264 (MP4) or quantized palette (GIF), and returns the
 * final file as a transferable ArrayBuffer.
 *
 * Adapted from TiltIt's production export Worker.
 */

import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  StreamTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
} from "mediabunny";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import {
  applyWatermarkToBitmap,
  preloadWatermark,
  disposeWatermarkOverlay,
} from "./watermark";
import {
  BASE_BITRATE_1080P,
  MAX_BITRATE,
  REFERENCE_PIXELS,
  H264_CODEC_STRINGS,
  HEVC_CODEC_STRINGS,
  isHevcCodec,
  STREAM_TARGET_THRESHOLD,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
  type InitVideoMessage,
  type InitGifMessage,
} from "./workerProtocol";

// ── Typed postMessage helper ──────────────────────────────

function send(msg: WorkerToMainMessage, transfer?: Transferable[]): void {
  if (transfer) {
    self.postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

// ── Worker state ──────────────────────────────────────────

let mode: "video" | "gif" | null = null;
let aborted = false;

// Video mode state
let videoEncoder: VideoEncoder | null = null;
let output: Output | null = null;
let videoSource: EncodedVideoPacketSource | null = null;
let muxerIsStreaming = false;
let muxerChunks: Uint8Array[] = [];
let videoFps = 30;
let videoTotalFrames = 0;
let videoEncodedFrames = 0;

// GIF mode state
let gifEncoder: ReturnType<typeof GIFEncoder> | null = null;
let gifCanvas: OffscreenCanvas | null = null;
let gifCtx: OffscreenCanvasRenderingContext2D | null = null;
let gifWidth = 0;
let gifHeight = 0;
let gifColors: 64 | 128 | 256 = 256;
let gifDelayMs = 100;
let gifTotalFrames = 0;
let gifEncodedFrames = 0;

// Shared
let watermarkEnabled = false;

// ── Codec probing ─────────────────────────────────────────

async function getSupportedVideoCodec(
  width: number,
  height: number,
  bitrate: number,
  fps: number
): Promise<string | null> {
  // Probe HEVC first (better compression)
  for (const codec of HEVC_CODEC_STRINGS) {
    try {
      const config = {
        codec,
        width,
        height,
        framerate: fps,
        latencyMode: "quality" as const,
        hardwareAcceleration: "no-preference" as const,
        hevc: { format: "hevc" as const },
        bitrate,
        bitrateMode: "variable" as const,
      } as VideoEncoderConfig;
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return codec;
    } catch {
      continue;
    }
  }

  // Fallback to H.264
  for (const codec of H264_CODEC_STRINGS) {
    try {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        framerate: fps,
        latencyMode: "quality",
        hardwareAcceleration: "no-preference",
        avc: { format: "avc" as const },
        bitrate,
        bitrateMode: "variable" as const,
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return codec;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Muxer target selection ────────────────────────────────

function createMuxerTarget(
  estimatedBytes: number
): BufferTarget | StreamTarget {
  if (estimatedBytes > STREAM_TARGET_THRESHOLD) {
    muxerChunks = [];
    const target = new StreamTarget(
      new WritableStream({
        write(chunk) {
          muxerChunks.push(new Uint8Array(chunk.data));
        },
      }),
      { chunked: true, chunkSize: 16 * 1024 * 1024 }
    );
    muxerIsStreaming = true;
    return target;
  }

  muxerIsStreaming = false;
  muxerChunks = [];
  return new BufferTarget();
}

async function targetToArrayBuffer(): Promise<ArrayBuffer> {
  if (muxerIsStreaming) {
    const blob = new Blob(muxerChunks as BlobPart[], { type: "video/mp4" });
    muxerChunks.length = 0;
    return await blob.arrayBuffer();
  }
  return (output!.target as BufferTarget).buffer!;
}

// ── Cleanup ───────────────────────────────────────────────

function cleanup(): void {
  if (videoEncoder && videoEncoder.state !== "closed") {
    try {
      videoEncoder.close();
    } catch {
      /* ignore */
    }
  }
  videoEncoder = null;
  output = null;
  videoSource = null;
  muxerChunks.length = 0;
  muxerIsStreaming = false;
  videoFps = 30;
  videoTotalFrames = 0;
  videoEncodedFrames = 0;

  gifEncoder = null;
  gifCanvas = null;
  gifCtx = null;
  gifWidth = 0;
  gifHeight = 0;
  gifColors = 256;
  gifDelayMs = 100;
  gifTotalFrames = 0;
  gifEncodedFrames = 0;

  watermarkEnabled = false;
  disposeWatermarkOverlay();
  mode = null;
}

// ── Init Video ────────────────────────────────────────────

async function handleInitVideo(
  config: InitVideoMessage["config"]
): Promise<void> {
  cleanup();
  mode = "video";
  aborted = false;
  videoEncodedFrames = 0;
  videoTotalFrames = config.totalFrames;
  videoFps = config.fps;
  watermarkEnabled = config.addWatermark;

  if (watermarkEnabled) {
    await preloadWatermark();
  }

  // Compute bitrate (pixel-scaled)
  const pixels = Math.max(1, config.width * config.height);
  const scale = pixels / REFERENCE_PIXELS;
  const bitrate = Math.min(
    Math.round(BASE_BITRATE_1080P[config.quality] * scale),
    MAX_BITRATE
  );

  // Resolve codec
  let resolvedCodec: string;
  if (config.resolvedCodec) {
    resolvedCodec = config.resolvedCodec;
  } else {
    const codec = await getSupportedVideoCodec(
      config.width,
      config.height,
      bitrate,
      config.fps
    );
    if (!codec) {
      send({
        type: "error",
        error: "No supported video codec found for this resolution.",
        fatal: true,
      });
      return;
    }
    resolvedCodec = codec;
  }
  const codecIsHevc = isHevcCodec(resolvedCodec);

  // Even dimensions (WebCodecs requirement)
  const safeWidth = config.width % 2 === 0 ? config.width : config.width + 1;
  const safeHeight =
    config.height % 2 === 0 ? config.height : config.height + 1;

  // Create muxer
  const target = createMuxerTarget(config.estimatedBytes);
  const format = new Mp4OutputFormat({
    fastStart: muxerIsStreaming ? "fragmented" : "in-memory",
  });
  output = new Output({ format, target });

  videoSource = new EncodedVideoPacketSource(codecIsHevc ? "hevc" : "avc");
  output.addVideoTrack(videoSource, { frameRate: config.fps });
  await output.start();

  // Create video encoder
  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (videoSource) {
        videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta);
      }
    },
    error: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      send({ type: "error", error: msg, fatal: true });
    },
  });

  const encoderConfig = {
    codec: resolvedCodec,
    width: safeWidth,
    height: safeHeight,
    bitrate,
    bitrateMode: "variable" as const,
    framerate: config.fps,
    latencyMode: "quality" as const,
    hardwareAcceleration: "no-preference" as const,
    ...(codecIsHevc
      ? { hevc: { format: "hevc" as const } }
      : { avc: { format: "avc" as const } }),
  } as VideoEncoderConfig;

  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) {
    send({
      type: "error",
      error: "Export configuration not supported by browser.",
      fatal: true,
    });
    return;
  }

  // configure() can throw OperationError ("Encoder creation error") even when
  // isConfigSupported() returned true -- hardware encoder may reject the config
  // at creation time due to resource exhaustion, portrait resolution constraints,
  // bitrate limits, or VideoToolbox session caps on macOS.
  // Strategy: try configure, and if it fails, retry with progressively safer
  // codec strings (lower H.264 levels) before giving up.
  try {
    videoEncoder.configure(encoderConfig);
  } catch (configErr) {
    // Close the failed encoder and try fallback codecs
    try { videoEncoder.close(); } catch { /* ignore */ }

    const fallbackCodecs = [
      "avc1.640033", // High Profile Level 5.1
      "avc1.640028", // High Profile Level 4.0
      "avc1.4d0028", // Main Profile Level 4.0
      "avc1.42001e", // Baseline Profile Level 3.0
    ].filter((c) => c !== resolvedCodec);

    let fallbackSucceeded = false;
    for (const fallbackCodec of fallbackCodecs) {
      try {
        const fallbackConfig: VideoEncoderConfig = {
          codec: fallbackCodec,
          width: safeWidth,
          height: safeHeight,
          bitrate: Math.min(bitrate, 40_000_000), // cap at 40 Mbps for safety
          bitrateMode: "variable" as const,
          framerate: config.fps,
          latencyMode: "quality" as const,
          hardwareAcceleration: "no-preference" as const,
          avc: { format: "avc" as const },
        };
        const fbSupport = await VideoEncoder.isConfigSupported(fallbackConfig);
        if (!fbSupport.supported) continue;

        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => {
            if (videoSource) {
              videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta);
            }
          },
          error: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            send({ type: "error", error: msg, fatal: true });
          },
        });
        videoEncoder.configure(fallbackConfig);
        resolvedCodec = fallbackCodec;
        fallbackSucceeded = true;
        break;
      } catch {
        continue;
      }
    }

    if (!fallbackSucceeded) {
      const originalMsg = configErr instanceof Error ? configErr.message : String(configErr);
      send({
        type: "error",
        error: `Encoder creation failed (tried ${fallbackCodecs.length + 1} codecs). Original error: ${originalMsg}`,
        fatal: true,
      });
      return;
    }
  }

  send({ type: "ready", codec: resolvedCodec });
}

// ── Init GIF ──────────────────────────────────────────────

async function handleInitGif(
  config: InitGifMessage["config"]
): Promise<void> {
  cleanup();
  mode = "gif";
  aborted = false;
  gifEncodedFrames = 0;
  gifTotalFrames = config.totalFrames;
  gifWidth = config.width;
  gifHeight = config.height;
  gifColors = config.colors;
  gifDelayMs = Math.round(1000 / config.fps);
  watermarkEnabled = config.addWatermark;

  if (watermarkEnabled) {
    await preloadWatermark();
  }

  gifCanvas = new OffscreenCanvas(config.width, config.height);
  gifCtx = gifCanvas.getContext("2d", { willReadFrequently: true });
  if (!gifCtx) {
    send({
      type: "error",
      error: "Failed to create OffscreenCanvas for GIF",
      fatal: true,
    });
    return;
  }

  gifEncoder = GIFEncoder();
  send({ type: "ready", codec: "gif" });
}

// ── Handle Frame ──────────────────────────────────────────

async function handleFrame(
  frameIndex: number,
  bitmap: ImageBitmap | undefined,
  videoFrame: VideoFrame | undefined
): Promise<void> {
  if (aborted) {
    bitmap?.close();
    videoFrame?.close();
    return;
  }

  // FAST PATH: a pre-built VideoFrame (video mode only). Encode it as-is -- no
  // ImageBitmap round-trip. The caller only sends this when NOT watermarking, so
  // there is no re-draw step here; if a watermark was somehow enabled alongside a
  // VideoFrame we fail loudly rather than silently ship an un-watermarked frame.
  if (videoFrame) {
    try {
      if (mode !== "video") {
        throw new Error("VideoFrame fast path is video-mode only");
      }
      if (watermarkEnabled) {
        throw new Error("VideoFrame fast path cannot apply a watermark");
      }
      await encodeVideoFrame(frameIndex, videoFrame);
    } catch (err) {
      try {
        videoFrame.close();
      } catch {
        /* already closed */
      }
      const msg = err instanceof Error ? err.message : String(err);
      send({
        type: "error",
        error: `Frame ${frameIndex} encoding failed: ${msg}`,
        fatal: true,
      });
    }
    return;
  }

  // DEFAULT PATH: an ImageBitmap (video or gif; supports watermarking).
  if (!bitmap) {
    send({
      type: "error",
      error: `Frame ${frameIndex} carried neither a bitmap nor a VideoFrame`,
      fatal: true,
    });
    return;
  }

  let frame = bitmap;
  try {
    if (watermarkEnabled) {
      const watermarked = await applyWatermarkToBitmap(frame);
      frame.close();
      frame = watermarked;
    }

    if (mode === "video") {
      await handleVideoFrame(frameIndex, frame);
    } else if (mode === "gif") {
      handleGifFrame(frame);
    }
  } catch (err) {
    try {
      frame.close();
    } catch {
      /* already closed */
    }
    const msg = err instanceof Error ? err.message : String(err);
    send({
      type: "error",
      error: `Frame ${frameIndex} encoding failed: ${msg}`,
      fatal: true,
    });
  }
}

async function handleVideoFrame(
  frameIndex: number,
  bitmap: ImageBitmap
): Promise<void> {
  if (!videoEncoder || videoEncoder.state !== "configured") {
    bitmap.close();
    send({
      type: "error",
      error: `VideoEncoder in unexpected state: ${videoEncoder?.state ?? "null"}`,
      fatal: true,
    });
    return;
  }

  const { timestamp, duration } = frameTimingUs(frameIndex);

  let videoFrame: VideoFrame;
  try {
    videoFrame = new VideoFrame(bitmap, { timestamp, duration });
  } catch (err) {
    bitmap.close();
    throw new Error(
      `Failed to create VideoFrame: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // The VideoFrame now owns the pixels; the source bitmap can go.
  bitmap.close();

  await encodeVideoFrame(frameIndex, videoFrame);
}

/** Per-frame presentation timestamp + duration (microseconds) from the fps. */
function frameTimingUs(frameIndex: number): { timestamp: number; duration: number } {
  const timestamp = Math.round((frameIndex * 1_000_000) / videoFps);
  const next = Math.round(((frameIndex + 1) * 1_000_000) / videoFps);
  return { timestamp, duration: next - timestamp };
}

/**
 * Encode a ready VideoFrame and emit the ack/progress. Shared by the ImageBitmap
 * path (which builds the VideoFrame first) and the fast VideoFrame path (which
 * hands one in directly). CLOSES the frame when done -- either after encode or on
 * a state error -- so no VideoFrame ever leaks.
 *
 * A fast-path frame arrives carrying the caller's own timestamp/duration; a
 * bitmap-path frame was stamped from frameTimingUs above. Both are already
 * correctly timed, so we do NOT re-stamp here.
 */
async function encodeVideoFrame(
  frameIndex: number,
  videoFrame: VideoFrame
): Promise<void> {
  if (!videoEncoder || videoEncoder.state !== "configured") {
    videoFrame.close();
    send({
      type: "error",
      error: `VideoEncoder in unexpected state: ${videoEncoder?.state ?? "null"}`,
      fatal: true,
    });
    return;
  }

  try {
    const keyFrameInterval = Math.max(1, Math.round(videoFps));
    videoEncoder.encode(videoFrame, {
      keyFrame: frameIndex % keyFrameInterval === 0,
    });
  } finally {
    videoFrame.close();
  }

  videoEncodedFrames++;

  const queueSize = videoEncoder.encodeQueueSize;
  send({ type: "frame-ack", frameIndex, encodeQueueSize: queueSize });

  if (videoEncodedFrames % 10 === 0 || videoEncodedFrames === videoTotalFrames) {
    send({
      type: "progress",
      encodedFrames: videoEncodedFrames,
      totalFrames: videoTotalFrames,
      encodeQueueSize: queueSize,
    });
  }
}

function handleGifFrame(bitmap: ImageBitmap): void {
  if (!gifEncoder || !gifCtx || !gifCanvas) {
    bitmap.close();
    send({ type: "error", error: "GIF encoder not initialized", fatal: true });
    return;
  }

  gifCtx.clearRect(0, 0, gifWidth, gifHeight);
  gifCtx.drawImage(bitmap, 0, 0, gifWidth, gifHeight);
  bitmap.close();

  const imageData = gifCtx.getImageData(0, 0, gifWidth, gifHeight);
  const rgba = imageData.data;
  const palette = quantize(rgba, gifColors, { format: "rgb565" });
  const indexed = applyPalette(rgba, palette, "rgb565");

  gifEncoder.writeFrame(indexed, gifWidth, gifHeight, {
    palette,
    delay: gifDelayMs,
    repeat: 0,
  });

  gifEncodedFrames++;

  send({
    type: "frame-ack",
    frameIndex: gifEncodedFrames - 1,
    encodeQueueSize: 0,
  });

  if (gifEncodedFrames % 5 === 0 || gifEncodedFrames === gifTotalFrames) {
    send({
      type: "progress",
      encodedFrames: gifEncodedFrames,
      totalFrames: gifTotalFrames,
      encodeQueueSize: 0,
    });
  }
}

// ── Handle Finalize ───────────────────────────────────────

async function handleFinalize(): Promise<void> {
  if (aborted) {
    send({ type: "aborted" });
    cleanup();
    return;
  }

  try {
    if (mode === "video") {
      if (videoEncoder) {
        if (videoEncoder.state === "configured") {
          await videoEncoder.flush();
          videoEncoder.close();
        } else if (videoEncoder.state !== "closed") {
          try {
            videoEncoder.close();
          } catch {
            /* ignore */
          }
        }
        videoEncoder = null;
      }

      if (videoSource) videoSource.close();
      if (output) await output.finalize();

      const buffer = await targetToArrayBuffer();
      if (!buffer || buffer.byteLength === 0) {
        send({
          type: "error",
          error: "Export produced empty output.",
          fatal: true,
        });
        return;
      }

      send({ type: "complete", buffer, mimeType: "video/mp4" }, [buffer]);
    } else if (mode === "gif") {
      if (!gifEncoder) {
        send({
          type: "error",
          error: "GIF encoder not initialized",
          fatal: true,
        });
        return;
      }

      gifEncoder.finish();
      const bytes = gifEncoder.bytes();
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const buffer = copy.buffer;

      send({ type: "complete", buffer, mimeType: "image/gif" }, [buffer]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send({ type: "error", error: `Finalization failed: ${msg}`, fatal: true });
  } finally {
    cleanup();
  }
}

// ── Handle Abort ──────────────────────────────────────────

function handleAbort(): void {
  aborted = true;
  try {
    cleanup();
  } catch {
    /* ignore */
  }
  send({ type: "aborted" });
}

// ── Sequential Message Queue ──────────────────────────────

let messageQueue: Promise<void> = Promise.resolve();

async function processMessage(msg: MainToWorkerMessage): Promise<void> {
  try {
    switch (msg.type) {
      case "init-video":
        await handleInitVideo(msg.config);
        break;
      case "init-gif":
        await handleInitGif(msg.config);
        break;
      case "frame":
        await handleFrame(msg.frameIndex, msg.bitmap, msg.frame);
        break;
      case "finalize":
        await handleFinalize();
        break;
      case "abort":
        handleAbort();
        break;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    send({ type: "error", error: errorMsg, fatal: true });
  }
}

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  messageQueue = messageQueue.then(() => processMessage(e.data));
};
