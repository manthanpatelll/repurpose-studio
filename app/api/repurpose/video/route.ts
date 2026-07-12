// ===========================================================================
// /api/repurpose/video  —  local-footage streamer for Repurpose Studio
// ===========================================================================
// WHY THIS EXISTS: a browser <video> cannot load a raw OS path
// (/Users/.../clip.mp4) -- so the Repurpose Studio preview + MP4 export were
// stuck on gray SCREEN/FACE placeholder frames. This route bridges the gap:
// given ?path=<absolute file>, it streams that file over HTTP with byte-range
// support (Accept-Ranges + 206 Partial Content), which is exactly what
// <video>.currentTime seeking needs. lib/repurpose/ingest.ts turns an OS path
// into `/api/repurpose/video?path=...`, which PreviewCanvas and export-short
// then assign to <video>.src and can actually decode + seek.
//
// SECURITY: this is a LOCAL-ONLY side project (never deployed). Even so, we
// only serve files under an allow-list of roots (the user's home media dirs
// and the OS temp dir), resolve symlinks, and re-check containment after
// realpath so `..` / symlink escapes can't read arbitrary files. Node runtime
// is required for fs streaming; it cannot run on Edge.
// ===========================================================================

import { createReadStream, type Stats } from "node:fs";
import { stat, realpath, open, rename, rm, mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { getProxyState } from "@/lib/repurpose/proxy-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// AUTO-FASTSTART
// ---------------------------------------------------------------------------
// A browser <video> seeks by first reading the MP4's `moov` atom (the frame
// index). If `moov` sits at the END of the file (the default for many recorders,
// including our source footage) the browser must fetch the tail of a possibly-
// multi-GB file before it can seek -- a visible stall on every scrub. Faststart
// = `moov` moved to the FRONT, so seeks are instant. We fix this transparently:
// the FIRST time a non-faststart file is requested we remux it once (ffmpeg
// -c copy -movflags +faststart -- no re-encode, no quality loss, seconds even
// for GBs), cache the result in the OS temp dir keyed by source path + mtime +
// size, and serve THAT. Every later request (and every seek) hits the cached
// faststart copy. Already-faststart files and any file where ffmpeg is missing/
// fails are served as-is, so this never breaks playback -- it only ever helps.

/** Cache dir for generated faststart remuxes (swept below; OS temp cleanup is a backstop). */
const FASTSTART_CACHE_DIR = path.join(os.tmpdir(), "repurpose-faststart");

// The faststart cache is keyed by (path, mtime, size), so re-editing a source
// orphans its old remux and long editing sessions accumulate multi-GB copies
// that OS temp cleanup may not reclaim for weeks. Sweep on a budget: drop
// entries older than the TTL, then, if still over the size cap, evict oldest
// (by mtime, i.e. LRU) until under it. Throttled to at most once per interval so
// it never runs on the hot request path more than needed.
const FASTSTART_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FASTSTART_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB total budget
const FASTSTART_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // sweep at most every 10 min
let lastFaststartSweepAt = 0;

/**
 * Evict stale / over-budget faststart remuxes. Best-effort: any error is
 * swallowed (a failed sweep must never break playback). Throttled by
 * `lastFaststartSweepAt` so concurrent requests don't all sweep at once. `now`
 * is injected so the throttle is testable without a clock dependency.
 */
async function sweepFaststartCache(now: number): Promise<void> {
  if (now - lastFaststartSweepAt < FASTSTART_SWEEP_INTERVAL_MS) return;
  lastFaststartSweepAt = now;
  try {
    const names = await readdir(FASTSTART_CACHE_DIR);
    const entries: { path: string; mtimeMs: number; size: number }[] = [];
    for (const name of names) {
      const full = path.join(FASTSTART_CACHE_DIR, name);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        // Age-based eviction first.
        if (now - s.mtimeMs > FASTSTART_CACHE_TTL_MS) {
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
    if (total <= FASTSTART_CACHE_MAX_BYTES) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const e of entries) {
      if (total <= FASTSTART_CACHE_MAX_BYTES) break;
      await rm(e.path, { force: true }).catch(() => {});
      total -= e.size;
    }
  } catch {
    /* dir missing or unreadable -- nothing to sweep */
  }
}

/**
 * Read the first few top-level atoms and report whether `moov` precedes `mdat`
 * (i.e. the file is already faststart). Cheap: reads only atom headers from the
 * front, never the whole file. Returns true (treat as faststart, skip remux) on
 * any parse trouble so a malformed/edge file is never sent through ffmpeg.
 */
async function isFaststart(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, "r");
    let offset = 0;
    const header = Buffer.alloc(16);
    // Walk up to ~8 top-level boxes; moov/mdat always surface within that.
    for (let i = 0; i < 8; i++) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const boxType = header.toString("latin1", 4, 8);
      // 64-bit "largesize" (size === 1) -> real size is the next 8 bytes.
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      if (boxType === "moov") return true; // moov reached before any mdat
      if (boxType === "mdat") return false; // mdat first -> NOT faststart
      if (boxSize <= 0) break; // "to end of file" or unknown -> stop probing
      offset += boxSize;
    }
    return true; // no clear mdat-before-moov -> don't remux
  } catch {
    return true; // can't probe -> assume fine, never remux blindly
  } finally {
    await handle?.close();
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

// In-flight remuxes keyed by cache path, so two concurrent requests for the same
// file share ONE ffmpeg run instead of racing to write the same output.
const inFlightRemux = new Map<string, Promise<string | null>>();

/** Deterministic cache path for a source file's faststart copy (path+mtime+size). */
function faststartCachePath(filePath: string, mtimeMs: number, size: number): string {
  const key = createHash("sha1")
    .update(`${filePath}:${Math.round(mtimeMs)}:${size}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(FASTSTART_CACHE_DIR, `${key}.mp4`);
}

/** Run `ffmpeg -c copy -movflags +faststart`, writing atomically via a temp file. */
function runFaststartRemux(src: string, dest: string): Promise<boolean> {
  const tmp = `${dest}.${process.pid}.partial.mp4`;
  return new Promise((resolve) => {
    const proc = spawn(
      "ffmpeg",
      ["-y", "-v", "error", "-i", src, "-c", "copy", "-movflags", "+faststart", tmp],
      { stdio: "ignore" }
    );
    proc.on("error", () => resolve(false));
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
 * Return a path to a faststart-seekable version of `filePath`: the file itself
 * when it's already faststart (or ffmpeg is unavailable / a remux fails), else a
 * cached remux (generated once, reused forever). Only ever returns something the
 * caller can safely stream; never throws.
 */
async function ensureFaststart(
  filePath: string,
  mtimeMs: number,
  size: number
): Promise<string> {
  try {
    // Only mp4/mov/m4v carry a moov atom worth relocating; others pass through.
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".mp4" && ext !== ".mov" && ext !== ".m4v") return filePath;
    if (await isFaststart(filePath)) return filePath;
    if (!(await checkFfmpeg())) return filePath; // no ffmpeg -> serve original

    const cachePath = faststartCachePath(filePath, mtimeMs, size);
    // Already remuxed on a previous request? Serve the cached copy.
    try {
      const cached = await stat(cachePath);
      if (cached.isFile() && cached.size > 0) return cachePath;
    } catch {
      /* not cached yet -> build it below */
    }

    // Build once; concurrent requests await the same in-flight promise.
    let job = inFlightRemux.get(cachePath);
    if (!job) {
      job = (async () => {
        await mkdir(FASTSTART_CACHE_DIR, { recursive: true }).catch(() => {});
        // Opportunistically evict stale / over-budget remuxes (throttled) so the
        // cache can't grow unbounded across editing sessions. Fire-and-forget --
        // it must never delay or fail the remux we're about to build.
        void sweepFaststartCache(Date.now());
        const ok = await runFaststartRemux(filePath, cachePath);
        return ok ? cachePath : null;
      })().finally(() => inFlightRemux.delete(cachePath));
      inFlightRemux.set(cachePath, job);
    }
    const result = await job;
    return result ?? filePath; // remux failed -> fall back to the original
  } catch {
    return filePath; // any surprise -> serve the original, never break playback
  }
}

// Roots a request is allowed to read from. Real footage lives in ~/Downloads;
// generated/temp inputs (e.g. transcribed words) live in the OS temp dir.
const ALLOWED_ROOTS: string[] = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Movies"),
  os.tmpdir(),
];

// Common video containers we serve. Anything else is rejected so this route
// can't be repurposed into a generic file exfiltration endpoint.
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve + validate the requested path against the allow-list. Exported so
 * /api/repurpose/proxy applies the exact same sandbox to its ?path input --
 * one validator, one policy (Next.js only treats HTTP-method exports as
 * handlers; extra named exports from a route module are just module exports).
 */
export async function resolveAllowed(rawPath: string): Promise<string | null> {
  if (!rawPath || !path.isAbsolute(rawPath)) return null;
  // Realpath collapses symlinks and `..`; re-check the resolved path is still
  // inside an allowed root so neither trick escapes the sandbox.
  let resolved: string;
  try {
    resolved = await realpath(rawPath);
  } catch {
    return null;
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!(ext in CONTENT_TYPES)) return null;
  for (const root of ALLOWED_ROOTS) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isUnder(realRoot, resolved)) return resolved;
  }
  return null;
}

/** Parse a single `bytes=start-end` range against the file size. */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start < 0 || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return new Response("Missing ?path", { status: 400 });
  }

  const resolvedPath = await resolveAllowed(rawPath);
  if (!resolvedPath) {
    return new Response("Not found or not allowed", { status: 404 });
  }

  const srcInfo = await stat(resolvedPath);
  if (!srcInfo.isFile()) {
    return new Response("Not a file", { status: 404 });
  }

  let filePath: string;
  let info: Stats;
  let contentType: string;
  if (url.searchParams.get("quality") === "proxy") {
    // PREVIEW PROXY: serve the low-res dense-keyframe proxy built by
    // /api/repurpose/proxy instead of the original. If it isn't ready we 404
    // ("Proxy not ready") rather than silently falling back to the original:
    // a <video> element that starts range-reading one file must NEVER get
    // bytes from a different one mid-src -- mixed byte ranges from two files
    // are corrupt garbage to the decoder. The client only requests this URL
    // after the status endpoint reports "ready", so a 404 here means the
    // cache was purged out from under us and the client falls back cleanly
    // by re-pointing src at the original URL.
    const proxy = await getProxyState(resolvedPath, srcInfo.mtimeMs, srcInfo.size);
    if (proxy.status !== "ready" || !proxy.proxyPath) {
      return new Response("Proxy not ready", { status: 404 });
    }
    filePath = proxy.proxyPath;
    info = await stat(filePath);
    contentType = "video/mp4"; // proxies are always mp4, whatever the source was
    // No ensureFaststart here: the proxy is encoded with -movflags +faststart.
  } else {
    // Transparently serve a faststart-seekable version so <video> scrub seeks don't
    // stall on a tail-located moov atom. Keyed by the SOURCE file's mtime+size, so
    // editing/replacing the file invalidates the cache. Falls back to the original
    // when already faststart / ffmpeg missing / remux fails -- never breaks playback.
    filePath = await ensureFaststart(resolvedPath, srcInfo.mtimeMs, srcInfo.size);
    info = filePath === resolvedPath ? srcInfo : await stat(filePath);
    contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  }

  const size = info.size;
  const range = parseRange(request.headers.get("range"), size);

  const commonHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Footage is immutable for a session but large; avoid the browser
    // re-caching multi-GB files. no-store keeps memory sane; range requests
    // still work because we always serve fresh from disk.
    "Cache-Control": "no-store",
  };

  if (!range) {
    // Full-content response (still advertises range support so the <video>
    // element issues subsequent range requests when seeking).
    const stream = Readable.toWeb(
      createReadStream(filePath)
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: { ...commonHeaders, "Content-Length": String(size) },
    });
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  const stream = Readable.toWeb(
    createReadStream(filePath, { start, end })
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 206,
    headers: {
      ...commonHeaders,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(chunkSize),
    },
  });
}
