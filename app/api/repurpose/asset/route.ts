// ===========================================================================
// /api/repurpose/asset  —  local overlay-media store for Repurpose Studio
// ===========================================================================
// WHY THIS EXISTS: overlays (free-floating image/video media dropped onto the
// timeline) must survive a page reload. A browser blob: URL dies on refresh and
// a raw OS path can't be assigned to <img>/<video>. So this route is the durable
// bridge: POST persists the picked file to disk (~/Downloads/repurpose-overlays)
// and hands back a stable absolute path; GET streams an IMAGE back over HTTP so
// the compositor can draw it. It is the IMAGE sibling of /api/repurpose/video --
// videos keep flowing through that route; this one adds still-image serving with
// the same byte-range + allow-list security, and never widens the video route.
//
// SECURITY: local-only side project (never deployed). GET only serves files
// under an allow-list of home media roots, resolves symlinks, and re-checks
// containment after realpath so `..` / symlink escapes can't read arbitrary
// files. POST validates a kebab name + an image/video extension allow-list and
// writes only inside the dedicated overlays dir. Node runtime required for fs.
// ===========================================================================

import { createReadStream } from "node:fs";
import { stat, realpath, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Where persisted overlay media lands. mkdir -p'd on first write.
const OVERLAY_DIR = path.join(os.homedir(), "Downloads", "repurpose-overlays");

// Kebab-case, 2..61 chars. Same shape as the reel-overlay upload route.
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

// Image + video extensions we accept on upload. Videos are persisted here too so
// an overlay clip survives reload; they are streamed back via /api/repurpose/video
// (which owns the range + faststart logic), while stills stream via this route's GET.
const ALLOWED_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "m4v", "webm",
  // Audio (background-music track uploads). Persisted here + streamed back via
  // this route's GET, same as stills. Videos still stream via /api/repurpose/video.
  "mp3", "wav", "m4a", "aac", "ogg",
]);

// ---------------------------------------------------------------------------
// GET — stream a persisted IMAGE with byte-range (206) support.
// ---------------------------------------------------------------------------

// Roots a GET is allowed to read from. Mirrors /api/repurpose/video's allow-list
// (overlays live under ~/Downloads); generated/temp inputs live in the OS temp dir.
const ALLOWED_ROOTS: string[] = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Movies"),
  os.tmpdir(),
];

// IMAGE containers this route serves. Deliberately narrower than the video route:
// videos are streamed by /api/repurpose/video, so this endpoint can't be turned
// into a generic file exfiltration path. (Extension gate for both POST and GET.)
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // Audio (background-music track). Served with range support like the stills so
  // a <audio>/decode can seek. Videos are still owned by /api/repurpose/video.
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve + validate the requested path against the allow-list (image ext only). */
async function resolveAllowed(rawPath: string): Promise<string | null> {
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

  const filePath = await resolveAllowed(rawPath);
  if (!filePath) {
    return new Response("Not found or not allowed", { status: 404 });
  }

  const info = await stat(filePath);
  if (!info.isFile()) {
    return new Response("Not a file", { status: 404 });
  }

  const size = info.size;
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  const range = parseRange(request.headers.get("range"), size);

  const commonHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Overlay stills are small and stable for a session; let the browser cache
    // them so the compositor isn't re-fetching every frame.
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
// POST — persist a picked overlay file to disk, return its absolute path.
// ---------------------------------------------------------------------------
// Multipart body with field "file" + "name" (kebab-case). Writes the bytes to
// ~/Downloads/repurpose-overlays/<name>-<shorthash>.<ext>. The short hash (from
// name + size + time) keeps re-adds of the same-named file from clobbering an
// earlier overlay that's still referenced on the timeline.

export async function POST(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response(
      JSON.stringify({ error: "expected multipart/form-data" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const name = String(formData.get("name") ?? "").trim();
  const file = formData.get("file");
  if (!NAME_RE.test(name)) {
    return new Response(JSON.stringify({ error: "name must be kebab-case" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!(file instanceof File)) {
    return new Response(JSON.stringify({ error: "file field missing" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const origExt = path.extname(file.name).toLowerCase().replace(".", "");
  if (!ALLOWED_EXT.has(origExt)) {
    return new Response(
      JSON.stringify({ error: "unsupported file type" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const shortHash = createHash("sha1")
    .update(`${name}:${buf.length}:${Date.now()}`)
    .digest("hex")
    .slice(0, 8);

  await mkdir(OVERLAY_DIR, { recursive: true });
  const dest = path.join(OVERLAY_DIR, `${name}-${shortHash}.${origExt}`);
  await writeFile(dest, buf);

  return new Response(JSON.stringify({ ok: true, path: dest }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
