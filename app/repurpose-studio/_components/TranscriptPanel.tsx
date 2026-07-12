"use client";

// ===========================================================================
// REPURPOSE STUDIO -- TranscriptPanel
// ===========================================================================
// The left rail: the editable word-level transcript that reads like the
// finished short. Footage/transcript INGEST used to live here too, but it moved
// to SourcesPanel (in the Inspector) so this rail is purely the editing
// surface. What stays:
//   - The rail chrome + "Transcript" header.
//   - The auto-cut SavingsSummary (the tool's payoff, kept visible here).
//   - <WordTranscript/> -- click a word to seek, select + Delete to cut, click
//     a removed word to restore, double-click to edit caption text.
//
// LOAD-BEARING: the container keeps id="transcript-panel". WordTranscript's
// focus-scoped keyboard guard (Timeline.tsx yields keydown when it originates
// inside #transcript-panel) relies on that id being here.
// ===========================================================================

import { Scissors, SpeakerSimpleSlash, Timer } from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import type { EditStats } from "@/lib/repurpose/ingest";
import { WordTranscript } from "./WordTranscript";
import { TranscriptOutputActions } from "./TranscriptOutputActions";

export function TranscriptPanel() {
  const editStats = useRepurposeStore((s) => s.editStats);
  const words = useRepurposeStore((s) => s.words);

  return (
    <div
      id="transcript-panel"
      className="flex h-full flex-col border-r border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Transcript
        </h2>
        {/* Output actions (Copy / .srt) live here, not in the rail below, so the
            narrow rail never overflows. Shown only when a transcript is loaded. */}
        {words.length > 0 && <TranscriptOutputActions />}
      </div>

      {/* Auto-cut savings summary -- the tool's payoff, made visible. */}
      {editStats && <SavingsSummary stats={editStats} />}

      {/* Editable word transcript -- reads like the finished short, click to
          seek, select + Delete to cut, click a removed word to restore,
          double-click to edit caption text. Owns its own empty-state hint
          (words.length === 0) + full-recording fold. */}
      <div className="min-h-0 flex-1">
        {words.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Load your raw .srt (the one Descript exported, with all the retakes)
            from the Sources panel in the Inspector to detect takes and build the
            timeline.
          </div>
        ) : (
          <WordTranscript />
        )}
      </div>
    </div>
  );
}

/**
 * Auto-cut savings card -- the product payoff, surfaced. Shows the headline
 * "X.Xs saved" (raw window minus assembled runtime) plus the breakdown of what
 * the tool removed: retakes and trimmed silences. Numbers come straight from the
 * ingest (store.editStats), computed over the same clips on the timeline.
 */
function SavingsSummary({ stats }: { stats: EditStats }) {
  const savedLabel = `${stats.secondsSaved.toFixed(1)}s`;
  return (
    <div className="mx-4 my-3 rounded-lg border border-[#FF6B35]/30 bg-[#FF6B35]/[0.07] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[#FF8F6B]">
          Auto-cut
        </span>
        <span className="flex items-baseline gap-1 tabular-nums">
          <Timer size={13} weight="fill" className="translate-y-px text-[#FF6B35]" />
          <span className="text-sm font-semibold text-[#FF6B35]">{savedLabel}</span>
          <span className="text-[10px] text-muted-foreground">saved</span>
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1 tabular-nums">
          <Scissors size={12} weight="bold" className="text-[#FF8F6B]" />
          <span className="font-medium text-foreground">{stats.retakesRemoved}</span>
          {stats.retakesRemoved === 1 ? "retake" : "retakes"}
        </span>
        <span className="flex items-center gap-1 tabular-nums">
          <SpeakerSimpleSlash size={12} weight="bold" className="text-[#FF8F6B]" />
          <span className="font-medium text-foreground">{stats.silencesTrimmed}</span>
          {stats.silencesTrimmed === 1 ? "silence" : "silences"}
        </span>
      </div>
    </div>
  );
}
