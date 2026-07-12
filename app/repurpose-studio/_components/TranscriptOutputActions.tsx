"use client";

// ===========================================================================
// REPURPOSE STUDIO -- TranscriptOutputActions
// ===========================================================================
// The two output buttons that read the short back OUT of the editor: Copy (as
// timestamped text) and .srt (download captions). They used to sit in the
// WordTranscript rail header, but four buttons overflowed the narrow rail, so
// these two lifted UP into the "Transcript" title bar (TranscriptPanel) where
// there is idle horizontal space. Icon-only + tooltip so they never crowd the
// heading. Self-contained: everything comes straight from the store, so this
// mounts anywhere without prop threading.
// ===========================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CopySimple, DownloadSimple } from "@phosphor-icons/react";
import { useRepurposeStore } from "@/lib/repurpose/store";
import {
  buildOverrideByStartMs,
  buildTranscriptSegments,
  segmentsToSrt,
  segmentsToTimestampedText,
} from "@/lib/repurpose/transcript-export";

export function TranscriptOutputActions() {
  const words = useRepurposeStore((s) => s.words);
  const clips = useRepurposeStore((s) => s.clips);
  const deletedWordIndices = useRepurposeStore((s) => s.deletedWordIndices);
  const captionBlocks = useRepurposeStore((s) => s.captionBlocks);

  const deletedSet = useMemo(
    () => new Set(deletedWordIndices),
    [deletedWordIndices]
  );

  // Source-start-time (ms) -> shown caption text, ONLY where it differs from
  // the raw word (a real textOverride) -- so the copied/exported text carries
  // the user's inline edits. Shared builder with WordTranscript's edited-word
  // underline (transcript-export) so the key scheme can never drift.
  const overrideByStartMs = useMemo(
    () => buildOverrideByStartMs(captionBlocks),
    [captionBlocks]
  );

  const [copied, setCopied] = useState(false);
  // SR-only live-region message ("Transcript copied" / "SRT downloaded") --
  // preserves the announcements these actions made in their old WordTranscript
  // home, where a shared live region existed.
  const [announce, setAnnounce] = useState("");
  const copiedTimeoutRef = useRef<number | null>(null);

  const onCopyTranscript = useCallback(async () => {
    const segments = buildTranscriptSegments(
      words,
      clips,
      deletedSet,
      overrideByStartMs
    );
    if (segments.length === 0) return;
    try {
      await navigator.clipboard.writeText(segmentsToTimestampedText(segments));
    } catch {
      // Clipboard writes reject when the document isn't focused (click away,
      // Cmd+Tab back) -- surface it instead of silently doing nothing.
      setAnnounce("Copy failed -- click the page and try again");
      return;
    }
    setCopied(true);
    setAnnounce("Transcript copied with timestamps");
    // Restart (not stack) the reset timer on rapid re-clicks.
    if (copiedTimeoutRef.current != null) window.clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 1800);
  }, [words, clips, deletedSet, overrideByStartMs]);

  const onDownloadSrt = useCallback(() => {
    const segments = buildTranscriptSegments(
      words,
      clips,
      deletedSet,
      overrideByStartMs
    );
    if (segments.length === 0) return;
    // Trailing newline: some subtitle parsers want the final block terminated.
    const blob = new Blob([segmentsToSrt(segments) + "\n"], {
      type: "text/srt;charset=utf-8",
    });
    const slug =
      window.location.pathname.split("/").filter(Boolean).pop() ?? "short";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}-transcript.srt`;
    a.click();
    URL.revokeObjectURL(a.href);
    setAnnounce("SRT downloaded");
  }, [words, clips, deletedSet, overrideByStartMs]);

  // Auto-clear the live-region message so a stale announcement never lingers;
  // clear the copied-reset timer on unmount so it never fires into a dead tree.
  useEffect(() => {
    if (!announce) return;
    const t = window.setTimeout(() => setAnnounce(""), 2500);
    return () => window.clearTimeout(t);
  }, [announce]);
  useEffect(
    () => () => {
      if (copiedTimeoutRef.current != null) window.clearTimeout(copiedTimeoutRef.current);
    },
    []
  );

  const disabled = words.length === 0;
  const btn =
    "inline-flex h-7 w-7 items-center justify-center rounded-md border border-border " +
    "text-muted-foreground transition-colors motion-reduce:transition-none " +
    "hover:bg-accent hover:text-foreground focus-visible:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-[#FF6B35] " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={onCopyTranscript}
        disabled={disabled}
        aria-label="Copy transcript with timestamps"
        title="Copy the short's transcript with [m:ss] timestamps"
        className={btn}
      >
        {copied ? (
          <Check size={15} weight="bold" className="text-[#00d4aa]" aria-hidden="true" />
        ) : (
          <CopySimple size={15} weight="bold" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={onDownloadSrt}
        disabled={disabled}
        aria-label="Download captions as .srt"
        title="Download the short's captions as an .srt file"
        className={btn}
      >
        <DownloadSimple size={15} weight="bold" aria-hidden="true" />
      </button>
      {/* SR-only live region: announces copy/download without stealing focus. */}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}
