/**
 * EncodeWorkerBridge - Main-thread API for the Encode Worker.
 *
 * Provides a clean async interface over the raw postMessage protocol.
 * Handles Worker lifecycle, backpressure, abort, and error propagation.
 *
 * Adapted from TiltIt's production worker bridge.
 */

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  InitVideoMessage,
  InitGifMessage,
} from "./workerProtocol";
import { MAX_ENCODE_QUEUE_DEPTH } from "./workerProtocol";

// ── Public types ──────────────────────────────────────────

export interface WorkerProgressInfo {
  encodedFrames: number;
  totalFrames: number;
  encodeQueueSize: number;
}

interface WorkerCompleteResult {
  buffer: ArrayBuffer;
  mimeType: string;
}

// ── Feature detection ─────────────────────────────────────

/** Check if Worker-based encoding is supported in this browser. */
export function isWorkerEncodingSupported(): boolean {
  return typeof Worker !== "undefined" && typeof ImageBitmap !== "undefined";
}

// ── Worker pre-spawn (warm pool) ──────────────────────────

let warmWorker: Worker | null = null;

/** Pre-create an idle Worker. Safe to call multiple times (no-op if already warm). */
export function prespawnWorker(): void {
  if (warmWorker) return;
  if (!isWorkerEncodingSupported()) return;
  try {
    warmWorker = new Worker(
      new URL("./encode.worker.ts", import.meta.url)
    );
  } catch {
    warmWorker = null;
  }
}

/** Claim the pre-spawned Worker (returns null if none available). */
function claimWarmWorker(): Worker | null {
  const w = warmWorker;
  warmWorker = null;
  return w;
}

/** Dispose the pre-spawned Worker on unmount. */
export function disposeWarmWorker(): void {
  warmWorker?.terminate();
  warmWorker = null;
}

// ── Bridge class ──────────────────────────────────────────

export class EncodeWorkerBridge {
  private worker: Worker | null = null;
  private encodeQueueSize = 0;
  private pendingSends = 0;
  private aborted = false;
  private disposed = false;
  private fatalError: Error | null = null;

  // Promise resolvers
  private readyResolve: ((codec: string) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private finalizeResolve: ((result: WorkerCompleteResult) => void) | null =
    null;
  private finalizeReject: ((err: Error) => void) | null = null;
  private backpressureResolve: (() => void) | null = null;

  // Callbacks
  private onProgress: ((info: WorkerProgressInfo) => void) | null = null;
  private abortCleanup: (() => void) | null = null;

  // ── Lifecycle ─────────────────────────────────────────

  private createWorker(): void {
    if (this.worker) return;

    this.worker =
      claimWarmWorker() ??
      new Worker(new URL("./encode.worker.ts", import.meta.url));

    this.worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
      this.handleMessage(e.data);
    };

    this.worker.onerror = (e) => {
      const errorMsg = e.message || "Worker error";
      this.handleFatalError(errorMsg);
    };
  }

  // ── Init ──────────────────────────────────────────────

  /**
   * Initialize the Worker for MP4 export.
   * Resolves when the Worker reports 'ready' with the selected codec.
   */
  async initVideo(
    config: InitVideoMessage["config"],
    options?: {
      onProgress?: (info: WorkerProgressInfo) => void;
      abortSignal?: AbortSignal;
    }
  ): Promise<string> {
    this.createWorker();
    this.aborted = false;
    this.fatalError = null;
    this.encodeQueueSize = 0;
    this.pendingSends = 0;
    this.onProgress = options?.onProgress ?? null;

    if (options?.abortSignal) {
      const onAbort = () => this.abort();
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      this.abortCleanup = () =>
        options.abortSignal!.removeEventListener("abort", onAbort);
    }

    return new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      // 20-second timeout for Worker initialization
      const initTimeoutId = setTimeout(() => {
        if (this.readyReject) {
          const err = new Error("Worker initialization timed out (20s).");
          this.readyReject(err);
          this.readyResolve = null;
          this.readyReject = null;
        }
      }, 20_000);

      const originalResolve = resolve;
      const originalReject = reject;
      this.readyResolve = (codec: string) => {
        clearTimeout(initTimeoutId);
        originalResolve(codec);
      };
      this.readyReject = (err: Error) => {
        clearTimeout(initTimeoutId);
        originalReject(err);
      };

      const msg: InitVideoMessage = { type: "init-video", config };
      this.worker!.postMessage(msg);
    });
  }

  /**
   * Initialize the Worker for GIF export.
   * Resolves when the Worker reports 'ready'.
   */
  async initGif(
    config: InitGifMessage["config"],
    options?: {
      onProgress?: (info: WorkerProgressInfo) => void;
      abortSignal?: AbortSignal;
    }
  ): Promise<string> {
    this.createWorker();
    this.aborted = false;
    this.fatalError = null;
    this.encodeQueueSize = 0;
    this.pendingSends = 0;
    this.onProgress = options?.onProgress ?? null;

    if (options?.abortSignal) {
      const onAbort = () => this.abort();
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      this.abortCleanup = () =>
        options.abortSignal!.removeEventListener("abort", onAbort);
    }

    return new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      const initTimeoutId = setTimeout(() => {
        if (this.readyReject) {
          const err = new Error("Worker initialization timed out (20s).");
          this.readyReject(err);
          this.readyResolve = null;
          this.readyReject = null;
        }
      }, 20_000);

      const originalResolve = resolve;
      const originalReject = reject;
      this.readyResolve = (codec: string) => {
        clearTimeout(initTimeoutId);
        originalResolve(codec);
      };
      this.readyReject = (err: Error) => {
        clearTimeout(initTimeoutId);
        originalReject(err);
      };

      const msg: InitGifMessage = { type: "init-gif", config };
      this.worker!.postMessage(msg);
    });
  }

  // ── Frame sending ─────────────────────────────────────

  /**
   * Send a rendered frame to the Worker for encoding.
   * The ImageBitmap ownership is transferred (zero-copy).
   *
   * Implements backpressure: awaits if the Worker's encode queue is full.
   */
  async sendFrame(frameIndex: number, bitmap: ImageBitmap): Promise<void> {
    if (this.disposed || this.aborted) {
      bitmap.close();
      throw (
        this.fatalError ?? new DOMException("Export aborted", "AbortError")
      );
    }

    if (!this.worker) {
      bitmap.close();
      throw new Error("Worker not initialized");
    }

    // Backpressure: wait if too many frames are in-flight
    while (this.pendingSends >= MAX_ENCODE_QUEUE_DEPTH) {
      if (this.aborted || this.disposed) {
        bitmap.close();
        throw (
          this.fatalError ?? new DOMException("Export aborted", "AbortError")
        );
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            this.backpressureResolve = resolve;
          }),
          new Promise<void>((_, reject) => {
            timeoutId = setTimeout(
              () =>
                reject(
                  new Error("Backpressure timeout - encoder queue not draining")
                ),
              30000
            );
          }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        this.backpressureResolve = null;
        bitmap.close();
        throw err;
      }
    }

    // Transfer the bitmap (zero-copy)
    const msg: MainToWorkerMessage = {
      type: "frame",
      frameIndex,
      bitmap,
    };
    this.worker.postMessage(msg, [bitmap]);
    this.pendingSends++;
  }

  /**
   * Fast-path frame send: transfer an already-built VideoFrame instead of an
   * ImageBitmap. Identical backpressure to {@link sendFrame}, but the worker
   * encodes the frame as-is (no ImageBitmap -> VideoFrame copy). The VideoFrame
   * is transferred (zero-copy) and consumed by the worker, which closes it after
   * encoding -- do NOT reference it after calling this.
   *
   * Not for watermarked exports (a watermark needs a re-drawable bitmap); those
   * must use {@link sendFrame}.
   */
  async sendVideoFrame(frameIndex: number, frame: VideoFrame): Promise<void> {
    if (this.disposed || this.aborted) {
      frame.close();
      throw (
        this.fatalError ?? new DOMException("Export aborted", "AbortError")
      );
    }

    if (!this.worker) {
      frame.close();
      throw new Error("Worker not initialized");
    }

    // Backpressure: wait if too many frames are in-flight (same gate as sendFrame).
    while (this.pendingSends >= MAX_ENCODE_QUEUE_DEPTH) {
      if (this.aborted || this.disposed) {
        frame.close();
        throw (
          this.fatalError ?? new DOMException("Export aborted", "AbortError")
        );
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            this.backpressureResolve = resolve;
          }),
          new Promise<void>((_, reject) => {
            timeoutId = setTimeout(
              () =>
                reject(
                  new Error("Backpressure timeout - encoder queue not draining")
                ),
              30000
            );
          }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        this.backpressureResolve = null;
        frame.close();
        throw err;
      }
    }

    // Transfer the VideoFrame (zero-copy).
    const msg: MainToWorkerMessage = {
      type: "frame",
      frameIndex,
      frame,
    };
    this.worker.postMessage(msg, [frame]);
    this.pendingSends++;
  }

  // ── Finalize ──────────────────────────────────────────

  /**
   * Finalize the export and get the result.
   * Resolves with the final file as an ArrayBuffer.
   */
  async finalize(): Promise<WorkerCompleteResult> {
    if (this.aborted || this.disposed || !this.worker) {
      throw (
        this.fatalError ?? new DOMException("Export aborted", "AbortError")
      );
    }

    return new Promise<WorkerCompleteResult>((resolve, reject) => {
      this.finalizeResolve = resolve;
      this.finalizeReject = reject;

      // 60-second timeout for finalization
      const finalizeTimeoutId = setTimeout(() => {
        if (this.finalizeReject) {
          const err = new Error("Export finalization timed out (60s).");
          this.finalizeReject(err);
          this.finalizeResolve = null;
          this.finalizeReject = null;
        }
      }, 60_000);

      const originalResolve = this.finalizeResolve;
      const originalReject = this.finalizeReject;
      this.finalizeResolve = (result) => {
        clearTimeout(finalizeTimeoutId);
        originalResolve!(result);
      };
      this.finalizeReject = (err) => {
        clearTimeout(finalizeTimeoutId);
        originalReject!(err);
      };

      const msg: MainToWorkerMessage = { type: "finalize" };
      this.worker!.postMessage(msg);
    });
  }

  // ── Abort ─────────────────────────────────────────────

  /** Abort the export and terminate the Worker. */
  abort(): void {
    if (this.aborted || this.disposed) return;
    this.aborted = true;

    this.abortCleanup?.();
    this.abortCleanup = null;

    if (this.worker) {
      try {
        const msg: MainToWorkerMessage = { type: "abort" };
        this.worker.postMessage(msg);
      } catch {
        /* Worker may already be terminated */
      }
    }

    const abortErr = new DOMException("Export aborted", "AbortError");
    this.readyReject?.(abortErr);
    this.readyResolve = null;
    this.readyReject = null;

    this.finalizeReject?.(abortErr);
    this.finalizeResolve = null;
    this.finalizeReject = null;

    this.backpressureResolve?.();
    this.backpressureResolve = null;

    setTimeout(() => this.terminateWorker(), 200);
  }

  // ── Dispose ───────────────────────────────────────────

  /** Clean up the Worker and all resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.abortCleanup?.();
    this.abortCleanup = null;

    const disposeErr =
      this.fatalError ?? new DOMException("Export aborted", "AbortError");
    this.readyReject?.(disposeErr);
    this.readyResolve = null;
    this.readyReject = null;

    this.finalizeReject?.(disposeErr);
    this.finalizeResolve = null;
    this.finalizeReject = null;

    this.backpressureResolve?.();
    this.backpressureResolve = null;

    this.terminateWorker();
    this.onProgress = null;
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  // ── Message Handler ───────────────────────────────────

  private handleMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve?.(msg.codec);
        this.readyResolve = null;
        this.readyReject = null;
        break;

      case "frame-ack":
        this.pendingSends = Math.max(0, this.pendingSends - 1);
        this.encodeQueueSize = msg.encodeQueueSize;

        if (
          this.pendingSends < MAX_ENCODE_QUEUE_DEPTH &&
          this.backpressureResolve
        ) {
          this.backpressureResolve();
          this.backpressureResolve = null;
        }
        break;

      case "progress":
        this.encodeQueueSize = msg.encodeQueueSize;
        this.onProgress?.(msg);

        if (
          this.pendingSends < MAX_ENCODE_QUEUE_DEPTH &&
          this.backpressureResolve
        ) {
          this.backpressureResolve();
          this.backpressureResolve = null;
        }
        break;

      case "complete":
        this.finalizeResolve?.(msg);
        this.finalizeResolve = null;
        this.finalizeReject = null;
        break;

      case "error":
        if (msg.fatal) {
          this.handleFatalError(msg.error);
        }
        break;

      case "aborted":
        break;
    }
  }

  private handleFatalError(errorMsg: string): void {
    const error = new Error(errorMsg);
    this.fatalError = error;
    this.aborted = true;

    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;

    this.finalizeReject?.(error);
    this.finalizeResolve = null;
    this.finalizeReject = null;

    this.backpressureResolve?.();
    this.backpressureResolve = null;
  }
}
