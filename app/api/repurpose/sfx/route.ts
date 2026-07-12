// ===========================================================================
// /api/repurpose/sfx  —  local SFX-track renderer for Repurpose Studio
// ===========================================================================
// WHY THIS EXISTS: the studio's "Sound Effects" button generates a sound-effects
// track for the assembled reel and bakes it into the preview + exported MP4. The
// SFX audio machinery (the real .wav sounds + pydub gain/onset/normalize) lives
// in the Python engine `scripts/sfx-engine/build_sfx_track.py`. The WHICH-sound-
// WHERE decision is made in the browser (lib/repurpose/sfx-placement.ts,
// `planSfxEvents`) so it reflects live edits; this route is the thin bridge that
// hands those pre-computed events to the Python engine and returns a playable WAV.
//
// This mirrors the existing /api/repurpose/asset route exactly: Node runtime,
// allow-listed roots, writes only inside the dedicated ~/Downloads dir, and a
// GET that streams the file back with byte-range support. The studio's UI-only /
// no-backend-render rule is about the VIDEO encode (which stays 100% in-browser
// via WebCodecs); rendering AUDIO through a small local helper is the same shape
// as the overlay asset copy route that already ships.
//
// POST { events: [{sfx, atMs}], durationMs } -> runs the engine -> { path, url }.
// GET  ?path=<abs .wav under an allowed root> -> streams audio/wav (206 ranges).
// ===========================================================================

import { createReadStream } from "node:fs";
import { stat, realpath, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// SFX render shells out to Whisper-less pydub -- fast, but give it headroom for a
// long reel with many overlays.
export const maxDuration = 300;

const execFileAsync = promisify(execFile);

// Where rendered SFX tracks land. Reuses the overlays dir (already an allowed
// root) so the WAV survives reload + is servable by GET below. mkdir -p'd first.
const SFX_DIR = path.join(os.homedir(), "Downloads", "repurpose-overlays");

// The Python engine directory. `uv run` resolves the pinned .venv there.
// Resolved relative to the running app (process.cwd()) so the repo is portable.
// This engine (scripts/sfx-engine/build_sfx_track.py + `uv`) is an OPTIONAL
// extra: if it's absent the SFX-render POST returns a 500 and the rest of the
// studio (cutting, preview, MP4 export) works unaffected. Override with the
// REPURPOSE_SFX_ENGINE_DIR env var to point at an engine kept elsewhere.
const ENGINE_DIR =
  process.env.REPURPOSE_SFX_ENGINE_DIR ||
  path.join(process.cwd(), "scripts", "sfx-engine");

// GET only serves .wav (this route is audio-only). Deliberately narrow so it
// can't be turned into a generic file-exfiltration path.
const CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
};

// Roots a GET may read from — same allow-list shape as the asset/video routes.
const ALLOWED_ROOTS: string[] = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Movies"),
  os.tmpdir(),
];

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve + validate a requested path against the allow-list (.wav only). */
async function resolveAllowed(rawPath: string): Promise<string | null> {
  if (!rawPath || !path.isAbsolute(rawPath)) return null;
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

// ---------------------------------------------------------------------------
// GET — stream a rendered SFX WAV with byte-range (206) support.
// ---------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return new Response("Missing ?path", { status: 400 });

  const filePath = await resolveAllowed(rawPath);
  if (!filePath) return new Response("Not found or not allowed", { status: 404 });

  const info = await stat(filePath);
  if (!info.isFile()) return new Response("Not a file", { status: 404 });

  const size = info.size;
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  const range = parseRange(request.headers.get("range"), size);

  const commonHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // A rendered track is stable for its (hashed) filename; let the browser cache
    // it so preview playback + export decode don't re-fetch every time.
    "Cache-Control": "private, max-age=3600",
  };

  if (!range) {
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

// ---------------------------------------------------------------------------
// POST — render an SFX track from pre-computed events, return its path + url.
// ---------------------------------------------------------------------------
interface SfxEventPayload {
  sfx: unknown;
  atMs: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let body: { events?: SfxEventPayload[]; durationMs?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected JSON body" }, 400);
  }

  const rawEvents = Array.isArray(body.events) ? body.events : null;
  const durationMs = Number(body.durationMs);
  if (!rawEvents || rawEvents.length === 0) {
    return json({ error: "events must be a non-empty array" }, 400);
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return json({ error: "durationMs must be a positive number" }, 400);
  }

  // Validate + normalize each event to the engine's {sfx, at_ms} shape. Reject
  // anything malformed so a bad payload can't reach the shell command.
  const events: { sfx: string; at_ms: number }[] = [];
  for (const e of rawEvents) {
    const sfx = typeof e.sfx === "string" ? e.sfx : "";
    const atMs = Number(e.atMs);
    // Library keys are simple lowercase/underscore identifiers; refuse the rest.
    if (!/^[a-z0-9_]{1,40}$/.test(sfx)) continue;
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > durationMs) continue;
    events.push({ sfx, at_ms: Math.round(atMs) });
  }
  if (events.length === 0) {
    return json({ error: "no valid events after validation" }, 400);
  }

  await mkdir(SFX_DIR, { recursive: true });

  // Hash the events + duration so an identical plan reuses one filename (and the
  // browser cache), while any edit mints a fresh file that won't clobber a WAV
  // still referenced on the timeline.
  const shortHash = createHash("sha1")
    .update(JSON.stringify({ events, durationMs }))
    .digest("hex")
    .slice(0, 10);
  const outPath = path.join(SFX_DIR, `sfx-${shortHash}.wav`);
  const eventsPath = path.join(SFX_DIR, `sfx-${shortHash}.events.json`);

  try {
    await writeFile(eventsPath, JSON.stringify(events));
    // uv resolves the engine's pinned .venv from ENGINE_DIR. No shell string
    // interpolation — execFile passes args as an array, so the paths above are
    // never re-parsed by a shell.
    await execFileAsync(
      "uv",
      [
        "run",
        "python",
        "build_sfx_track.py",
        "--events-json",
        eventsPath,
        "--output",
        outPath,
        "--duration-ms",
        String(Math.round(durationMs)),
      ],
      { cwd: ENGINE_DIR, maxBuffer: 8 * 1024 * 1024, timeout: 280_000 }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "SFX engine failed";
    return json({ error: `SFX render failed: ${message}` }, 500);
  } finally {
    // The events JSON is a transient input; the WAV is the deliverable.
    await rm(eventsPath, { force: true }).catch(() => {});
  }

  // Confirm the engine actually wrote the file before reporting success.
  try {
    const info = await stat(outPath);
    if (!info.isFile() || info.size === 0) {
      return json({ error: "SFX engine produced no output" }, 500);
    }
  } catch {
    return json({ error: "SFX engine produced no output" }, 500);
  }

  return json({
    ok: true,
    path: outPath,
    // The stable proxy URL the studio stores as `SfxTrack.src` (survives reload).
    url: `/api/repurpose/sfx?path=${encodeURIComponent(outPath)}`,
  });
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
