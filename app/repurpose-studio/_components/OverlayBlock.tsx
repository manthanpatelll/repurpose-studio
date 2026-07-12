"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TrashSimple, Image as ImageIcon, FilmSlate, Stack } from "@phosphor-icons/react";
import type { Overlay } from "@/lib/repurpose/types";
import { formatTimecode } from "./timeline-utils";

interface OverlayBlockProps {
  overlay: Overlay;
  left: number;
  width: number;
  trackTop: number;
  trackHeight: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDragBodyStart: (overlay: Overlay, pointerX: number) => void;
  onDragEdgeStart: (overlay: Overlay, edge: "start" | "end", pointerX: number) => void;
  onDelete: (id: string) => void;
  /**
   * A decoded poster frame for THIS overlay (an <img> cover for images, a
   * seeked-to-srcStart bitmap for videos), keyed by overlay id in a UI-owned
   * cache (NOT the store). null until decoded -- the block falls back to an
   * icon + filename while it resolves. See Timeline's thumbnail cache.
   */
  thumbUrl?: string | null;
}

/**
 * A single draggable overlay block on the Overlay track. Free-floating media
 * layer: body-drag slides it in output time (moveOverlay, no ripple), edge-drag
 * trims one edge (trimOverlay, frozen-anchor absolute target). Reuses ClipBlock's
 * DRAG PATTERN (body + two edge handles delegating to parent callbacks) but is a
 * distinct component: overlays overlap freely (no reorder logic), carry a z-badge
 * for true stacking order, and read in a VIOLET accent so they stand apart from
 * the coral-selected / teal manual sub-scene clips. A poster-frame thumbnail
 * fills the background when decoded; otherwise an icon + filename.
 */
export function OverlayBlock({
  overlay,
  left,
  width,
  trackTop,
  trackHeight,
  isSelected,
  onSelect,
  onDragBodyStart,
  onDragEdgeStart,
  onDelete,
  thumbUrl = null,
}: OverlayBlockProps) {
  const handleBodyPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      onSelect(overlay.id);
      onDragBodyStart(overlay, e.clientX);
    },
    [overlay, onSelect, onDragBodyStart]
  );

  const handleEdgePointerDown = useCallback(
    (edge: "start" | "end") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(overlay.id);
      onDragEdgeStart(overlay, edge, e.clientX);
    },
    [overlay, onSelect, onDragEdgeStart]
  );

  const durationLabel = formatTimecode(overlay.timelineEnd - overlay.timelineStart, true);
  const filename = deriveOverlayLabel(overlay);
  const KindIcon = overlay.kind === "image" ? ImageIcon : FilmSlate;

  // Violet accent -- "this is a media layer", distinct from coral (selected clip)
  // and teal (manual sub-scene). Selected gets a brighter ring; idle a muted one.
  const selectedBorder = "border-[#a78bfa] shadow-[0_0_0_2px_rgba(167,139,250,0.4)] z-10";
  const idleBorder = "border-[#7c5cff]/50 hover:border-[#a78bfa] z-0";

  return (
    <div
      data-overlay-id={overlay.id}
      className={`absolute overflow-hidden rounded-md border shadow-sm select-none transition-shadow ${
        isSelected ? selectedBorder : idleBorder
      } bg-[#1a1530]`}
      style={{ left, width: Math.max(width, 6), top: trackTop, height: trackHeight }}
      onPointerDown={handleBodyPointerDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* poster-frame thumbnail (cover) -- fills the block behind the label once
          decoded. Pointer-events-none so it never intercepts the body drag. */}
      {thumbUrl && (
        <div
          className="pointer-events-none absolute inset-0 rounded-md bg-cover bg-center opacity-70"
          style={{ backgroundImage: `url(${thumbUrl})` }}
          aria-hidden
        />
      )}

      {/* violet wash so the label stays legible over any thumbnail */}
      <div
        className="pointer-events-none absolute inset-0 rounded-md"
        style={{
          background: isSelected
            ? "linear-gradient(180deg, rgba(124,92,255,0.34), rgba(124,92,255,0.14))"
            : "linear-gradient(180deg, rgba(124,92,255,0.22), rgba(124,92,255,0.08))",
        }}
        aria-hidden
      />

      {/* left trim edge */}
      <div
        className="absolute left-0 top-0 h-full w-2 rounded-l-md hover:bg-[#a78bfa]/60"
        onPointerDown={handleEdgePointerDown("start")}
      />
      {/* right trim edge */}
      <div
        className="absolute right-0 top-0 h-full w-2 rounded-r-md hover:bg-[#a78bfa]/60"
        onPointerDown={handleEdgePointerDown("end")}
      />

      {/* z-badge -- the overlay's TRUE stacking order, always shown regardless of
          which sub-lane the block landed in (lanes pack by overlap, not by z). */}
      {width > 26 && (
        <div
          className="pointer-events-none absolute left-1 top-1 z-10 flex h-[15px] items-center gap-0.5 rounded bg-[#0d0a1c]/80 px-1 text-[9px] font-semibold tabular-nums text-[#c4b5fd] ring-1 ring-[#a78bfa]/40"
          title={`Layer z${overlay.zIndex}`}
        >
          <Stack size={9} weight="bold" />
          {overlay.zIndex}
        </div>
      )}

      {/* label */}
      <div className="relative flex h-full items-center gap-1 overflow-hidden px-2.5 pointer-events-none">
        <KindIcon size={12} weight="regular" className="shrink-0 text-[#c4b5fd]" />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[11px] font-medium text-neutral-100">{filename}</span>
          {width > 70 && (
            <span className="truncate text-[9px] text-[#c4b5fd]/80">{durationLabel}</span>
          )}
        </div>
      </div>

      {/* delete button, shown on selection */}
      {isSelected && width > 34 && (
        <button
          type="button"
          className="absolute right-1 top-1 z-10 rounded bg-neutral-900/80 p-0.5 text-neutral-300 transition-colors hover:bg-red-600/80 hover:text-white pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(overlay.id);
          }}
          title="Delete overlay"
        >
          <TrashSimple size={11} weight="bold" />
        </button>
      )}
    </div>
  );
}

/**
 * A short human label for an overlay block: the source filename (from sourcePath
 * or the proxied ?path= query), else a generic Image/Video label. Kept pure so
 * the block re-renders cheaply.
 */
function deriveOverlayLabel(overlay: Overlay): string {
  const raw = overlay.sourcePath ?? tryDecodeProxyPath(overlay.src) ?? overlay.src;
  const base = raw.split(/[\\/]/).pop() ?? raw;
  if (base && !base.startsWith("blob:") && !base.startsWith("data:")) return base;
  return overlay.kind === "image" ? "Image" : "Video";
}

/** Pull the on-disk `?path=` back out of a `/api/repurpose/video?path=...` URL. */
function tryDecodeProxyPath(src: string): string | null {
  const idx = src.indexOf("?path=");
  if (idx === -1) return null;
  try {
    return decodeURIComponent(src.slice(idx + "?path=".length));
  } catch {
    return null;
  }
}

/**
 * A tiny UI-owned thumbnail cache hook: resolves a poster-frame object URL for an
 * overlay, keyed by id, decoded lazily on first sight and re-derived on reload
 * (the cache lives in this hook's ref, never the store). Images decode straight
 * from src; videos seek a throwaway <video> to srcStart and grab one frame.
 * Returns a map lookup; unresolved ids yield null (block shows icon + filename).
 *
 * Kept in this file so Timeline can `useOverlayThumbnails(overlays)` once and
 * pass each block its `thumbUrl`.
 */
export function useOverlayThumbnails(overlays: Overlay[]): Map<string, string> {
  // id -> object URL (or "" while a decode is in flight, to dedupe work).
  const cacheRef = useRef<Map<string, string>>(new Map());
  const [, force] = useState(0);

  useEffect(() => {
    const cache = cacheRef.current;
    let cancelled = false;
    const created: string[] = [];

    for (const ov of overlays) {
      const key = thumbKey(ov);
      // Re-derive if src changed for this id (reload -> fresh proxy URL).
      const existing = cache.get(ov.id);
      if (existing !== undefined && existing !== IN_FLIGHT && cache.get(keyMarker(ov.id)) === key) {
        continue;
      }
      if (existing === IN_FLIGHT && cache.get(keyMarker(ov.id)) === key) continue;

      cache.set(ov.id, IN_FLIGHT);
      cache.set(keyMarker(ov.id), key);

      void decodeThumb(ov).then((url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) {
          const prev = cacheRef.current.get(ov.id);
          if (prev && prev !== IN_FLIGHT) URL.revokeObjectURL(prev);
          cacheRef.current.set(ov.id, url);
          created.push(url);
          force((n) => n + 1);
        } else {
          // Decode failed -- drop the in-flight marker so the block keeps its
          // icon+filename fallback (and a later reload can retry).
          if (cacheRef.current.get(ov.id) === IN_FLIGHT) cacheRef.current.delete(ov.id);
        }
      });
    }

    // Evict thumbnails for overlays that no longer exist.
    const live = new Set(overlays.map((o) => o.id));
    for (const id of [...cache.keys()]) {
      if (id.startsWith(KEY_MARKER_PREFIX)) {
        const realId = id.slice(KEY_MARKER_PREFIX.length);
        if (!live.has(realId)) cache.delete(id);
        continue;
      }
      if (!live.has(id)) {
        const url = cache.get(id);
        if (url && url !== IN_FLIGHT) URL.revokeObjectURL(url);
        cache.delete(id);
      }
    }

    return () => {
      cancelled = true;
    };
    // Depend on a stable signature of (id, src) pairs so a src change re-decodes
    // but pure transform/time edits do not.
  }, [overlays]);

  // Revoke every object URL on unmount.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const [id, url] of cache) {
        if (!id.startsWith(KEY_MARKER_PREFIX) && url && url !== IN_FLIGHT) {
          URL.revokeObjectURL(url);
        }
      }
      cache.clear();
    };
  }, []);

  // Return a plain id -> url map (skip markers + in-flight sentinels).
  const out = new Map<string, string>();
  for (const [id, url] of cacheRef.current) {
    if (id.startsWith(KEY_MARKER_PREFIX)) continue;
    if (url && url !== IN_FLIGHT) out.set(id, url);
  }
  return out;
}

const IN_FLIGHT = "__in_flight__";
const KEY_MARKER_PREFIX = "__k__:";
function keyMarker(id: string): string {
  return `${KEY_MARKER_PREFIX}${id}`;
}
function thumbKey(ov: Overlay): string {
  // Videos also key on srcStart so a start-trim re-grabs the poster frame.
  return ov.kind === "video" ? `${ov.src}#${ov.srcStart.toFixed(3)}` : ov.src;
}

/**
 * Decode one poster frame to an object URL. Images: fetch->blob->objectURL
 * directly. Videos: load a muted throwaway <video>, seek to srcStart, draw one
 * frame to a small canvas, export a JPEG blob. Returns null on any failure so
 * the caller falls back to the icon+filename.
 */
async function decodeThumb(ov: Overlay): Promise<string | null> {
  try {
    if (ov.kind === "image") {
      const res = await fetch(ov.src);
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    }
    return await decodeVideoPoster(ov);
  } catch {
    return null;
  }
}

function decodeVideoPoster(ov: Overlay): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true; // overlays are ALWAYS muted -- never emit audio
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    let settled = false;
    const done = (url: string | null) => {
      if (settled) return;
      settled = true;
      video.removeAttribute("src");
      video.load();
      resolve(url);
    };
    const timeout = window.setTimeout(() => done(null), 8000);
    video.addEventListener("error", () => {
      window.clearTimeout(timeout);
      done(null);
    });
    video.addEventListener("loadedmetadata", () => {
      const seekTo = Math.max(0, Math.min(ov.srcStart, Math.max(0, (video.duration || 0) - 0.05)));
      const grab = () => {
        try {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (w <= 0 || h <= 0) {
            window.clearTimeout(timeout);
            done(null);
            return;
          }
          // Small poster: cap the long edge so the object URL stays tiny.
          const maxEdge = 160;
          const s = Math.min(1, maxEdge / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * s));
          const ch = Math.max(1, Math.round(h * s));
          const canvas = document.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            window.clearTimeout(timeout);
            done(null);
            return;
          }
          ctx.drawImage(video, 0, 0, cw, ch);
          canvas.toBlob(
            (blob) => {
              window.clearTimeout(timeout);
              done(blob ? URL.createObjectURL(blob) : null);
            },
            "image/jpeg",
            0.7
          );
        } catch {
          window.clearTimeout(timeout);
          done(null);
        }
      };
      video.addEventListener("seeked", grab, { once: true });
      video.currentTime = seekTo;
    });
    video.src = ov.src;
    video.load();
  });
}
