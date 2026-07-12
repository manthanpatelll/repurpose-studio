"use client";

// ===========================================================================
// FilesPanel -- "Files" media bin (Inspector rail)
// ===========================================================================
// A compact media bin (like Descript's Files panel) for the images, videos, and
// audio Manthan wants to reuse across THIS Short. It is a REGISTRY, not a place:
// importing a file copies its bytes to disk (/api/repurpose/asset) and registers
// a MediaAsset row in the store -- it does NOT touch the timeline. Clicking a row
// is what PLACES the asset:
//   - image/video -> addOverlay at the current playhead (proxied stable src),
//   - audio        -> setMusicTrack (drops on the Music row).
// So one import can be re-placed any number of times without re-uploading.
//
// The multipart upload + kebab-name + intrinsic-dims/duration probes mirror
// MusicPanel + lib/repurpose/overlay-ingest (same copy-to-disk contract, same
// error UI). Coral accent to match the Files metaphor.
// ===========================================================================

import { useCallback, useRef, useState } from "react";
import {
  FolderOpen,
  Plus,
  CircleNotch,
  Trash,
  Warning,
  Headphones,
  Check,
} from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { overlayUrlForPath } from "@/lib/repurpose/overlay-ingest";

/** kebab-case a filename stem for the asset route's `name` field (2..61 chars). */
function kebabName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  let kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (kebab.length < 2) kebab = `media-${kebab}`.replace(/-+$/g, "");
  if (kebab.length < 2) kebab = "media-file";
  return kebab.slice(0, 61);
}

/** The intrinsic measurements read off a throwaway element. */
interface MediaProbe {
  width: number;
  height: number;
  /** Source duration in seconds (0 for stills). */
  duration: number;
}

/** Read an image's intrinsic pixel size off a throwaway <img>. */
function probeImage(url: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
    };
    img.onerror = () => reject(new Error("Could not decode that image"));
    img.src = url;
  });
}

/** Read a video's intrinsic size + duration off a throwaway <video> (muted, metadata). */
function probeVideo(url: string): Promise<MediaProbe> {
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
    video.src = url;
  });
}

/** Read an audio file's intrinsic duration off a throwaway <audio>. */
function probeAudio(url: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const d = Number.isFinite(audio.duration) ? audio.duration : 0;
      resolve({ width: 0, height: 0, duration: Math.max(0, d) });
    };
    audio.onerror = () => reject(new Error("Could not decode that audio file"));
    audio.src = url;
  });
}

/** A short human label for a kind, shown next to the file name. */
function kindLabel(kind: "image" | "video" | "audio"): string {
  return kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio";
}

// Extension -> kind maps. The single source of truth for classifying a file by
// its NAME when the MIME type is missing/unreliable. Kept in sync with the asset
// route's ALLOWED_EXT set (app/api/repurpose/asset/route.ts).
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg"]);

/** Classify by file extension alone (the fallback when MIME is empty). */
function kindFromExt(nameOrPath: string): "image" | "video" | "audio" | null {
  const ext = nameOrPath.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/**
 * Classify a picked File: MIME type first (the reliable signal when present),
 * then fall back to the file extension. Returns null for anything that is not a
 * supported image/video/audio file. The extension fallback is what fixes an
 * "import did nothing" report for files whose `type` comes through empty.
 */
function classifyFile(file: File): "image" | "video" | "audio" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return kindFromExt(file.name);
}

export function FilesPanel() {
  const mediaAssets = useRepurposeStore((s) => s.mediaAssets);
  const addMediaAsset = useRepurposeStore((s) => s.addMediaAsset);
  const removeMediaAsset = useRepurposeStore((s) => s.removeMediaAsset);
  const addOverlay = useRepurposeStore((s) => s.addOverlay);
  const setMusicTrack = useRepurposeStore((s) => s.setMusicTrack);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Id of the row that just flashed an "Added" confirmation (~1s).
  const [placedId, setPlacedId] = useState<string | null>(null);
  // "Add by path" field -- lets Manthan (or Claude, handing over a path) register
  // an on-disk file already copied into the media dir without the file picker.
  const [pathInput, setPathInput] = useState("");
  // True while a FILE drag hovers the panel -- paints the coral drop ring so it
  // reads as a live drop target (Canva/Descript-style).
  const [dragging, setDragging] = useState(false);

  const openPicker = useCallback(() => {
    if (uploading) return;
    inputRef.current?.click();
  }, [uploading]);

  // The shared import core: copy each supported File to disk + register it in the
  // bin. Used by BOTH the file picker and drag-and-drop, so the two entry points
  // stay byte-for-byte identical (classify -> upload -> probe -> addMediaAsset).
  const importFiles = useCallback(
    async (picked: File[]) => {
      if (picked.length === 0) return;

      setError(null);
      setUploading(true);
      try {
        let skipped = 0;
        for (const file of picked) {
          // Classify by MIME first, then fall back to the file extension -- some
          // sources (Finder drags, certain OSes) hand over a File with an empty
          // `type`, which would otherwise be silently skipped and look like "the
          // import did nothing". The extension fallback keeps those working.
          const kind = classifyFile(file);
          if (!kind) {
            skipped += 1;
            continue;
          }

          try {
            // 1. Copy the bytes to disk -> stable absolute path.
            const form = new FormData();
            form.append("file", file);
            form.append("name", kebabName(file.name || "media-file"));
            const res = await fetch("/api/repurpose/asset", { method: "POST", body: form });
            if (!res.ok) {
              throw new Error(`Upload failed (${res.status})`);
            }
            const json = (await res.json()) as { ok?: boolean; path?: string; error?: string };
            if (!json.ok || !json.path) {
              throw new Error(json.error || "Upload returned no path");
            }
            const path = json.path;

            // 2. Derive the proxied src (video rides the video route, image/audio
            //    ride the asset route).
            const src =
              kind === "audio"
                ? `/api/repurpose/asset?path=${encodeURIComponent(path)}`
                : overlayUrlForPath(path, kind);

            // 3. Read intrinsic dims/duration off a throwaway element.
            const probe: MediaProbe =
              kind === "video"
                ? await probeVideo(src)
                : kind === "audio"
                  ? await probeAudio(src)
                  : await probeImage(src);

            // 4. Register into the bin ONLY (dedupes on sourcePath in the store).
            addMediaAsset({
              kind,
              name: file.name,
              src,
              sourcePath: path,
              naturalWidth: kind === "audio" ? undefined : probe.width > 0 ? probe.width : 1,
              naturalHeight: kind === "audio" ? undefined : probe.height > 0 ? probe.height : 1,
              srcDuration: probe.duration > 0 ? probe.duration : undefined,
            });
          } catch (err) {
            // One bad file shouldn't abort the rest of a multi-file import.
            console.error("Files import failed for", file.name, err);
            setError(
              err instanceof Error ? err.message : `Could not import ${file.name}.`
            );
          }
        }
        // Never fail silently: if every picked file was an unsupported type, say so
        // instead of leaving the panel looking like nothing happened.
        if (skipped > 0) {
          setError(
            `Skipped ${skipped} file${skipped > 1 ? "s" : ""} -- unsupported type. Use an image, video, or audio file.`
          );
        }
      } finally {
        setUploading(false);
      }
    },
    [addMediaAsset]
  );

  const handleFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Snapshot the FileList into a real array BEFORE resetting the input.
      // `e.target.files` is a LIVE list -- setting `e.target.value = ""` empties it
      // in place, so reading it after the reset would see length 0 and silently
      // bail (the "Import does nothing" bug). Copy first, then reset.
      const picked = e.target.files ? Array.from(e.target.files) : [];
      // Reset the input so re-picking the same file re-fires onChange.
      e.target.value = "";
      void importFiles(picked);
    },
    [importFiles]
  );

  // --- drag-and-drop onto the panel -----------------------------------------
  // Drop files anywhere on the Files section to import them (Canva/Descript feel).
  // Only a genuine FILE drag counts -- an internal clip/overlay drag never puts
  // "Files" in dataTransfer.types, so it's ignored. dragOver.preventDefault is what
  // marks the panel a valid drop target (without it the browser opens the file).
  const dragCarriesFiles = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    return types ? Array.from(types).includes("Files") : false;
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!dragCarriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragging) setDragging(true);
    },
    [dragCarriesFiles, dragging]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore leaves that just cross onto a child element still inside the panel.
    const container = e.currentTarget as HTMLElement;
    const next = e.relatedTarget;
    if (next instanceof Node && container.contains(next)) return;
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragCarriesFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const dropped = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
      void importFiles(dropped);
    },
    [dragCarriesFiles, importFiles]
  );

  // Register a file that is ALREADY on disk, by path. Accepts either a raw OS
  // path (/Users/.../foo.png) or an already-proxied URL (/api/repurpose/asset?path=...
  // or /api/repurpose/video?path=...). Infers the kind from the file extension,
  // builds the proxied src, probes dims/duration, and registers into the bin. This
  // is the hand-off path: Claude copies a file into the media dir from the IDE,
  // hands over the path, and Manthan pastes it here. No timeline placement.
  const importByPath = useCallback(async () => {
    const raw = pathInput.trim();
    if (!raw || uploading) return;

    // Recover the underlying on-disk path from a proxied URL if one was pasted,
    // else treat the input as a raw OS path.
    let osPath = raw;
    const proxyMatch = raw.match(/[?&]path=([^&]+)/);
    if (proxyMatch) {
      try {
        osPath = decodeURIComponent(proxyMatch[1]);
      } catch {
        osPath = proxyMatch[1];
      }
    }

    const kind = kindFromExt(osPath);
    if (!kind) {
      const ext = osPath.split(".").pop()?.toLowerCase() ?? "";
      setError(`Unsupported file type ".${ext}". Use an image, video, or audio file.`);
      return;
    }

    setError(null);
    setUploading(true);
    try {
      // A raw OS path proxies through the asset/video route; an already-proxied URL
      // is used as-is. overlayUrlForPath handles both for image/video; audio always
      // rides the asset route.
      const src =
        /^\/api\//.test(raw)
          ? raw
          : kind === "audio"
            ? `/api/repurpose/asset?path=${encodeURIComponent(osPath)}`
            : overlayUrlForPath(osPath, kind);

      const probe: MediaProbe =
        kind === "video"
          ? await probeVideo(src)
          : kind === "audio"
            ? await probeAudio(src)
            : await probeImage(src);

      const name = osPath.split(/[\\/]/).pop() || osPath;
      addMediaAsset({
        kind,
        name,
        src,
        sourcePath: osPath,
        naturalWidth: kind === "audio" ? undefined : probe.width > 0 ? probe.width : 1,
        naturalHeight: kind === "audio" ? undefined : probe.height > 0 ? probe.height : 1,
        srcDuration: probe.duration > 0 ? probe.duration : undefined,
      });
      setPathInput("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load that path. Check the file exists and is in an allowed folder."
      );
    } finally {
      setUploading(false);
    }
  }, [pathInput, uploading, addMediaAsset]);

  // Place an asset: image/video -> overlay at the playhead, audio -> Music row.
  const placeAsset = useCallback(
    (id: string) => {
      const asset = useRepurposeStore.getState().mediaAssets.find((a) => a.id === id);
      if (!asset) return;

      if (asset.kind === "audio") {
        setMusicTrack({
          src: asset.src,
          sourcePath: asset.sourcePath ?? "",
          name: asset.name,
          srcDuration: asset.srcDuration ?? 0,
          startAtSec: 0,
          gain: 1,
        });
      } else {
        const atTime = useRepurposeStore.getState().playhead;
        addOverlay({
          kind: asset.kind,
          src: asset.src,
          sourcePath: asset.sourcePath,
          naturalWidth: asset.naturalWidth ?? 1,
          naturalHeight: asset.naturalHeight ?? 1,
          atTime,
          srcDuration: asset.kind === "video" ? asset.srcDuration : undefined,
        });
      }

      // Flash an inline "Added" confirmation on the placed row for ~1s.
      setPlacedId(id);
      window.setTimeout(() => {
        setPlacedId((cur) => (cur === id ? null : cur));
      }, 1000);
    },
    [addOverlay, setMusicTrack]
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative rounded-lg transition-colors ${
        dragging
          ? "outline-dashed outline-2 outline-offset-4 outline-[#FF6B35] bg-[#FF6B35]/[0.06]"
          : "outline-none"
      }`}
    >
      {/* Full-panel drop overlay while a file drag hovers -- Canva/Descript feel. */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg">
          <span className="flex items-center gap-1.5 rounded-md bg-[#FF6B35] px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg">
            <Plus size={13} weight="bold" />
            Drop to import
          </span>
        </div>
      )}

      <div className="mb-2.5 flex items-center gap-1.5">
        <FolderOpen size={14} weight="bold" className="text-[#FF6B35]" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Files
        </h3>
      </div>

      {/* Hidden multi-picker for images, videos, and audio. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={handleFiles}
      />

      <button
        type="button"
        onClick={openPicker}
        disabled={uploading}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-[#FF6B35]/50 bg-[#FF6B35]/15 px-3 py-2 text-xs font-semibold text-[#FFCDB8] transition-colors hover:bg-[#FF6B35]/25 disabled:cursor-default disabled:opacity-60"
      >
        {uploading ? (
          <>
            <CircleNotch size={15} weight="bold" className="animate-spin" />
            Importing&hellip;
          </>
        ) : (
          <>
            <Plus size={15} weight="bold" />
            Import
          </>
        )}
      </button>

      {/* Add by path -- register a file already on disk (Claude hands over a path,
          or paste a proxied /api/... URL). Enter or the + button submits. */}
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void importByPath();
            }
          }}
          disabled={uploading}
          placeholder="Add by path (/Users/…/file.png)"
          className="min-w-0 flex-1 rounded-md border border-border bg-secondary px-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:border-[#FF6B35]/60 focus:outline-none disabled:opacity-60"
          aria-label="Add media by file path"
        />
        <button
          type="button"
          onClick={() => void importByPath()}
          disabled={uploading || pathInput.trim().length === 0}
          className="flex shrink-0 items-center justify-center rounded-md border border-border bg-secondary px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          title="Register this on-disk file in Files"
          aria-label="Add media by path"
        >
          <Plus size={14} weight="bold" />
        </button>
      </div>

      {mediaAssets.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          No files yet. Import media to reuse across this Short.
        </p>
      ) : (
        <ul className="mt-2.5 space-y-1">
          {mediaAssets.map((asset) => {
            const placed = placedId === asset.id;
            return (
              <li
                key={asset.id}
                className="group flex items-center gap-2 rounded-md border border-border bg-secondary/40 pr-1.5 transition-colors hover:bg-secondary/70"
              >
                <button
                  type="button"
                  onClick={() => placeAsset(asset.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                  title={
                    asset.kind === "audio"
                      ? "Add as background music"
                      : "Place at the playhead"
                  }
                >
                  {/* ~28px thumbnail / kind glyph. */}
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded bg-black/40">
                    {asset.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={asset.src}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : asset.kind === "video" ? (
                      <video
                        src={asset.src}
                        muted
                        preload="metadata"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Headphones size={15} weight="bold" className="text-indigo-400" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-foreground">
                      {asset.name}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {kindLabel(asset.kind)}
                      {asset.srcDuration && asset.srcDuration > 0
                        ? ` · ${Math.round(asset.srcDuration)}s`
                        : ""}
                    </span>
                  </span>
                </button>

                {placed ? (
                  <span className="flex shrink-0 items-center gap-1 pr-1 text-[10px] font-semibold text-emerald-400">
                    <Check size={13} weight="bold" />
                    Added
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => removeMediaAsset(asset.id)}
                    className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100"
                    title="Delete everywhere (removes from Files and the timeline)"
                    aria-label={`Delete ${asset.name} from Files and the timeline`}
                  >
                    <Trash size={13} weight="bold" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-red-300">
          <Warning size={13} weight="fill" className="mt-px shrink-0 text-red-500" />
          {error}
        </p>
      )}
    </div>
  );
}
