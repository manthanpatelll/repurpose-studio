// ===========================================================================
// lib/repurpose/proxy-cache  —  low-res preview-proxy builder for Repurpose Studio
// ===========================================================================
// WHY THIS EXISTS: the Repurpose Studio preview <video> plays the RAW facecam
// footage -- often a multi-GB 4K file. Decoding that just to show a small
// preview burns CPU, and sparse keyframes make every scrub/seek visibly laggy.
// This module builds a one-time background ffmpeg proxy: PROXY_SHORT_SIDE px (short side, 270 today),
// dense keyframes (-g 15 ≈ one keyframe every 0.5s at 30fps) so seeks land
// almost instantly, +faststart so the browser can seek without fetching the
// file tail. The preview then streams the proxy via
// `/api/repurpose/video?path=...&quality=proxy` while EXPORT keeps reading the
// pristine original -- the proxy never touches output quality.
//
// SERVER-ONLY: node imports throughout (fs/child_process/crypto). Only API
// routes may import this module -- never client components.
//
// Mirrors the faststart remux machinery in app/api/repurpose/video/route.ts:
// temp-dir cache keyed by sha1(path:mtime:size), in-flight dedup map, atomic
// rename publish, throttled TTL+budget sweep, cached ffmpeg probe. The one
// difference: proxy encodes take minutes, not seconds, so builds are
// fire-and-forget (detached from the request lifecycle) and progress is
// reported through a module-scoped map instead of awaiting the encode.
// ===========================================================================

import { stat, rename, rm, mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * What the status endpoint reports to the client:
 * - "ready"        proxy exists on disk (proxyPath set, server-side use only)
 * - "building"     an encode is in flight (outTimeSec = seconds encoded so far)
 * - "none"         no proxy, no build -- a POST can start one
 * - "unavailable"  ffmpeg missing or the source container isn't proxyable
 */
export type ProxyState = {
  status: "ready" | "building" | "none" | "unavailable";
  proxyPath?: string;
  outTimeSec?: number;
};

/** Cache dir for generated proxies (swept below; OS temp cleanup is a backstop). */
const PROXY_CACHE_DIR = path.join(os.tmpdir(), "repurpose-proxy");

// The proxy cache is keyed by (path, mtime, size), so re-editing a source
// orphans its old proxy and long editing sessions accumulate stale copies that
// OS temp cleanup may not reclaim for weeks. Proxies are small (~15 MB/min at
// 2 Mbps) but worth keeping around -- rebuilding costs minutes of encode time --
// so the TTL is generous (30 days vs the remux cache's 7) with a 10 GB budget.
// Same policy as sweepFaststartCache: TTL first, then oldest-first (LRU) until
// under budget, throttled so it never runs on the hot path more than needed.
const PROXY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PROXY_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB total budget
const PROXY_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // sweep at most every 10 min
let lastProxySweepAt = 0;

// Containers we know how to proxy. Anything else reports "unavailable" so the
// client never polls forever waiting for a build that will never start.
const PROXYABLE_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

/**
 * Evict stale / over-budget proxies. Best-effort: any error is swallowed (a
 * failed sweep must never break a build). Throttled by `lastProxySweepAt` so
 * concurrent builds don't all sweep at once. `now` is injected so the throttle
 * is testable without a clock dependency.
 */
async function sweepProxyCache(now: number): Promise<void> {
  if (now - lastProxySweepAt < PROXY_SWEEP_INTERVAL_MS) return;
  lastProxySweepAt = now;
  try {
    const names = await readdir(PROXY_CACHE_DIR);
    const entries: { path: string; mtimeMs: number; size: number }[] = [];
    for (const name of names) {
      const full = path.join(PROXY_CACHE_DIR, name);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        // Age-based eviction first.
        if (now - s.mtimeMs > PROXY_CACHE_TTL_MS) {
          await rm(full, { force: true }).catch(() => {});
          continue;
        }
        entries.push({ path: full, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        /* entry vanished mid-scan -- ignore */
      }
    }
    // Size-cap eviction: if still over budget, drop oldest-first (LRU) until under.
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= PROXY_CACHE_MAX_BYTES) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const e of entries) {
      if (total <= PROXY_CACHE_MAX_BYTES) break;
      await rm(e.path, { force: true }).catch(() => {});
      total -= e.size;
    }
  } catch {
    /* dir missing or unreadable -- nothing to sweep */
  }
}

/** Is ffmpeg runnable? Cached after the first probe (null = not yet checked). */
let ffmpegAvailable: boolean | null = null;
function checkFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return Promise.resolve(ffmpegAvailable);
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve((ffmpegAvailable = false)));
    proc.on("exit", (code) => resolve((ffmpegAvailable = code === 0)));
  });
}

// In-flight builds keyed by cache path, so two concurrent POSTs for the same
// file share ONE ffmpeg run instead of racing to write the same output. Unlike
// inFlightRemux these promises are fire-and-forget: nothing on the request
// path ever awaits them (an encode takes minutes).
const inFlightProxy = new Map<string, Promise<boolean>>();

// Encode progress keyed by cache path: seconds of output written so far,
// parsed from ffmpeg's `-progress` stream. Read by getProxyState so the client
// can show "building... 42s / 300s". Cleared when the build ends either way.
const proxyProgress = new Map<string, number>();

// THE preview-quality dial. Short side of the proxy in pixels + the hardware
// encoder's video bitrate. Manthan explicitly chose 144p (2026-07-10, "as low
// as possible") -- absolute preview fluidity over fidelity; the face half of
// the small preview panel stays readable enough to edit by, and export always
// reads the pristine original. The value is baked into the cache FILENAME, so
// lowering/raising it orphans old proxies (TTL sweep reclaims them) and
// rebuilds at the new size automatically on next project open.
const PROXY_SHORT_SIDE = 144;
const PROXY_VIDEO_BITRATE = "300k";

/** Deterministic cache path for a source file's preview proxy (path+mtime+size). */
export function proxyCachePath(filePath: string, mtimeMs: number, size: number): string {
  const key = createHash("sha1")
    .update(`${filePath}:${Math.round(mtimeMs)}:${size}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(PROXY_CACHE_DIR, `${key}-${PROXY_SHORT_SIDE}p.mp4`);
}

/**
 * Run one ffmpeg encode pass to `dest`, writing atomically via a temp file
 * (rename on success, rm on failure -- readers never see a partial). Streams
 * `-progress pipe:1` key=value lines from stdout into `proxyProgress`.
 *
 * `useSoftware` picks the codec: h264_videotoolbox (hardware, near-free on
 * Apple Silicon) first; libx264 as the retry path when videotoolbox rejects
 * the input (odd pixel formats, exotic sources). Both keep -g 15: dense
 * keyframes are the whole point -- they're what makes preview scrubbing snap.
 */
function runProxyEncode(src: string, dest: string, useSoftware: boolean): Promise<boolean> {
  const tmp = `${dest}.${process.pid}.partial.mp4`;
  const codecArgs = useSoftware
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0"]
    : ["-c:v", "h264_videotoolbox", "-b:v", PROXY_VIDEO_BITRATE, "-g", "15", "-allow_sw", "1"];
  const args = [
    "-y",
    "-v",
    "error",
    "-nostats",
    "-progress",
    "pipe:1", // machine-readable progress on stdout (out_time_ms= lines)
    "-i",
    src,
    "-map",
    "0:v:0", // first video stream only
    "-map",
    "0:a:0?", // first audio stream IF present (trailing ? = optional)
    // Scale the SHORT side to PROXY_SHORT_SIDE, long side follows (-2 keeps it
    // even for yuv420p). The single quotes are consumed by ffmpeg's own
    // FILTERGRAPH parser -- spawn() uses no shell, so this is ONE argv string.
    "-vf",
    `scale='if(gte(iw,ih),-2,${PROXY_SHORT_SIDE})':'if(gte(iw,ih),${PROXY_SHORT_SIDE},-2)'`,
    "-pix_fmt",
    "yuv420p",
    ...codecArgs,
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart", // proxy is born faststart -- the video route skips its remux
    tmp,
  ];
  return new Promise((resolve) => {
    // stdout MUST be piped for -progress pipe:1; stderr is noise we ignore.
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    let pending = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? ""; // keep the trailing partial line for next chunk
      for (const line of lines) {
        // ffmpeg emits `out_time_ms=` and/or `out_time_us=` depending on
        // version -- and (long-standing ffmpeg quirk) out_time_ms is ALSO in
        // microseconds despite the name, so both divide by 1e6.
        const m = /^out_time_(?:ms|us)=(\d+)/.exec(line.trim());
        if (m) proxyProgress.set(dest, Number(m[1]) / 1_000_000);
      }
    });
    proc.on("error", async () => {
      await rm(tmp, { force: true }).catch(() => {});
      resolve(false);
    });
    proc.on("exit", async (code) => {
      if (code !== 0) {
        await rm(tmp, { force: true }).catch(() => {});
        resolve(false);
        return;
      }
      try {
        await rename(tmp, dest); // atomic publish -- readers never see a partial
        resolve(true);
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
        resolve(false);
      }
    });
  });
}

/**
 * Report the current proxy state for a source file. Never throws, never
 * mutates anything -- safe to poll. "building" wins over "ready" checks so a
 * half-written .partial can never be misreported (the finished file only
 * appears via atomic rename AFTER the in-flight entry clears).
 */
export async function getProxyState(
  filePath: string,
  mtimeMs: number,
  size: number
): Promise<ProxyState> {
  // Unsupported container or no ffmpeg -> a build can never happen; tell the
  // client so it stops asking and just plays the original.
  const ext = path.extname(filePath).toLowerCase();
  if (!PROXYABLE_EXTS.has(ext)) return { status: "unavailable" };
  if (!(await checkFfmpeg())) return { status: "unavailable" };

  const cachePath = proxyCachePath(filePath, mtimeMs, size);
  if (inFlightProxy.has(cachePath)) {
    return { status: "building", outTimeSec: proxyProgress.get(cachePath) ?? 0 };
  }
  try {
    const cached = await stat(cachePath);
    if (cached.isFile() && cached.size > 0) {
      return { status: "ready", proxyPath: cachePath };
    }
  } catch {
    /* not built yet */
  }
  return { status: "none" };
}

/**
 * Kick off a proxy build for a source file and return immediately. Idempotent:
 * "ready"/"building"/"unavailable" states pass straight through untouched; only
 * "none" actually spawns ffmpeg. The encode is DETACHED from the request
 * lifecycle -- the promise lives in `inFlightProxy` (same dedup pattern as
 * inFlightRemux) and nobody awaits it, so the POST that started a 10-minute
 * encode returns in milliseconds and the client polls GET for progress.
 */
export async function startProxyBuild(
  filePath: string,
  mtimeMs: number,
  size: number
): Promise<ProxyState> {
  const current = await getProxyState(filePath, mtimeMs, size);
  if (current.status !== "none") return current;

  const cachePath = proxyCachePath(filePath, mtimeMs, size);
  // Re-check under the map (getProxyState above isn't atomic with this): a
  // concurrent POST may have registered the build between the two lines.
  if (!inFlightProxy.has(cachePath)) {
    const job = (async () => {
      await mkdir(PROXY_CACHE_DIR, { recursive: true }).catch(() => {});
      // Opportunistically evict stale / over-budget proxies (throttled) so the
      // cache can't grow unbounded across editing sessions. Fire-and-forget --
      // it must never delay or fail the build we're about to start.
      void sweepProxyCache(Date.now());
      // Hardware first; if videotoolbox exits non-zero, retry once in software.
      const okHw = await runProxyEncode(filePath, cachePath, false);
      if (okHw) return true;
      return runProxyEncode(filePath, cachePath, true);
    })().finally(() => {
      inFlightProxy.delete(cachePath);
      proxyProgress.delete(cachePath); // progress is meaningless once the build ends
    });
    inFlightProxy.set(cachePath, job);
    // Nothing awaits this promise -- swallow any rejection so a surprise can
    // never surface as an unhandled rejection and crash the dev server.
    void job.catch(() => {});
  }
  return { status: "building", outTimeSec: proxyProgress.get(cachePath) ?? 0 };
}
