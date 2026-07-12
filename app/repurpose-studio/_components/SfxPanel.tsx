"use client";

// ===========================================================================
// SfxPanel -- the "Sound Effects" generator (Inspector rail)
// ===========================================================================
// One button that, ON CLICK ONLY, generates a sound-effects track for the
// current reel and auto-loads it onto the timeline's Audio row (a green block
// below the clips). The intelligence (which sound on which beat) is computed in
// the browser by `planSfxEvents` against the reel's OUTPUT-time transcript, then
// POSTed to /api/repurpose/sfx, which runs the existing Python SFX engine and
// returns a playable WAV. The track is baked into BOTH the live preview and the
// exported MP4 (see useSfxPreview + export-short).
//
// Re-clicking regenerates against the current edits (replacing the track). A
// gain slider pulls the whole SFX bed up/down under the VO without re-rendering.
// ===========================================================================

import { useCallback, useState } from "react";
import { MusicNotes, Waveform, ArrowClockwise, Trash, Warning } from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import { planSfxEvents } from "@/lib/repurpose/sfx-placement";

export function SfxPanel() {
  const sfxTrack = useRepurposeStore((s) => s.sfxTrack);
  const sfxGenerating = useRepurposeStore((s) => s.sfxGenerating);
  const setSfxTrack = useRepurposeStore((s) => s.setSfxTrack);
  const setSfxGenerating = useRepurposeStore((s) => s.setSfxGenerating);
  const clearSfxTrack = useRepurposeStore((s) => s.clearSfxTrack);
  const setSfxGain = useRepurposeStore((s) => s.setSfxGain);

  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    const state = useRepurposeStore.getState();
    const { words, clips, duration } = state;
    if (duration <= 0 || words.length === 0 || sfxGenerating) return;

    setError(null);
    setSfxGenerating(true);
    try {
      // 1. Plan placements from the reel's OUTPUT-time transcript (in-browser).
      const events = planSfxEvents(words, clips, duration);
      if (events.length === 0) {
        setError("No sound-effect beats found in this reel.");
        return;
      }
      // 2. Render the WAV via the local engine route.
      const res = await fetch("/api/repurpose/sfx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, durationMs: Math.round(duration * 1000) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `SFX render failed (${res.status})`);
      }
      const data = (await res.json()) as { path: string; url: string };
      // 3. Auto-load onto the Audio row (preview + export read this).
      setSfxTrack({
        src: data.url,
        sourcePath: data.path,
        durationSec: duration,
        gain: sfxTrack?.gain ?? 1,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "SFX generation failed.");
    } finally {
      setSfxGenerating(false);
    }
  }, [sfxGenerating, sfxTrack, setSfxGenerating, setSfxTrack]);

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-1.5">
        <MusicNotes size={14} weight="bold" className="text-emerald-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sound Effects
        </h3>
      </div>

      {!sfxTrack ? (
        <>
          <button
            type="button"
            onClick={generate}
            disabled={sfxGenerating}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-default disabled:opacity-60"
          >
            {sfxGenerating ? (
              <>
                <Waveform size={15} weight="bold" className="animate-pulse" />
                Generating&hellip;
              </>
            ) : (
              <>
                <Waveform size={15} weight="bold" />
                Generate SFX track
              </>
            )}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Auto-maps digital readouts, whooshes on cuts, and contextual hits to
            the reel, then drops a green track on the timeline. Plays in the
            preview and bakes into the MP4.
          </p>
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-200">
            <Waveform size={14} weight="bold" className="shrink-0 text-emerald-400" />
            <span className="flex-1 truncate">SFX track loaded ({Math.round(sfxTrack.durationSec)}s)</span>
          </div>

          {/* Whole-bed gain (0-200%, 100% = as rendered). Live, no re-render. */}
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>SFX volume</span>
              <span className="tabular-nums text-emerald-300">
                {Math.round(sfxTrack.gain * 100)}%
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={sfxTrack.gain}
              onChange={(e) => setSfxGain(Number(e.target.value))}
              className="w-full accent-emerald-400"
              aria-label="SFX track volume"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={generate}
              disabled={sfxGenerating}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-60"
              title="Re-generate against the current edits"
            >
              <ArrowClockwise size={13} weight="bold" className={sfxGenerating ? "animate-spin" : ""} />
              {sfxGenerating ? "Generating…" : "Regenerate"}
            </button>
            <button
              type="button"
              onClick={() => clearSfxTrack()}
              className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-300"
              title="Remove the SFX track"
              aria-label="Remove SFX track"
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
