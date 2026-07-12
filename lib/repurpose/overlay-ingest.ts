// ===========================================================================
// REPURPOSE STUDIO -- overlay ingest
// ===========================================================================
// The shared pipeline that turns a picked/dropped/pasted image or video File
// into a persisted Overlay in the store. It is the ONE place an overlay comes
// into existence, no matter the entry point (drag-drop onto the timeline, paste
// from the clipboard, or the "Add media" button in the Inspector).
//
// WHY A COPY-TO-DISK STEP: a browser blob: URL (URL.createObjectURL) dies the
// moment the page reloads, so an overlay stored with a bare blob: src would go
// dead on refresh. Instead we POST the raw bytes to /api/repurpose/asset, which
// writes them under ~/Downloads/repurpose-overlays and hands back a STABLE
// absolute path; that path is proxied through a range-serving route so <img>/
// <video> can load it, and it survives reload. The temporary blob: URL is used
// ONLY to read the file's intrinsic dimensions/duration (a throwaway <img>/
// <video>), then immediately revoked -- the persisted `src` is never a blob URL.
//
// FALLBACK: if the disk copy fails (route down / offline), we keep the overlay
// on the transient blob: URL and mark it needsReconnect so the session still
// works; a reload will surface the reconnect path rather than a dead frame.
// ===========================================================================

import { footageUrlForPath } from "./ingest";
import { useRepurposeStore } from "./store";

/**
 * Resolve an overlay's on-disk (or already-loadable) source reference into a URL
 * an <img>/<video> can actually load. Images are proxied through the still-image
 * range route (`/api/repurpose/asset?path=...`); videos ride the existing footage
 * video route (`/api/repurpose/video?path=...`, which owns range + faststart).
 * Already-loadable references (blob:, data:, http(s):, app-relative /api/...)
 * pass straight through -- this only rewrites raw OS paths.
 */
export function overlayUrlForPath(ref: string, kind: "image" | "video"): string {
  if (ref === "") return ref;
  // Anything already loadable by the browser (a scheme, protocol-relative, or an
  // app-root URL) is returned untouched. footageUrlForPath handles that same set
  // plus the video-path proxy, so reuse it for videos directly.
  if (kind === "video") return footageUrlForPath(ref);

  // Images: pass loadable URLs through, proxy raw disk paths via the asset route.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/api/")) {
    return ref;
  }
  const looksLikeOsPath =
    ref.startsWith("/Users/") ||
    ref.startsWith("/home/") ||
    ref.startsWith("/var/") ||
    ref.startsWith("/tmp/") ||
    ref.startsWith("/private/") ||
    /^[A-Za-z]:[\\/]/.test(ref);
  if (looksLikeOsPath) {
    return `/api/repurpose/asset?path=${encodeURIComponent(ref)}`;
  }
  return ref;
}

/** Intrinsic media measurements read off a throwaway element. */
interface MediaProbe {
  width: number;
  height: number;
  /** Source duration in seconds (0 for stills). */
  duration: number;
}

/**
 * Read an image's intrinsic pixel size from a temporary object URL. The URL is
 * the caller's to revoke (we don't revoke here -- the same URL doubles as the
 * blob: fallback src if the disk copy later fails).
 */
function probeImage(objectUrl: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
    };
    img.onerror = () => reject(new Error("Could not decode that image"));
    img.src = objectUrl;
  });
}

/**
 * Read a video's intrinsic size + duration from a temporary object URL. Muted +
 * preload="metadata" -- an overlay never emits audio and we only need the header.
 */
function probeVideo(objectUrl: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Math.max(0, duration),
      });
    };
    video.onerror = () => reject(new Error("Could not decode that video"));
    video.src = objectUrl;
  });
}

/** kebab-case a filename stem for the asset route's `name` field (2..61 chars). */
function kebabName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  let kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (kebab.length < 2) kebab = `overlay-${kebab}`.replace(/-+$/g, "");
  if (kebab.length < 2) kebab = "overlay-media";
  return kebab.slice(0, 61);
}

/**
 * POST the raw bytes to /api/repurpose/asset (copy-to-disk) and return the stable
 * absolute path the route wrote. Throws on any non-ok response so the caller can
 * fall back to the blob: URL.
 */
async function persistToDisk(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("name", kebabName(file.name || "overlay-media"));
  const res = await fetch("/api/repurpose/asset", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`asset upload failed (${res.status})`);
  }
  const json = (await res.json()) as { ok?: boolean; path?: string; error?: string };
  if (!json.ok || !json.path) {
    throw new Error(json.error || "asset upload returned no path");
  }
  return json.path;
}

/** The result of an ingest -- the new overlay id, plus whether it fell back. */
export interface IngestOverlayResult {
  /** The store id of the created overlay (`ovl-N`). */
  id: string;
  /**
   * True when the disk copy failed and the overlay is on a transient blob: URL
   * (needsReconnect) -- it works this session but won't survive a reload.
   */
  needsReconnect: boolean;
}

/**
 * The shared ingest pipeline. Given a picked image/video File, an output time to
 * place it at (playhead or drop time), and an optional normalized drop point on
 * the 9:16 canvas:
 *   1. createObjectURL ONLY to read intrinsic dims/duration off a throwaway
 *      <img>/<video>,
 *   2. POST the bytes to /api/repurpose/asset (copy to disk) -> stable path,
 *   3. addOverlay with the proxied stable src (never a bare blob: URL),
 *   4. revoke the temp object URL.
 * On upload failure: keep the blob: URL as a transient src and flag needsReconnect
 * so the session still plays; a reload then asks Manthan to re-add it.
 *
 * Returns null for a file that isn't an image or video (caller ignores it).
 */
export async function ingestOverlayFile(
  file: File,
  atTime: number,
  atPoint?: { x: number; y: number }
): Promise<IngestOverlayResult | null> {
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  if (!isImage && !isVideo) return null;
  const kind: "image" | "video" = isVideo ? "video" : "image";

  // (1) Throwaway object URL, used only to measure the media (and, if the disk
  // copy fails, kept alive as the transient fallback src).
  const objectUrl = URL.createObjectURL(file);
  let probe: MediaProbe;
  try {
    probe = isVideo ? await probeVideo(objectUrl) : await probeImage(objectUrl);
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
  // A media file with no readable dimensions is unusable as an overlay.
  const naturalWidth = probe.width > 0 ? probe.width : 1;
  const naturalHeight = probe.height > 0 ? probe.height : 1;

  const addOverlay = useRepurposeStore.getState().addOverlay;

  // (2) Copy to disk. On success the persisted src is the proxied stable path;
  // on failure we keep the blob: URL (transient) and flag needsReconnect.
  let src: string;
  let sourcePath: string | undefined;
  let needsReconnect = false;
  try {
    const diskPath = await persistToDisk(file);
    sourcePath = diskPath;
    src = overlayUrlForPath(diskPath, kind);
  } catch {
    // Disk copy failed -- fall back to the transient blob: URL for this session.
    src = objectUrl;
    needsReconnect = true;
  }

  // (3) Register the overlay.
  const id = addOverlay({
    kind,
    src,
    sourcePath,
    naturalWidth,
    naturalHeight,
    atTime,
    srcDuration: isVideo ? probe.duration : undefined,
    atPoint,
  });

  // (3b) Auto-register the source in the Files bin so it can be re-placed later
  // without re-importing. Dedupes on sourcePath in the store, so dropping the same
  // file twice never grows a duplicate row.
  useRepurposeStore.getState().addMediaAsset({
    kind,
    name: file.name || (isVideo ? "video" : "image"),
    src,
    sourcePath,
    naturalWidth,
    naturalHeight,
    srcDuration: isVideo ? probe.duration : undefined,
  });

  // (4) Revoke the temp object URL -- UNLESS it's now doing double duty as the
  // fallback src (disk copy failed), in which case it must stay alive.
  if (!needsReconnect) {
    URL.revokeObjectURL(objectUrl);
  }

  return { id, needsReconnect };
}

/**
 * Ingest EVERY image/video File in a list (a multi-file drop / paste / picker),
 * one after another, all placed at the same output time + drop point. Non-media
 * files are skipped. Returns the results for the files that produced an overlay.
 */
export async function ingestOverlayFiles(
  files: FileList | File[],
  atTime: number,
  atPoint?: { x: number; y: number }
): Promise<IngestOverlayResult[]> {
  const results: IngestOverlayResult[] = [];
  for (const file of Array.from(files)) {
    try {
      const res = await ingestOverlayFile(file, atTime, atPoint);
      if (res) results.push(res);
    } catch (err) {
      // One bad file shouldn't abort the rest of a multi-file drop.
      console.error("Overlay ingest failed for", file.name, err);
    }
  }
  return results;
}
