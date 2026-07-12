"use client";

// ===========================================================================
// MusicPanel -- "Background Music" (Inspector rail)
// ===========================================================================
// One panel where Manthan MANUALLY picks a music file. On pick it uploads the
// bytes to /api/repurpose/asset (copy-to-disk -> stable proxied URL), reads the
// file's intrinsic duration off a throwaway <audio> element, then auto-loads it
// onto the timeline's Music row via setMusicTrack. From there the store bakes
// the bed into BOTH the live preview and the exported MP4 (music plays from the
// reel open at gain 1 by default).
//
// This mirrors the SfxPanel's shape (button -> loaded card -> gain slider ->
// error line) but is MANUAL (no generation) and uses an INDIGO accent. The
// multipart upload + kebab-name derivation follow lib/repurpose/overlay-ingest.
// ===========================================================================

import { useCallback, useRef, useState } from "react";
import {
  MusicNote,
  Plus,
  CircleNotch,
  ArrowClockwise,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";

/** kebab-case a filename stem for the asset route's `name` field (2..61 chars). */
function kebabName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  let kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (kebab.length < 1) kebab = "music";
  return `music-${kebab}`.replace(/-+$/g, "").slice(0, 61);
}

/** Read an audio file's intrinsic duration (seconds) off a throwaway <audio>. */
function probeAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const d = Number.isFinite(audio.duration) ? audio.duration : 0;
      resolve(Math.max(0, d));
    };
    audio.onerror = () => reject(new Error("Could not decode that audio file"));
    audio.src = url;
  });
}

export function MusicPanel() {
  const musicTrack = useRepurposeStore((s) => s.musicTrack);
  const setMusicTrack = useRepurposeStore((s) => s.setMusicTrack);
  const clearMusicTrack = useRepurposeStore((s) => s.clearMusicTrack);
  const setMusicGain = useRepurposeStore((s) => s.setMusicGain);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPicker = useCallback(() => {
    if (uploading) return;
    inputRef.current?.click();
  }, [uploading]);

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input up front so re-picking the same file re-fires onChange.
      e.target.value = "";
      if (!file) return;

      setError(null);
      setUploading(true);
      try {
        // 1. Upload the bytes -> stable absolute path.
        const form = new FormData();
        form.append("file", file);
        form.append("name", kebabName(file.name || "music"));
        const res = await fetch("/api/repurpose/asset", { method: "POST", body: form });
        if (!res.ok) {
          throw new Error(`Upload failed (${res.status})`);
        }
        const json = (await res.json()) as { ok?: boolean; path?: string; error?: string };
        if (!json.ok || !json.path) {
          throw new Error(json.error || "Upload returned no path");
        }
        const src = `/api/repurpose/asset?path=${encodeURIComponent(json.path)}`;

        // 2. Read the music's intrinsic duration off a throwaway <audio>.
        const srcDuration = await probeAudioDuration(src);

        // 3. Auto-load onto the Music row (preview + export read this).
        setMusicTrack({
          src,
          sourcePath: json.path,
          name: file.name,
          srcDuration,
          startAtSec: 0,
          gain: 1,
        });

        // 4. Register the file in the media bin so it shows in the Files panel too.
        // The store dedupes on sourcePath, so re-picking the same file is a no-op.
        useRepurposeStore.getState().addMediaAsset({
          kind: "audio",
          name: file.name,
          src,
          sourcePath: json.path,
          srcDuration,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not add that music file.");
      } finally {
        setUploading(false);
      }
    },
    [setMusicTrack]
  );

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-1.5">
        <MusicNote size={14} weight="bold" className="text-indigo-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Background Music
        </h3>
      </div>

      {/* Hidden picker -- shared by "Add music" and "Replace". */}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFile}
      />

      {!musicTrack ? (
        <>
          <button
            type="button"
            onClick={openPicker}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-indigo-500/50 bg-indigo-500/15 px-3 py-2 text-xs font-semibold text-indigo-100 transition-colors hover:bg-indigo-500/25 disabled:cursor-default disabled:opacity-60"
          >
            {uploading ? (
              <>
                <CircleNotch size={15} weight="bold" className="animate-spin" />
                Adding&hellip;
              </>
            ) : (
              <>
                <Plus size={15} weight="bold" />
                Add music
              </>
            )}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Pick an mp3, wav, or m4a. It drops on the timeline&rsquo;s Music row,
            plays from the reel open under the VO, and bakes into the MP4.
          </p>
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-2 text-[11px] text-indigo-200">
            <MusicNote size={14} weight="bold" className="shrink-0 text-indigo-400" />
            <span className="flex-1 truncate">
              &#9834; {musicTrack.name} ({Math.round(musicTrack.srcDuration)}s)
            </span>
          </div>

          {/* Whole-bed gain (0-200%, 100% = as picked). Live, no re-render. */}
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Music volume</span>
              <span className="tabular-nums text-indigo-300">
                {Math.round(musicTrack.gain * 100)}%
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={musicTrack.gain}
              onChange={(e) => setMusicGain(Number(e.target.value))}
              className="w-full accent-indigo-400"
              aria-label="Background music volume"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={openPicker}
              disabled={uploading}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-60"
              title="Pick a different music file"
            >
              <ArrowClockwise size={13} weight="bold" className={uploading ? "animate-spin" : ""} />
              {uploading ? "Adding…" : "Replace"}
            </button>
            <button
              type="button"
              onClick={() => clearMusicTrack()}
              className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-300"
              title="Remove the background music"
              aria-label="Remove background music"
            >
              <Trash size={13} weight="bold" />
            </button>
          </div>
        </div>
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
