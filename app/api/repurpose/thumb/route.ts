// ===========================================================================
// /api/repurpose/thumb  —  project thumbnail for the Repurpose Studio hub
// ===========================================================================
// GET ?id=<projectId> renders (once) and streams a square 480x480 JPEG that
// mirrors the reel's signature layout: screen band on top, face band below,
// split at the project's resolved splitRatio, both cover-cropped. The frame is
// pulled from the FIRST KEPT take clip (face + screen are frame-locked, so one
// source-time drives both). The screen band is BOTTOM-ANCHORED.
//
// Cached on disk at ~/Downloads/repurpose-projects/.thumbs/<id>.jpg and only
// re-rendered when the project file is newer than the cached jpeg. The hub
// busts the browser cache by appending ?v=<updatedAt>. Any failure (missing
// footage, ffmpeg error) returns 404 and the tile falls back to its gradient.
// ===========================================================================

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { PROJECTS_DIR, isValidProjectId, readProject } from "@/lib/repurpose/projects";
import type { Clip } from "@/lib/repurpose/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const execFileAsync = promisify(execFile);

const THUMBS_DIR = path.join(PROJECTS_DIR, ".thumbs");
const THUMB_SIZE = 480;

// De-dupe concurrent renders of the same project (the hub mounts a whole list
// at once; two <img> loads for one id must not race two ffmpeg processes).
const inFlight = new Map<string, Promise<string | null>>();

function thumbPath(id: string): string {
  return path.join(THUMBS_DIR, `${id}.jpg`);
}

/**
 * Resolve a footageMeta path to an absolute on-disk file. Snapshots store the
 * STREAMING url (`/api/repurpose/video?path=<encoded abs path>`), not the raw
 * path -- unwrap the `path` query param when present; a plain absolute path
 * passes through. Returns null when the file doesn't resolve or exist.
 */
function resolveFootagePath(p: string | undefined | null): string | null {
  if (!p) return null;
  let disk = p;
  if (p.startsWith("/api/")) {
    try {
      disk = new URL(p, "http://localhost").searchParams.get("path") ?? "";
    } catch {
      return null;
    }
  }
  if (!disk || !path.isAbsolute(disk)) return null;
  return fs.existsSync(disk) ? disk : null;
}

/** Cover-crop one band: scale up to cover w x h, then crop. */
function bandFilter(
  input: string,
  w: number,
  h: number,
  anchor: "bottom" | "center",
  label: string,
): string {
  const y = anchor === "bottom" ? `in_h-${h}` : `(in_h-${h})/2`;
  return `[${input}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(in_w-${w})/2:${y}[${label}]`;
}

/**
 * Render the thumbnail jpeg for a project, or return null when it can't be
 * built (no footage meta, files gone, no kept clip, ffmpeg failure).
 */
async function renderThumb(id: string): Promise<string | null> {
  const project = readProject(id);
  if (!project) return null;

  const { footageMeta, clips, splitRatio } = project.snapshot;
  const facePath = resolveFootagePath(footageMeta?.faceCamPath);
  if (!facePath) return null;
  const screenPath = resolveFootagePath(footageMeta?.screenPath);

  const first = (clips ?? []).find(
    (c: Clip) => c.kept && c.kind === "take" && c.srcEnd > c.srcStart,
  );
  if (!first) return null;

  // Sample a beat into the clip so the frame isn't a cut-boundary blur, and use
  // the first clip's own split override when it carries one.
  const t = Math.min(first.srcStart + 1, (first.srcStart + first.srcEnd) / 2);
  const split = Math.min(0.6, Math.max(0.4, first.splitRatio ?? splitRatio ?? 0.5));

  const topH = Math.round(THUMB_SIZE * split);
  const botH = THUMB_SIZE - topH;

  const out = thumbPath(id);
  fs.mkdirSync(THUMBS_DIR, { recursive: true });

  const args: string[] = ["-y", "-ss", t.toFixed(3), "-i", facePath];
  let filter: string;
  if (screenPath) {
    args.push("-ss", t.toFixed(3), "-i", screenPath);
    filter = [
      bandFilter("1:v", THUMB_SIZE, topH, "bottom", "top"),
      bandFilter("0:v", THUMB_SIZE, botH, "center", "bot"),
      "[top][bot]vstack",
    ].join(";");
  } else {
    filter = `[0:v]scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=increase,crop=${THUMB_SIZE}:${THUMB_SIZE}`;
  }
  args.push("-filter_complex", filter, "-frames:v", "1", "-q:v", "4", out);

  try {
    await execFileAsync("ffmpeg", args, { timeout: 30_000 });
  } catch {
    return null;
  }
  return fs.existsSync(out) ? out : null;
}

/** Cached jpeg still fresh? (newer than the project file's last write) */
function freshThumb(id: string): string | null {
  const tp = thumbPath(id);
  try {
    const thumbStat = fs.statSync(tp);
    const projStat = fs.statSync(path.join(PROJECTS_DIR, `${id}.json`));
    return thumbStat.mtimeMs >= projStat.mtimeMs ? tp : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!isValidProjectId(id)) {
    return new Response("bad id", { status: 400 });
  }

  let file = freshThumb(id);
  if (!file) {
    let pending = inFlight.get(id);
    if (!pending) {
      pending = renderThumb(id).finally(() => inFlight.delete(id));
      inFlight.set(id, pending);
    }
    file = await pending;
  }
  if (!file) return new Response("no thumb", { status: 404 });

  const body = new Uint8Array(fs.readFileSync(file));
  return new Response(body, {
    headers: {
      "Content-Type": "image/jpeg",
      // The hub keys the URL on ?v=<updatedAt>, so a long-lived cache is safe.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
