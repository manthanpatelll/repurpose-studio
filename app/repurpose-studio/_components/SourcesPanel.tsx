"use client";

// ===========================================================================
// REPURPOSE STUDIO -- SourcesPanel
// ===========================================================================
// FOOTAGE / TRANSCRIPT INGEST, now living in the Inspector (right rail) instead
// of the transcript rail. This owns everything take-matching needs to start:
//   1. Load a `<base>.words.json` (raw face-cam words) OR a raw .srt (what
//      Descript exports) + optional final transcript, run the take-matcher
//      pipeline, and push Clip[] into the store (setClips) -- populating the
//      timeline for the first time.
//   2. Point the two source videos at picked media files (setFootageMeta) so
//      the PreviewCanvas composites real footage instead of placeholders.
//   3. Auto-load the staged demo footage on first mount + backfill words for
//      captions on a restored project (both moved here from TranscriptPanel so
//      the transcript rail is purely the editable word view).
//
// LAYOUT: while footage is missing (no footageMeta OR no words) the four
// ingest buttons show PROMINENTLY under a "Sources" header -- that's the first
// thing to do on an empty editor. Once footage is loaded (footageMeta set AND
// words present) it collapses to a single "Re-import footage" fold so the
// grading controls below get the room.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadSimple, Warning, FilmSlate, ImageSquare } from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { FootageMeta } from "@/lib/repurpose/types";
import {
  buildShortWithStats,
  makeFootageMeta,
  parseRawWordsFile,
  type RawWordsFile,
} from "@/lib/repurpose/ingest";
import { ingestOverlayFiles } from "@/lib/repurpose/overlay-ingest";

/** Parse an SRT timestamp "HH:MM:SS,mmm" to seconds. */
function srtTimeToSec(t: string): number {
  const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

/** Parse raw .srt into per-word timings by spreading each block's time across
 * its words. Good enough for take-matching (block-level accuracy ~2-4s). */
function srtToWords(srt: string): { text: string; start: number; end: number }[] {
  const words: { text: string; start: number; end: number }[] = [];
  for (const block of srt.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [a, b] = tl.split("-->");
    const start = srtTimeToSec(a);
    const end = srtTimeToSec(b);
    const textLines = lines.slice(lines.indexOf(tl) + 1);
    const toks = textLines.join(" ").split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const per = (end - start) / toks.length;
    toks.forEach((w, i) =>
      words.push({ text: w, start: start + i * per, end: start + (i + 1) * per })
    );
  }
  return words;
}

/** Strip SRT indices + timestamps to plain narration text. */
function srtToText(srt: string): string {
  return srt
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.includes("-->") && !/^\d+$/.test(l.trim()))
        .join(" ")
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function SourcesPanel() {
  const clips = useRepurposeStore((s) => s.clips);
  const words = useRepurposeStore((s) => s.words);
  const footageMeta = useRepurposeStore((s) => s.footageMeta);
  const hydrating = useRepurposeStore((s) => s.hydrating);
  const setClips = useRepurposeStore((s) => s.setClips);
  const setWords = useRepurposeStore((s) => s.setWords);
  const setFootageMeta = useRepurposeStore((s) => s.setFootageMeta);
  const setEditStats = useRepurposeStore((s) => s.setEditStats);

  const [ingestError, setIngestError] = useState<string | null>(null);
  const rawWordsRef = useRef<RawWordsFile | null>(null);
  const finalTranscriptRef = useRef<string>("");

  // --- Rebuild clips from whatever raw words + final transcript we have -------
  const rebuild = useCallback(() => {
    const raw = rawWordsRef.current;
    if (!raw) return;
    try {
      // buildShortWithStats runs the ingest AND selectShort -> the timeline is
      // the finished ~30-60s Reel, not the full-length cut (falls back to the
      // full assembly only when there's no final transcript / no viable window),
      // and returns the auto-cut savings summary alongside the clips.
      const { clips: built, stats } = buildShortWithStats({
        rawWords: raw.words,
        finalTranscript: finalTranscriptRef.current || undefined,
      });
      setClips(built);
      setEditStats(stats);
      // Feed the raw word-level transcript to the store so captions can chunk it
      // into on-screen blocks (timed in SOURCE seconds, mapped to output at draw).
      setWords(raw.words);
      setIngestError(null);
    } catch (err) {
      setIngestError(err instanceof Error ? err.message : "Failed to build clips");
    }
  }, [setClips, setWords, setEditStats]);

  // --- Backfill words for captions on a restored project ---------------------
  // A project restored from a pre-captions snapshot has clips but no `words`, so
  // captions have nothing to chunk. The restore effect and this effect race on
  // mount, so we can't rely on reading `clips` once -- instead SUBSCRIBE to the
  // store and fire the moment we ever observe "a project is loaded but words are
  // empty". Fetches the raw words matching the restored demo footage and
  // setWords() them (which re-chunks caption blocks). One-shot via
  // backfilledRef, and guarded so a user's own transcript is never clobbered.
  const backfilledRef = useRef(false);
  useEffect(() => {
    let cancelled = false;

    const tryBackfill = () => {
      if (backfilledRef.current) return;
      const st = useRepurposeStore.getState();
      const projectLoaded = st.clips.length > 0 || !!st.footageMeta;
      if (!projectLoaded || st.words.length > 0) return; // nothing to fix (yet)
      backfilledRef.current = true;
      (async () => {
        try {
          const res = await fetch("/repurpose/claude-routines-words.json");
          if (!res.ok || cancelled) return;
          const parsed = parseRawWordsFile(await res.json());
          if (cancelled || useRepurposeStore.getState().words.length > 0) return;
          rawWordsRef.current = parsed;
          setWords(parsed.words); // setWords also rebuilds caption blocks
        } catch {
          /* assets absent -> captions stay empty until a manual transcript load */
        }
      })();
    };

    tryBackfill(); // in case the project is already present at mount
    const unsub = useRepurposeStore.subscribe(tryBackfill); // and when it lands later
    return () => {
      cancelled = true;
      unsub();
    };
  }, [setWords]);

  // --- Auto-load the staged demo footage on first mount ----------------------
  // The raw words + final transcript + a footage manifest (streaming URLs for
  // the two raw videos) are staged in public/repurpose/. On an EMPTY editor we
  // fetch all three and build the cut immediately, so opening the page shows
  // the finished short playing real footage -- no manual file-picking. Guarded
  // so it never clobbers a manually-loaded project or a session-restored one:
  // it only runs when there are no clips AND no footage yet. Runs once.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    // A saved project is loading from disk (useProjectPersistence set `hydrating`).
    // The store is briefly empty in that window, so DON'T latch or auto-load yet --
    // wait for hydration to finish (this effect re-runs when `hydrating` clears; if
    // the project had clips/footage the guard below then latches without loading).
    if (hydrating) return;
    // Don't fight a project that's already present (manual load, restored, or just
    // hydrated from disk).
    if (clips.length > 0 || footageMeta) {
      autoLoadedRef.current = true;
      return;
    }
    autoLoadedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const [wordsRes, finalRes, manifestRes] = await Promise.all([
          fetch("/repurpose/claude-routines-words.json"),
          fetch("/repurpose/final-transcript.txt"),
          fetch("/repurpose/footage-manifest.json"),
        ]);
        if (!wordsRes.ok || !finalRes.ok || !manifestRes.ok) return; // assets absent -> stay on manual ingest
        const rawWords = parseRawWordsFile(await wordsRes.json());
        const finalText = (await finalRes.text()).replace(/\s+/g, " ").trim();
        const manifest = (await manifestRes.json()) as Partial<FootageMeta>;
        if (cancelled) return;
        // Bail if the user started loading something while we were fetching.
        if (useRepurposeStore.getState().clips.length > 0) return;

        rawWordsRef.current = rawWords;
        finalTranscriptRef.current = finalText;
        // The short Reel (selectShort window), not the full 8-minute assembly,
        // plus the auto-cut savings summary for the transcript-rail readout.
        const { clips: built, stats } = buildShortWithStats({
          rawWords: rawWords.words,
          finalTranscript: finalText,
        });
        setClips(built);
        setEditStats(stats);
        // Feed the raw words to the store too, so captions can chunk them into
        // on-screen blocks (the manual rebuild path does this; the auto-load
        // path must as well or captions have nothing to draw).
        setWords(rawWords.words);
        // Manifest paths are already streaming URLs (/api/repurpose/video?...),
        // so set footageMeta directly rather than through makeFootageMeta.
        if (manifest.faceCamPath && manifest.screenPath) {
          setFootageMeta({
            faceCamPath: manifest.faceCamPath,
            screenPath: manifest.screenPath,
            fps: manifest.fps ?? 30,
            width: manifest.width ?? 1080,
            height: manifest.height ?? 1920,
            durationSec: manifest.durationSec ?? 0,
          });
        }
        setIngestError(null);
      } catch {
        // Network/parse failure -> silently fall back to manual ingest buttons.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-runs when `hydrating` flips (a disk load finishing), then latches via
    // autoLoadedRef; otherwise a one-shot on mount, guarded internally against
    // re-entry. Other store reads are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrating]);

  const handleWordsFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        // Accept EITHER a pre-parsed words.json OR a raw .srt (what Descript
        // exports). An .srt is parsed into per-word timings in-app so Manthan
        // never has to pre-convert -- he just drops the file Descript gave him.
        if (file.name.toLowerCase().endsWith(".srt")) {
          const parsed = srtToWords(text);
          rawWordsRef.current = {
            words: parsed,
            text: parsed.map((w) => w.text).join(" "),
          };
        } else {
          rawWordsRef.current = parseRawWordsFile(JSON.parse(text));
        }
        setIngestError(null);
        rebuild();
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : "Could not read that file"
        );
      }
    },
    [rebuild]
  );

  const handleFinalTranscriptFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      // Strip SRT block numbers + timestamps to plain narration text; a .txt
      // just collapses whitespace.
      finalTranscriptRef.current = file.name.toLowerCase().endsWith(".srt")
        ? srtToText(text)
        : text.replace(/\s+/g, " ").trim();
      rebuild();
    },
    [rebuild]
  );

  // --- Point the source videos at picked media (object URLs) -----------------
  const handleMediaFiles = useCallback(
    (which: "screen" | "face") => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const raw = rawWordsRef.current;
      const existing = footageMeta;
      const next = makeFootageMeta({
        faceCamPath: which === "face" ? url : existing?.faceCamPath ?? "",
        screenPath: which === "screen" ? url : existing?.screenPath ?? "",
        rawWords: raw?.words ?? [],
        fps: existing?.fps,
        width: existing?.width,
        height: existing?.height,
        durationSec: existing?.durationSec,
      });
      setFootageMeta(next);
    },
    [footageMeta, setFootageMeta]
  );

  // --- Add a free-floating overlay (image/video) at the current playhead ------
  // Runs the SAME shared ingest as drag-drop + paste: copy-to-disk, then
  // addOverlay. Placed at the playhead so it lands where the user is scrubbed.
  const handleAddMedia = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const atTime = useRepurposeStore.getState().playhead;
      // Reset the input BEFORE the await so re-picking the same file re-fires.
      const input = e.target;
      await ingestOverlayFiles(files, atTime);
      input.value = "";
    },
    []
  );

  // Footage is "ready" once we have both real footage AND a transcript to edit.
  const footageReady = footageMeta != null && words.length > 0;

  // The four ingest controls -- shared between the prominent open state and the
  // collapsed "Re-import footage" fold.
  const buttons = (
    <div className="flex flex-col gap-2">
      <IngestButton
        label="Load raw transcript (.srt / .json)"
        accept=".srt,.json,.txt,application/json,text/plain"
        onChange={handleWordsFile}
      />
      <IngestButton
        label="Load final transcript (.srt)"
        accept=".srt,.txt,text/plain"
        onChange={handleFinalTranscriptFile}
      />
      <div className="flex gap-2">
        <IngestButton compact label="Screen" accept="video/*" onChange={handleMediaFiles("screen")} />
        <IngestButton compact label="Face" accept="video/*" onChange={handleMediaFiles("face")} />
      </div>
      {/* Add a free-floating overlay (image/video) at the playhead. Coral so it
          reads as the "add a layer" action, distinct from the source ingests. */}
      <AddMediaButton onChange={handleAddMedia} />
      {ingestError && (
        <div className="flex items-start gap-1.5 rounded-md border border-[#FF6B35]/40 bg-[#FF6B35]/10 px-2 py-1.5 text-[11px] text-[#FF8F6B]">
          <Warning size={13} weight="fill" className="mt-px shrink-0" />
          <span>{ingestError}</span>
        </div>
      )}
    </div>
  );

  // Collapsed: footage is loaded, so tuck the ingest behind a small fold and
  // give the grading controls below the room.
  if (footageReady) {
    return (
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground/80">
          <FilmSlate size={13} weight="bold" className="shrink-0" />
          Re-import footage
        </summary>
        <div className="mt-3">{buttons}</div>
      </details>
    );
  }

  // Prominent: no footage yet -- this is the first thing to do on an empty editor.
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <FilmSlate size={13} weight="bold" className="shrink-0" />
        Sources
      </h3>
      {buttons}
    </div>
  );
}

/**
 * The "Add media" action -- picks one or more image/video files and drops each
 * as a free-floating overlay at the current playhead (multiple = multi-select).
 * Coral-accented so it reads as "add a layer", distinct from the source ingests.
 */
function AddMediaButton({
  onChange,
}: {
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className="flex items-center justify-center gap-1.5 rounded-md border border-[#FF6B35]/50 bg-[#FF6B35]/10 px-3 py-2 text-xs font-medium text-[#FF8F6B] transition-colors hover:bg-[#FF6B35]/20"
    >
      <ImageSquare size={14} weight="bold" />
      Add media (image / video)
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={onChange}
        className="hidden"
      />
    </button>
  );
}

function IngestButton({
  label,
  accept,
  onChange,
  compact,
}: {
  label: string;
  accept: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      className={`flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary text-xs font-medium text-foreground transition-colors hover:bg-secondary/70 ${
        compact ? "flex-1 px-2 py-1.5" : "px-3 py-2"
      }`}
    >
      <UploadSimple size={13} weight="bold" />
      {label}
      <input ref={inputRef} type="file" accept={accept} onChange={onChange} className="hidden" />
    </button>
  );
}
